/**
 * 大纲检索式上下文（Outline Retrieval Context）
 *
 * 背景：旧实现把「已确认大纲前缀」全文拼进每一次请求。前缀随章数线性增长，
 * 到 300 章时单次输入已约 27 万 token，输出额度被挤空，生成必然失败。
 *
 * 本模块把「用于合并校验的全文」与「注入模型的上下文」分开：
 * - 合并、校验仍使用完整前缀（本地计算，无 token 成本）；
 * - 注入模型的上下文由本模块构造，恒定为有界大小。
 *
 * 压缩策略（对数式滚卷，上界恒定）：
 * 1. 最近 N 章保留全文，保证即时连贯；
 * 2. 更早章节各压成一行摘要（章号区间 + 标题 + 首句）；
 * 3. 摘要行数超上限时，把最旧的两条相邻摘要合并成一条更粗的区间摘要，
 *    反复直到回到上限内 —— 越久远越粗，但骨架永不丢失；
 * 4. 提供人物名单时，附加「人物索引」（首次登场 / 最近出现章节）。
 *
 * 纯函数、无副作用、不依赖数据库，因此无需 schema 迁移，对既有项目数据零影响。
 */

import type { WritingLanguage } from './writing-language'

export interface OutlineChapterEntry {
  chapter: number
  title: string
  body: string
}

export interface OutlineDigestBlock {
  from: number
  to: number
  title: string
  brief: string
}

export interface OutlineCharacterRelation {
  source: string
  target: string
  relation: string
}

export interface OutlineRetrievalOptions {
  writingLanguage?: WritingLanguage
  budgetChars?: number
  recentFullChapters?: number
  maxDigestBlocks?: number
  characterNames?: readonly string[]
  characterRelations?: readonly OutlineCharacterRelation[]
  maxCharacterEntries?: number
  maxRelationEntries?: number
}

export interface OutlineRetrievalStats {
  totalChapters: number
  fullChapters: number
  digestBlocks: number
  coveredByDigest: number
  usedChars: number
  budgetChars: number
  compacted: boolean
}

export interface OutlineRetrievalResult {
  text: string
  stats: OutlineRetrievalStats
}

export const DEFAULT_OUTLINE_CONTEXT_BUDGET = 9000
export const DEFAULT_RECENT_FULL_CHAPTERS = 6
export const DEFAULT_MAX_DIGEST_BLOCKS = 48
const DEFAULT_MAX_CHARACTER_ENTRIES = 60
const DEFAULT_MAX_RELATION_ENTRIES = 36
const DIGEST_BRIEF_CHARS = 60
const MERGED_BRIEF_CHARS = 80

const CHAPTER_HEADING = /^#{1,4}[ \t]*(?:第[ \t]*(\d+)[ \t]*章|Chapter[ \t]+(\d+))[ \t]*[:：]?[ \t]*(.*)$/iu
const PROGRESS_TAIL = /^>[ \t]*本大纲已覆盖至|^>[ \t]*This outline covers/u

function firstSentence(text: string, limit: number): string {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  if (!normalized) return ''
  const match = normalized.match(/^[^。！？!?]*[。！？!?]/u)
  const sentence = (match ? match[0] : normalized).trim()
  return sentence.length <= limit ? sentence : sentence.slice(0, limit) + '…'
}

/** 把大纲正文解析成章节条目；无法识别的行并入当前章正文。 */
export function parseOutlineChapters(body: string): OutlineChapterEntry[] {
  const lines = body.split(/\r?\n/)
  const entries: OutlineChapterEntry[] = []
  let current: OutlineChapterEntry | null = null
  for (const line of lines) {
    if (PROGRESS_TAIL.test(line.trim())) continue
    const match = CHAPTER_HEADING.exec(line.trim())
    if (match) {
      if (current) entries.push(current)
      current = { chapter: Number(match[1] ?? match[2]), title: (match[3] ?? '').trim(), body: '' }
      continue
    }
    if (current) current.body += line + '\n'
  }
  if (current) entries.push(current)
  const seen = new Set<number>()
  return entries.filter(entry => (seen.has(entry.chapter) ? false : (seen.add(entry.chapter), true)))
}

