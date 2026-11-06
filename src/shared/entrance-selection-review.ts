import type { ConsistencyFinding } from './consistency-preflight'

/**
 * 登场段的**挑选**由模型判断（issue #163 第八批，用户 2026-11-05/06 定规）。
 *
 * ## 为什么旧词表要下线
 *
 * 旧 `entrance-shot.ts` 用两张表挑「实体登场段」：`ENTRANCE_ACTION`（站/走/蹲…）与
 * `ENTRANCE_DRESS`（56 条本书服饰/随身物——靛蓝短褂、公文包、竹尺…）。
 * 「有主的物」换本书即瞎（「和服」「工装裤」「助听器」全部静默），且「提着菜篮」
 * 这样的随身物与「手里的缆绳」这类动作道具混在一格——本质都是「这段是不是
 * 该角色的实体登场」这个**内容判断**。
 *
 * ## 分工
 *
 * | 步骤 | 谁做 |
 * |---|---|
 * | 抽「含该角色名的候选段」（每章 ≤3 段，**结构**：名字出现即候选） | **规则** |
 * | 「哪一段是实体登场」 | **模型** |
 * | 候选段缓存与跨章同构比对（`entrance-shot.ts` 保留的比对逻辑） | **规则** |
 * | 采纳 | **作者** |
 */

export interface EntranceCandidateChapter {
  chapterNumber: number
  content: string
}

export interface EntranceSelectionIssue {
  chapterNumber: number
  character: string
  /** 模型选定的登场段（必须能在该章正文里逐字找到）。 */
  quote: string
  explanation: string
}

export interface EntranceSelectionRequest {
  /** 每个元素：一个角色的名字 + 全部章（候选段由此抽取）。 */
  character: string
  chapters: readonly EntranceCandidateChapter[]
  /** 每章最多送多少个候选段（控 token；超出按**段落出现角色的首次顺序**截断）。 */
  maxCandidatesPerChapter?: number
  language: 'zh-CN' | 'en-US'
  recentChapters?: number
}

export const ENTRANCE_SELECTION_MAX_PER_CHAPTER = 3
export const ENTRANCE_SELECTION_RECENT_CHAPTERS = 16

/** 抽「含该角色名的候选段」——纯结构：名字出现即候选，不作任何内容判断。 */
export function entranceCandidateParagraphs(
  content: string,
  character: string,
  maxCandidates = ENTRANCE_SELECTION_MAX_PER_CHAPTER,
): Array<{ index: number; text: string }> {
  const paragraphs = String(content ?? '')
    .split(/\n\s*\n/u)
    .map(block => block.trim())
    .filter(Boolean)
  const candidates: Array<{ index: number; text: string }> = []
  for (const [index, paragraph] of paragraphs.entries()) {
    if (paragraph.includes(character)) candidates.push({ index: index + 1, text: paragraph })
    if (candidates.length >= maxCandidates) break
  }
  return candidates
}

export function buildEntranceSelectionPrompt(request: EntranceSelectionRequest): { system: string, user: string } {
  const en = request.language === 'en-US'
  const limit = request.recentChapters ?? ENTRANCE_SELECTION_RECENT_CHAPTERS
  const chapters = [...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)

  const system = en
    ? [
      'You are given chapters of a novel and the candidates for one character: paragraphs that mention this character.',
      'For each chapter, pick the ONE paragraph that is the character\'s PHYSICAL ENTRANCE in that chapter — the paragraph where the character is bodily present doing something (standing, walking, sitting, arriving, working), usually with what they wear or carry.',
      'Do NOT pick: paragraphs where the character is only remembered, quoted by others, named in dialogue, mentioned in a file, or merely talked about — those are not a physical entrance.',
      'If a chapter has no physical entrance for this character, return an empty paragraph for it (empty string).',
      'Judge by meaning, not by a fixed word list: entrances may be phrased as arrivals, actions at a post, or being seen at work.',
      'Output one JSON object: {"selections":[{"chapterNumber":<n>,"paragraph":"<the chosen paragraph, verbatim>"}]}.',
      'Every paragraph must be copied verbatim from that chapter\'s candidates. If unsure which paragraph is the entrance, choose the one with the most physical detail.',
    ].join('\n')
    : [
      '下面是一部小说的章节正文，以及**一个角色**的候选段：提到这个角色的段落。',
      '对每一章，挑出该角色**实体登场**的那一段——他本人身体在场的段落（站着、走进、坐下、干活），通常带衣着或随身物。',
      '不要挑：只被回忆、被他人转述、在台词里被点名、在档案/记录里出现的段——那不是实体登场。',
      '某一章确实没有实体登场时，该章返回空字符串。',
      '按**意思**判断，不要按固定词表：登场可以写成到场、到岗干活、被看见在做事。',
      '输出一个 JSON 对象：{"selections":[{"chapterNumber":<章号>,"paragraph":"<选中的那段原文>"}]}。',
      '每段都必须**逐字复制**该章候选段里的原文。拿不准哪一段是登场时，选身体细节最多的那段。',
    ].join('\n')

  const candidateText = chapters.map(chapter => {
    const candidates = entranceCandidateParagraphs(chapter.content, request.character, request.maxCandidatesPerChapter)
    if (candidates.length === 0) return null
    const body = candidates.map(candidate => `（段${candidate.index}）${candidate.text}`).join('\n')
    return en ? `### Chapter ${chapter.chapterNumber}\n${body}` : `### 第${chapter.chapterNumber}章\n${body}`
  }).filter(Boolean).join('\n\n')

  const user = en
    ? [`## Character`, request.character, `## Candidate paragraphs`, candidateText].join('\n\n')
    : [`## 角色`, request.character, `## 候选段`, candidateText].join('\n\n')
  return { system, user }
}

function stripFence(value: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(value)
  return fenced ? fenced[1]! : value
}

/**
 * 解析并校验模型输出（规则侧）：
 * 章号必须在送进去的范围里；选中的段必须能在**该章的候选段里逐字定位**（防止模型改写原文）。
 */
export function parseEntranceSelection(
  raw: string,
  request: Pick<EntranceSelectionRequest, 'character' | 'chapters' | 'maxCandidatesPerChapter' | 'recentChapters'>,
): Array<{ chapterNumber: number; paragraph: string; index: number }> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFence(String(raw ?? '').trim()))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const list = (parsed as { selections?: unknown }).selections
  if (!Array.isArray(list)) return null
  const limit = request.recentChapters ?? ENTRANCE_SELECTION_RECENT_CHAPTERS
  const chapters = [...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)
  const result: Array<{ chapterNumber: number; paragraph: string; index: number }> = []
  const seen = new Set<number>()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const chapterNumber = Number(record.chapterNumber)
    const paragraph = String(record.paragraph ?? '').trim()
    const chapter = chapters.find(item => item.chapterNumber === chapterNumber)
    if (!chapter) continue
    const candidates = entranceCandidateParagraphs(chapter.content, request.character, request.maxCandidatesPerChapter)
    const matched = candidates.find(candidate => candidate.text === paragraph)
    if (!matched) continue
    if (seen.has(chapterNumber)) continue
    seen.add(chapterNumber)
    result.push({ chapterNumber, paragraph, index: matched.index })
  }
  return result
}

/**
 * 模型挑出的登场段 → 跨章同构比对的输入形状（与 \`entrance-shot.ts\` 的
 * \`CharacterEntrance\` 对齐，比对逻辑复用既有的 \`findRepeatedEntranceShots\`）。
 */
export function entranceSelectionToEntrances(
  selections: Array<{ chapterNumber: number; paragraph: string; index: number }>,
  character: string,
): Array<{ character: string; chapterNumber: number; sentence: string; sentenceIndex: number }> {
  return selections.map(selection => ({
    character,
    chapterNumber: selection.chapterNumber,
    sentence: selection.paragraph,
    sentenceIndex: selection.index,
  }))
}

/** 预检侧消费兼容：把模型判定转成一致性发现的形式（供深度检查汇报用）。 */
export function entranceSelectionFindings(
  issues: readonly EntranceSelectionIssue[],
): ConsistencyFinding[] {
  return issues.map(issue => ({
    stableFactKey: `entrance-selection:${issue.character}:${issue.chapterNumber}`,
    severity: 'warning' as const,
    sourceChapter: issue.chapterNumber,
    evidence: issue.quote.slice(0, 60),
    issue: {
      zhCN: `${issue.character} 在第 ${issue.chapterNumber} 章的登场段需要人工确认：${issue.explanation || '模型挑选的段落如下文所示'}。`,
      enUS: `The entrance paragraph for ${issue.character} in chapter ${issue.chapterNumber} needs confirmation: ${issue.explanation || 'the chosen paragraph is shown below'}.`,
    },
    suggestion: {
      zhCN: '确认模型挑的段是不是该角色本章的实体登场；不是的话去正文改写或手动指定。',
      enUS: 'Confirm whether the chosen paragraph is the character’s physical entrance; otherwise rewrite it or pick manually.',
    },
  }))
}

export type { ConsistencyFinding }