/** 从角色名单正文粗提人物名；提取不到返回空数组，不影响主流程。 */
export function extractCharacterNames(charactersArch: string, limit: number = DEFAULT_MAX_CHARACTER_ENTRIES): string[] {
  const names = new Set<string>()
  const blocked = /^(角色|主角|配角|反派|龙套|姓名|身份|性格|外貌|背景|能力|动机|弧光|其他事实|当前状态|关系)$/u
  const patterns = [
    /^#{1,4}[ \t]*([^\n：:]{1,20})[：:]([^\n]{0,20})/gmu,
    /^[-*][ \t]*姓名[：:][ \t]*([^\n，,（(]{1,20})/gmu,
    /^[-*][ \t]*([^\n：:（(]{1,12})[：:]/gmu,
  ]
  for (const pattern of patterns) {
    for (const match of charactersArch.matchAll(pattern)) {
      const raw = (match[2] ?? match[1] ?? '').trim()
      const name = (raw.split(/[，,、；;（(]/u)[0] ?? '').trim()
      if (name && name.length >= 2 && name.length <= 12 && !blocked.test(name)) {
        names.add(name)
        if (names.size >= limit) return [...names]
      }
    }
  }
  return [...names]
}

function mergeOldestBlocks(blocks: OutlineDigestBlock[]): void {
  const first = blocks[0]
  const second = blocks[1]
  if (!first || !second) return
  const title = first.title === second.title ? first.title : (first.title + ' / ' + second.title).slice(0, 40)
  const brief = (first.brief + (first.brief && second.brief ? ' ' : '') + second.brief).slice(0, MERGED_BRIEF_CHARS)
  blocks.splice(0, 2, { from: first.from, to: second.to, title, brief })
}

/** 对数式滚卷：把摘要块数量压回上限，越旧越粗。 */
export function rollupDigestBlocks(blocks: readonly OutlineDigestBlock[], maxBlocks: number): OutlineDigestBlock[] {
  const result = [...blocks]
  while (result.length > maxBlocks && result.length >= 2) mergeOldestBlocks(result)
  return result
}

function latestSharedChapter(entries: readonly OutlineChapterEntry[], source: string, target: string): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    const text = entry.title + '\n' + entry.body
    if (text.includes(source) && text.includes(target)) return entry.chapter
  }
  return -1
}

function buildRelationIndex(
  entries: readonly OutlineChapterEntry[],
  relations: readonly OutlineCharacterRelation[],
  names: readonly string[],
  maxEntries: number,
  language: WritingLanguage,
): string {
  if (relations.length === 0) return ''
  const known = new Set(names)
  const seen = new Set<string>()
  const lines: string[] = []
  for (const relation of relations) {
    const source = relation.source.trim()
    const target = relation.target.trim()
    const description = relation.relation.replace(/\s+/gu, ' ').trim()
    if (!source || !target || source === target || !description) continue
    if (known.size > 0 && (!known.has(source) || !known.has(target))) continue
    const key = source + '\u0001' + target
    if (seen.has(key)) continue
    seen.add(key)
    const chapter = latestSharedChapter(entries, source, target)
    lines.push(language === 'en-US'
      ? ('- ' + source + ' -> ' + target + ': ' + description + (chapter > 0 ? ' (latest together: ch. ' + chapter + ')' : ''))
      : ('- ' + source + ' → ' + target + '：' + description + (chapter > 0 ? '（最近共同出场：第 ' + chapter + ' 章）' : '')))
    if (lines.length >= maxEntries) break
  }
  if (lines.length === 0) return ''
  return language === 'en-US'
    ? ('[Key character relationships]\n' + lines.join('\n'))
    : ('【关键人物关系】\n' + lines.join('\n'))
}

function buildCharacterIndex(entries: readonly OutlineChapterEntry[], names: readonly string[], maxEntries: number, language: WritingLanguage): string {
  if (names.length === 0 || entries.length === 0) return ''
  const lines: string[] = []
  for (const name of names) {
    let first = -1
    let last = -1
    for (const entry of entries) {
      if (entry.body.includes(name) || entry.title.includes(name)) {
        if (first < 0) first = entry.chapter
        last = entry.chapter
      }
    }
    if (first > 0) lines.push(language === 'en-US' ? ('- ' + name + ': ch. ' + first + ' -> ' + last) : ('- ' + name + '：第 ' + first + ' 章 → 第 ' + last + ' 章'))
    if (lines.length >= maxEntries) break
  }
  if (lines.length === 0) return ''
  return language === 'en-US'
    ? ('[Character index (first -> latest appearance)]\n' + lines.join('\n'))
    : ('【人物索引（首次 → 最近出现）】\n' + lines.join('\n'))
}

/**
 * 构造注入模型的检索式上下文。返回文本不超过 budgetChars（软上限，
 * 最近章节全文优先保留）。全文在预算内时原样返回，不做损失性压缩。
 */
export function buildOutlineRetrievalContext(body: string, options: OutlineRetrievalOptions = {}): OutlineRetrievalResult {
  const language: WritingLanguage = options.writingLanguage ?? 'zh-CN'
  const budgetChars = Math.max(1200, Math.floor(options.budgetChars ?? DEFAULT_OUTLINE_CONTEXT_BUDGET))
  const recentFull = Math.max(0, Math.floor(options.recentFullChapters ?? DEFAULT_RECENT_FULL_CHAPTERS))
  const maxDigestBlocks = Math.max(2, Math.floor(options.maxDigestBlocks ?? DEFAULT_MAX_DIGEST_BLOCKS))
  const maxCharacterEntries = Math.max(0, Math.floor(options.maxCharacterEntries ?? DEFAULT_MAX_CHARACTER_ENTRIES))
  const maxRelationEntries = Math.max(0, Math.floor(options.maxRelationEntries ?? DEFAULT_MAX_RELATION_ENTRIES))

  const entries = parseOutlineChapters(body)
  const trimmedBody = body.trim()
  const result = (text: string, overrides: Partial<OutlineRetrievalStats> = {}): OutlineRetrievalResult => ({
    text,
    stats: {
      totalChapters: entries.length,
      fullChapters: entries.length,
      digestBlocks: 0,
      coveredByDigest: 0,
      usedChars: text.length,
      budgetChars,
      compacted: false,
      ...overrides,
    },
  })

  if (entries.length === 0) {
    return result(trimmedBody.length <= budgetChars ? trimmedBody : trimmedBody.slice(0, budgetChars) + '\n…')
  }
  if (trimmedBody.length <= budgetChars) return result(trimmedBody)

  const firstChapter = entries[0]!.chapter
  const lastChapter = entries[entries.length - 1]!.chapter
  const header = language === 'en-US'
    ? ('[Confirmed outline context · chapters ' + firstChapter + '-' + lastChapter + ' · ' + entries.length + ' chapters]\nEarlier chapters are compressed into range digests; the most recent chapters are given in full. Do not repeat, rewrite, or restate any of this context; continue from the next chapter.\n')
    : ('【已确认大纲上下文 · 第 ' + firstChapter + '–' + lastChapter + ' 章 · 共 ' + entries.length + ' 章】\n较早章节已压缩为区间摘要，最近章节给出全文。不要重复、改写或复述以下内容，直接从下一章续写。\n')

  let fullCount = Math.min(recentFull, entries.length)
  const recentEntries = (): OutlineChapterEntry[] => entries.slice(entries.length - fullCount)

  const digestSection = (blocks: readonly OutlineDigestBlock[]): string => blocks.length === 0 ? '' : (language === 'en-US'
    ? ('\n[Earlier chapters · range digests]\n' + blocks.map(b => '- ch. ' + b.from + (b.to > b.from ? '-' + b.to : '') + ': ' + b.title + (b.brief ? ' — ' + b.brief : '')).join('\n') + '\n')
    : ('\n【较早章节 · 区间摘要】\n' + blocks.map(b => '- 第 ' + b.from + (b.to > b.from ? '–' + b.to : '') + ' 章：' + b.title + (b.brief ? ' — ' + b.brief : '')).join('\n') + '\n'))

  const recentSection = (list: readonly OutlineChapterEntry[]): string => list.length === 0 ? '' : (language === 'en-US'
    ? ('\n[Recent chapters · full text]\n' + list.map(e => '## Chapter ' + e.chapter + ': ' + e.title + '\n' + e.body.trim()).join('\n\n') + '\n')
    : ('\n【最近章节 · 全文】\n' + list.map(e => '## 第' + e.chapter + '章：' + e.title + '\n' + e.body.trim()).join('\n\n') + '\n'))

  while (fullCount > 0 && (header.length + recentSection(recentEntries()).length) > budgetChars * 0.8) fullCount -= 1

  const olderEntries = entries.slice(0, entries.length - fullCount)
  const baseBlocks: OutlineDigestBlock[] = olderEntries.map(entry => ({
    from: entry.chapter,
    to: entry.chapter,
    title: entry.title || (language === 'en-US' ? 'Untitled' : '未命名'),
    brief: firstSentence(entry.body, DIGEST_BRIEF_CHARS),
  }))
  const blocks = rollupDigestBlocks(baseBlocks, maxDigestBlocks)

  const recentText = recentSection(recentEntries())
  const kept: OutlineDigestBlock[] = []
  let used = header.length + recentText.length
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const candidate = blocks[i]!
    const lineLength = digestSection([candidate]).length
    if (used + lineLength > budgetChars) break
    kept.unshift(candidate)
    used += lineLength
  }

  const characterNames = options.characterNames ?? []
  const characterIndex = buildCharacterIndex(entries, characterNames, maxCharacterEntries, language)
  const relationIndex = buildRelationIndex(entries, options.characterRelations ?? [], characterNames, maxRelationEntries, language)
  const withDigest = header + digestSection(kept) + recentText
  const indexes = [characterIndex, relationIndex].filter(Boolean).join('\n\n')
  const text = (indexes && withDigest.length + indexes.length + 2 <= budgetChars * 1.2)
    ? withDigest + '\n' + indexes
    : withDigest

  const coveredByDigest = kept.reduce((sum: number, block) => sum + (block.to - block.from + 1), 0)
  return {
    text,
    stats: {
      totalChapters: entries.length,
      fullChapters: fullCount,
      digestBlocks: kept.length,
      coveredByDigest,
      usedChars: text.length,
      budgetChars,
      compacted: true,
    },
  }
}
