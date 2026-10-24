import type { ProjectCoreRow, ProjectCoreSynopsisExpected } from '../../electron/repositories/project-core-repository'
import type { PhysicalAttempt } from './generation-contract'
import type { VisibleCompositionReceipt } from './generation-owner-contract'
import type { MainGenerationRunHandle } from '../services/generation/generation-runtime'
import type { WritingLanguage } from './writing-language'
import type { Locale } from '../i18n/types'
import { buildOutlineRetrievalContext, DEFAULT_OUTLINE_CONTEXT_BUDGET } from './outline-retrieval-context.ts'

export const DEFAULT_PLANNING_ACTION_CHAPTERS = 5
export const PLANNING_ACTION_CHAPTER_LIMIT = 10
export const DEFAULT_PLANNING_TARGET_UNITS = 300
export const PLANNING_TARGET_UNITS_LIMIT = 1000

export function parsePlanningTargetUnits(value: unknown): number {
  if (value === undefined) return DEFAULT_PLANNING_TARGET_UNITS
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > PLANNING_TARGET_UNITS_LIMIT)
    throw new Error('GENERATION_PLANNING_TARGET_INVALID')
  return value
}

export function assertPlanningActionRange(range: PlotOutlineRange): void {
  if (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) || range.from < 1 || range.to < range.from
    || range.to - range.from + 1 > PLANNING_ACTION_CHAPTER_LIMIT) throw new Error('GENERATION_PLANNING_RANGE_INVALID')
}

export function planningTargetInstruction(kind: 'outline' | 'blueprint', targetUnits: number, language: WritingLanguage): string {
  const english = language === 'en-US'
  const field = kind === 'outline' ? english ? 'outline body' : '大纲正文' : english ? 'keyEvents narrative' : 'keyEvents 叙述'
  return english
    ? `Aim for about ${targetUnits} words per chapter in the ${field}. This is a soft target, excluding JSON, field names, identities and relationship metadata. Complete content above or below the target is accepted; do not truncate content to meet it. Keep supporting fields concise.`
    : `每章${field}目标约 ${targetUnits} 字。此值是软目标，不包括 JSON、字段名、身份及关系元数据。完整内容可以高于或低于目标，不得为凑字数截断内容。辅助字段可简写。`
}

export const PLOT_OUTLINE_PROTOCOL = 'chapter-outline-v3'
export const PLOT_OUTLINE_CONTENT = Object.freeze({ maxAttemptsPerChapter: 2 } as const)
export type PlotOutlineRange = Readonly<{ from: number; to: number }>
export type PlotOutlineAttemptKind = 'normal' | 'compact'
export interface PlotOutlineAuthorEdit {
  sourceHandle: MainGenerationRunHandle
  leaseEpoch: string
  operationId: string
  committedRange: PlotOutlineRange
}
export interface PlotOutlineAuthorEditReceipt {
  kind: 'author-edit'
  operationId: string
  sourceHandle: MainGenerationRunHandle
  requestedRange: PlotOutlineRange
  committedRange: PlotOutlineRange
  remainingRange: PlotOutlineRange | null
  synopsisHash: string
  payloadHash: string
  idempotent: boolean
}
export interface PlotOutlineRecovery {
  sourceHandle: MainGenerationRunHandle
  leaseEpoch: string
  draft: string
  completeChapters: number[]
  writeState: { kind: 'ready' } | { kind: 'blocked'; reason: 'in-flight' | 'source-changed' | 'author-saved' | 'source-invalid' }
  saved: PlotOutlineAuthorEditReceipt | null
}
export interface PlotOutlineSource {
  version: 1
  core: Omit<ProjectCoreRow, 'created_at' | 'updated_at' | 'character_states'>
}
export type PlotOutlineCursor =
  | { kind: 'request'; chapterNumber: number; attempt: PlotOutlineAttemptKind }
  | { kind: 'accept'; chapterNumber: number; artifactIds: string[]; text: string }
  | { kind: 'complete' }
  /** source-invalid：开跑时冻结的大纲按现行规则无效（升级前开跑、章节乱序或重复），只能读出与复制，不能续写或写回。 */
  | { kind: 'stopped'; chapterNumber: number; reason: 'in-flight' | 'unknown-completion' | 'attempts-exhausted' | 'source-invalid' }
export interface PlotOutlineProgress {
  protocol: typeof PLOT_OUTLINE_PROTOCOL
  range: PlotOutlineRange
  content: typeof PLOT_OUTLINE_CONTENT
  targetUnits: number
  cursor: PlotOutlineCursor
  sourceExpected: ProjectCoreSynopsisExpected
  /** 冻结大纲按现行规则无效（cursor 为 stopped/source-invalid）时为 null：没有可续写的前缀。 */
  confirmedPrefix: string | null
  composition: VisibleCompositionReceipt | null
}
export interface PlotOutlineAttempt {
  purpose: string
  status: PhysicalAttempt['status']
  finishReason: string | null
  artifact: { artifactId: string; text: string; revision: number; textHash: string } | null
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function plotOutlinePolicy(manifest: Readonly<Record<string, unknown>>): { range: PlotOutlineRange; content: typeof PLOT_OUTLINE_CONTENT } | null {
  if (manifest.operation !== 'generate-plot-outline') return null
  const policy = manifest.policy
  if (!record(policy) || !record(policy.planning)
    || policy.planning.kind !== 'architecture' || policy.planning.outlineProtocol !== PLOT_OUTLINE_PROTOCOL) return null
  const { intent, outlineContent } = policy.planning
  if (!record(intent) || !record(intent.synopsisRange) || !record(outlineContent)
    || Object.keys(outlineContent).length !== Object.keys(PLOT_OUTLINE_CONTENT).length
    || Object.entries(PLOT_OUTLINE_CONTENT).some(([key, value]) => outlineContent[key] !== value)) throw new Error('GENERATION_PLOT_OUTLINE_POLICY_INVALID')
  const { from, to } = intent.synopsisRange
  if (typeof from !== 'number' || typeof to !== 'number' || !Number.isSafeInteger(from) || !Number.isSafeInteger(to)
    || from < 1 || to < from || !record(policy.budget) || typeof policy.budget.maxPhysicalRequests !== 'number'
    || to - from + 1 > policy.budget.maxPhysicalRequests) throw new Error('GENERATION_PLOT_OUTLINE_POLICY_INVALID')
  return { range: { from, to }, content: PLOT_OUTLINE_CONTENT }
}

export function plotOutlineExpected(value: unknown): ProjectCoreSynopsisExpected {
  if (!record(value) || value.version !== 1 || !record(value.core)) throw new Error('GENERATION_PLOT_OUTLINE_SOURCE_INVALID')
  const core = value.core
  const fields = ['synopsis', 'premise', 'characters_arch', 'worldbuilding', 'genre', 'writing_language', 'plot_structure', 'narrative_pov', 'global_guidance'] as const
  for (const key of fields) if (typeof core[key] !== 'string') throw new Error('GENERATION_PLOT_OUTLINE_SOURCE_INVALID')
  if (!Number.isSafeInteger(core.total_chapters) || !Number.isSafeInteger(core.words_per_chapter)) throw new Error('GENERATION_PLOT_OUTLINE_SOURCE_INVALID')
  const source = core as PlotOutlineSource['core']
  return { synopsis: source.synopsis, premise: source.premise, charactersArch: source.characters_arch, worldbuilding: source.worldbuilding,
    genre: source.genre, totalChapters: source.total_chapters, wordsPerChapter: source.words_per_chapter,
    writingLanguage: source.writing_language === 'en-US' ? 'en-US' : 'zh-CN', plotStructure: source.plot_structure,
    narrativePov: source.narrative_pov, globalGuidance: source.global_guidance }
}

export function plotOutlinePurpose(chapterNumber: number, attempt: PlotOutlineAttemptKind): string {
  return `plot-outline:chapter:${chapterNumber}:${attempt}`
}

export function parsePlotOutlinePurpose(purpose: string): { chapterNumber: number; attempt: PlotOutlineAttemptKind } | null {
  const match = /^plot-outline:chapter:([1-9]\d*):(normal|compact)$/u.exec(purpose)
  if (!match || !Number.isSafeInteger(Number(match[1]))) return null
  return { chapterNumber: Number(match[1]), attempt: match[2] as PlotOutlineAttemptKind }
}

const DIGITS: Readonly<Record<string, number>> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const UNITS: Readonly<Record<string, number>> = { 十: 10, 百: 100, 千: 1000 }
const NUMBER = '[0-9零〇一二两三四五六七八九十百千]+'
function chapterNumber(token: string): number {
  if (/^\d+$/u.test(token)) return Number(token)
  let result = 0, digit = 0
  for (const char of token) {
    if (char in DIGITS) digit = DIGITS[char]!
    else { result += (digit || 1) * UNITS[char]!; digit = 0 }
  }
  return result + digit
}

function headings(text: string): { from: number; to: number; index: number; end: number; grouped: boolean }[] {
  const pattern = new RegExp(`^[\\t ]*(?:#{1,6}[\\t ]+|[-*+][\\t ]+)?(?:第(${NUMBER})(?:[–—-](${NUMBER}))?章|Chapters?[\\t ]+(\\d+)(?:[\\t ]*[–—-][\\t ]*(\\d+))?)(?=[\\t ]*(?:[:：.．—-]|$))[^\\r\\n]*`, 'gimu')
  return [...text.matchAll(pattern)].map(match => ({ from: chapterNumber(match[1] ?? match[3]),
    to: chapterNumber(match[2] ?? match[4] ?? match[1] ?? match[3]), index: match.index,
    end: match.index + match[0].length, grouped: !!(match[2] ?? match[4]) || /Chapters\s/iu.test(match[0]) }))
}

/** 细纲每章必须携带的固定小节，派生蓝图依赖这些小节。 */
export const OUTLINE_SECTIONS = [
  '场景与出场人物', '本章目标', '阻力与升级', '转折与代价', '结尾钩子', '伏笔',
] as const
export type OutlineSection = typeof OUTLINE_SECTIONS[number]
export function hasRequiredOutlineSections(text: string): boolean {
  const body = text.replace(/^##[^\r\n]*\r?\n/u, '')
  return OUTLINE_SECTIONS.every(section => body.includes(section))
}

/** 一章的起止位置：index 为该章标题行起点，end 为下一章标题行起点（或文末）。 */
export interface PlotOutlineChapterSpan {
  chapter: number
  index: number
  end: number
}

/**
 * 按章切出细纲条目。用于 AI 检查按章引用原文、接受建议后逐章替换文本。
 * 只认应用写入的标准标题形式（`## 第 N 章：标题` / `## Chapter N: title`）。
 */
export function plotOutlineChapterSpans(synopsis: string): PlotOutlineChapterSpan[] {
  const entries = headings(synopsis)
  return entries.map((entry, position) => ({
    chapter: entry.from,
    index: entry.index,
    end: entries[position + 1]?.index ?? synopsis.length,
  }))
}

/** 取某一章条目的原文（含标题行），不存在时返回 null。 */
export function plotOutlineChapterText(synopsis: string, chapter: number): string | null {
  const span = plotOutlineChapterSpans(synopsis).find(entry => entry.chapter === chapter)
  return span ? synopsis.slice(span.index, span.end).trim() : null
}

/**
 * 用一段新文本替换指定章节条目，其余章节逐字保留。
 * 新文本必须通过 validPlotOutlineEntry，否则抛错——避免把模型返回的脏结构写进正式细纲。
 */
export function replacePlotOutlineChapter(synopsis: string, chapter: number, nextEntry: string): string {
  const spans = plotOutlineChapterSpans(synopsis)
  const span = spans.find(entry => entry.chapter === chapter)
  if (!span) throw new Error('PLOT_OUTLINE_CHAPTER_NOT_FOUND')
  const replacement = nextEntry.trim()
  if (!validPlotOutlineEntry(replacement, chapter)) throw new Error('PLOT_OUTLINE_REPLACEMENT_INVALID')
  const before = synopsis.slice(0, span.index)
  const after = synopsis.slice(span.end)
  const joiner = before && !before.endsWith(String.fromCharCode(10) + String.fromCharCode(10)) ? String.fromCharCode(10) + String.fromCharCode(10) : ''
  return (before + joiner + replacement + (after.trimStart() ? String.fromCharCode(10) + String.fromCharCode(10) + after.trimStart() : '')).trimEnd() + String.fromCharCode(10)
}

export function validPlotOutlineEntry(text: string, chapter: number): boolean {
  if (/```|~~~|大纲批次进度|后续概览|Outline batch progress|Later overview/iu.test(text)) return false
  if (!new RegExp(`^## (?:第${chapter}章|Chapter ${chapter})[:：][\\t ]*\\S[^\\r\\n]*\\r?\\n`, 'iu').test(text.trim())) return false
  const entries = headings(text)
  const heading = entries[0]
  if (entries.length !== 1 || !heading || heading.grouped || heading.from !== chapter || heading.to !== chapter
    || text.slice(0, heading.index).trim() || !text.slice(heading.end).trim()) return false
  const body = text.slice(heading.end)
  return !/^[\t ]*(?:#{1,6}[\t ]+|(?:[-*+][\t ]+)?(?:第[^\r\n]*章|Chapters?\b))/imu.test(body)
}

function isToolCallRound(text: string | null | undefined): boolean {
  return typeof text === 'string' && /<tool_call>/u.test(text)
}

export function derivePlotOutlineCursor(range: PlotOutlineRange, acceptedCount: number, attempts: readonly PlotOutlineAttempt[]): PlotOutlineCursor {
  const chapter = range.from + acceptedCount
  if (chapter > range.to) return { kind: 'complete' }
  for (const kind of ['normal', 'compact'] as const) {
    // 细纲生成会走工具循环：同一章会有多轮物理请求，中间轮次只发出 <tool_call>，
    // 不构成章节尝试。若不排除，游标会误判该章已消耗并错跳到 compact。
    const matching = attempts.filter(attempt => attempt.purpose === plotOutlinePurpose(chapter, kind)
      && attempt.status !== 'cancelled-before-dispatch'
      && !isToolCallRound(attempt.artifact?.text))
    if (!matching.length) return { kind: 'request', chapterNumber: chapter, attempt: kind }
    if (matching.length !== 1) throw new Error('GENERATION_PLOT_OUTLINE_ATTEMPT_CONFLICT')
    const attempt = matching[0]!
    if (attempt.status === 'reserved' || attempt.status === 'dispatch-marked') return { kind: 'stopped', chapterNumber: chapter, reason: 'in-flight' }
    if (attempt.finishReason !== 'stop' && attempt.finishReason !== 'length') return { kind: 'stopped', chapterNumber: chapter, reason: 'unknown-completion' }
    // 日记体/账本体只在这里拒绝：这是「新产出能否被接受」的闸门。
    // 已接受的章节不再回溯校验，否则升级会污染历史运行的可读性。
    if (attempt.finishReason === 'stop' && attempt.artifact && validPlotOutlineEntry(attempt.artifact.text, chapter)
        && hasRequiredOutlineSections(attempt.artifact.text)
        && !isLedgerStyleOutline(attempt.artifact.text))
      return { kind: 'accept', chapterNumber: chapter, artifactIds: [attempt.artifact.artifactId], text: attempt.artifact.text }
  }
  return { kind: 'stopped', chapterNumber: chapter, reason: 'attempts-exhausted' }
}

export function joinPlotOutlineEntries(prefix: string, next: string): string {
  return [prefix.trim(), next.trim()].filter(Boolean).join('\n\n')
}

export function renderPlotOutlineSynopsis(body: string, coveredTo: number, expected: Pick<ProjectCoreSynopsisExpected, 'totalChapters' | 'writingLanguage'>): string {
  const english = expected.writingLanguage === 'en-US'
  const tail = coveredTo < expected.totalChapters ? english
    ? `> This outline covers chapters 1-${coveredTo} of ${expected.totalChapters}; the remaining chapters will be generated in later batches.`
    : `> 本大纲已覆盖至第 ${coveredTo} 章（全书 ${expected.totalChapters} 章），其余章节将在后续批次继续生成。` : ''
  return `# ${english ? 'Plot Outline' : '细纲'}\n\n${joinPlotOutlineEntries(body, tail)}`.trim()
}

/** 正式大纲里决定一批范围能否开跑、会替换哪几章的三项事实；主进程 begin 时取自 project_core。 */
export type PlotOutlineRangeSource = Pick<ProjectCoreSynopsisExpected, 'synopsis' | 'totalChapters' | 'writingLanguage'>

/** 章节条目要按章号严格递增：同一章出现两次，或作者调乱了顺序，按位置截取的前缀与尾部会丢章或重复。 */
export type PlotOutlineOrderIssue = { kind: 'duplicate'; chapter: number } | { kind: 'unordered' }

function chapterOrderIssue(entries: ReturnType<typeof headings>): PlotOutlineOrderIssue | null {
  let reach = -1 // 第 0 章（序章）也是合法章号
  for (const entry of [...entries].sort((left, right) => left.from - right.from)) {
    if (entry.from <= reach) return { kind: 'duplicate', chapter: entry.from }
    reach = Math.max(reach, entry.to)
  }
  return entries.every((entry, index) => index === 0 || entry.from > entries[index - 1].to) ? null : { kind: 'unordered' }
}

export function plotOutlineOrderIssue(synopsis: string): PlotOutlineOrderIssue | null {
  return chapterOrderIssue(headings(synopsis))
}

/** 开跑时冻结的大纲来源无效、任务不能续写时给作者的说明；恢复稿入口与「断点续写」共用同一份措辞。 */
export function plotOutlineSourceInvalidText(synopsis: string, locale: Locale): string {
  const t = (zh: string, en: string) => locale === 'en-US' ? en : zh
  const issue = plotOutlineOrderIssue(synopsis)
  if (!issue) return t('这次生成开跑时，大纲的章节编号与所选范围对不上或缺少章节，不能接着生成，恢复稿也不能保存。可以复制已生成的章节，改好大纲后重新生成。',
    'When this run started, the outline chapter numbers did not line up with the selected range or a chapter was missing, so it cannot continue and the recovery draft cannot be saved. Copy the generated chapters, fix the outline, then generate again.')
  if (issue.kind === 'duplicate') return t(`这次生成开跑时，大纲里第 ${issue.chapter} 章出现了不止一次，不能接着生成，恢复稿也不能保存。可以复制已生成的章节，改好大纲后重新生成。`,
    `When this run started, chapter ${issue.chapter} appeared more than once in the outline, so it cannot continue and the recovery draft cannot be saved. Copy the generated chapters, fix the outline, then generate again.`)
  return t('这次生成开跑时，大纲的章节没有按章号顺序排列，不能接着生成，恢复稿也不能保存。可以复制已生成的章节，把大纲排好后重新生成。',
    'When this run started, the outline chapters were not in chapter order, so it cannot continue and the recovery draft cannot be saved. Copy the generated chapters, put the outline in order, then generate again.')
}

export function plotOutlineConfirmedPrefix(expected: PlotOutlineRangeSource, range: PlotOutlineRange): string {
  const entries = headings(expected.synopsis)
  if (chapterOrderIssue(entries)) throw new Error('GENERATION_PLOT_OUTLINE_PREFIX_INVALID')
  if (entries.some(entry => entry.from < range.from && entry.to >= range.from || entry.from <= range.to && entry.to > range.to))
    throw new Error('GENERATION_PLOT_OUTLINE_PREFIX_INVALID')
  if (range.from === 1) return ''
  const before = entries.filter(entry => entry.to < range.from)
  // 开头的第 0 章（序章）是合法前缀；chapterOrderIssue 已保证它只出现一次且在最前。
  let next = before[0]?.from === 0 ? 0 : 1
  for (const entry of before) {
    if (entry.from !== next || entry.to < entry.from) throw new Error('GENERATION_PLOT_OUTLINE_PREFIX_INVALID')
    next = entry.to + 1
  }
  if (next !== range.from || !before.length) throw new Error('GENERATION_PLOT_OUTLINE_PREFIX_INVALID')
  const following = entries.find(entry => entry.from >= range.from)
  if (following) return expected.synopsis.slice(before[0].index, following.index).trim()
  const title = `# ${expected.writingLanguage === 'en-US' ? 'Plot Outline' : '细纲'}\n\n`
  const suffix = renderPlotOutlineSynopsis('', range.from - 1, expected).slice(title.length)
  if (!expected.synopsis.startsWith(title) || !suffix || !expected.synopsis.endsWith(suffix)) throw new Error('GENERATION_PLOT_OUTLINE_PREFIX_INVALID')
  const prefix = expected.synopsis.slice(title.length, -suffix.length).trim()
  if (!prefix || renderPlotOutlineSynopsis(prefix, range.from - 1, expected) !== expected.synopsis) throw new Error('GENERATION_PLOT_OUTLINE_PREFIX_INVALID')
  return prefix
}

/**
 * 这一批交给主进程会怎样：invalid 为 begin 时 plotOutlineConfirmedPrefix 会拒绝；overwrite 为替换已有的第 from–to 章
 * （没有按章标题时 whole 为整份替换），其余章节由 renderPlotOutlineRange 原样保留；continue 为紧接已有章节往后写。
 */
export type PlotOutlineRangeEffect =
  | { kind: 'invalid'; lastChapter: number; hasEntries: boolean; orderIssue: PlotOutlineOrderIssue | null }
  | { kind: 'new' }
  | { kind: 'continue'; after: number }
  | { kind: 'overwrite'; whole: boolean; from: number; to: number; lastChapter: number }

export function plotOutlineRangeEffect(source: PlotOutlineRangeSource, range: PlotOutlineRange): PlotOutlineRangeEffect {
  const entries = headings(source.synopsis)
  const lastChapter = entries.reduce((last, entry) => Math.max(last, entry.to), 0)
  try { plotOutlineConfirmedPrefix(source, range) } catch { return { kind: 'invalid', lastChapter, hasEntries: entries.length > 0, orderIssue: chapterOrderIssue(entries) } }
  if (!source.synopsis.trim()) return { kind: 'new' }
  if (!entries.length) return { kind: 'overwrite', whole: true, from: range.from, to: range.to, lastChapter }
  const replaced = entries.filter(entry => entry.from >= range.from && entry.from <= range.to)
  if (!replaced.length) return range.from > 1 ? { kind: 'continue', after: range.from - 1 } : { kind: 'new' }
  return { kind: 'overwrite', whole: false, from: replaced[0].from, to: replaced[replaced.length - 1].to, lastChapter }
}

/** 下一批的默认起始章：已有大纲能紧接着往后写时取最后一章的下一章，否则从第 1 章起。 */
export function plotOutlineNextChapter(source: PlotOutlineRangeSource): number {
  const next = headings(source.synopsis).reduce((last, entry) => Math.max(last, entry.to), 0) + 1
  return next > 1 && next <= source.totalChapters && plotOutlineRangeEffect(source, { from: next, to: next }).kind === 'continue' ? next : 1
}

/** renderPlotOutlineSynopsis 写在末尾的覆盖说明，章数与全书章数不限：大纲改过章数或删过章节后留下的旧说明。 */
const STALE_COVERAGE_TAIL = /(?:\s*\n> (?:本大纲已覆盖至第 \d+ 章（全书 \d+ 章），其余章节将在后续批次继续生成。|This outline covers chapters 1-\d+ of \d+; the remaining chapters will be generated in later batches\.))+$/u

/** Replace only the explicitly committed chapter range; keep the surrounding source text. */
export function renderPlotOutlineRange(body: string, range: PlotOutlineRange, expected: PlotOutlineRangeSource): string {
  plotOutlineConfirmedPrefix(expected, range)
  const entries = headings(expected.synopsis)
  if (!entries.length) return renderPlotOutlineSynopsis(body, range.to, expected)
  const start = entries.find(entry => entry.from >= range.from)
  const after = entries.find(entry => entry.from > range.to)
  const title = `# ${expected.writingLanguage === 'en-US' ? 'Plot Outline' : '细纲'}\n\n`
  const suffix = renderPlotOutlineSynopsis('', range.to, expected).slice(title.length)
  if (start) {
    const before = expected.synopsis.slice(0, start.index)
    if (after) return `${before}${body.trim()}\n\n${expected.synopsis.slice(after.index)}`
    return `${before}${body.trim()}${suffix ? `\n\n${suffix}` : ''}`
  }
  // 已有章节都在第 1 章之前，只能是第 0 章序章：作者原文逐字留在前面、新章接在后面，按续批要求的形式重建标准标题与覆盖说明。
  // 自定义顶层标题与其他前置文字一样算作者原文保留；原有的标准标题行和应用写的旧覆盖说明不再带入。
  if (range.from === 1) {
    const authored = expected.synopsis.trim().replace(new RegExp(`^${title.trim()}[\\t ]*(?=\\n|$)`, 'u'), '').replace(STALE_COVERAGE_TAIL, '')
    return renderPlotOutlineSynopsis(joinPlotOutlineEntries(authored, body), range.to, expected)
  }
  return renderPlotOutlineSynopsis(joinPlotOutlineEntries(plotOutlineConfirmedPrefix(expected, range), body), range.to, expected)
}

export function validPlotOutlineAuthorPrefix(synopsis: string, progress: Pick<PlotOutlineProgress, 'range' | 'sourceExpected' | 'confirmedPrefix'>, range: PlotOutlineRange): boolean {
  if (!range || range.from !== progress.range.from || !Number.isSafeInteger(range.to) || range.to < range.from || range.to > progress.range.to) return false
  const expected = progress.sourceExpected
  const all = headings(synopsis), entries = all.filter(entry => entry.from >= range.from && entry.from <= range.to)
  if (entries.length !== range.to - range.from + 1) return false
  const after = all.find(entry => entry.from > range.to)
  const title = `# ${expected.writingLanguage === 'en-US' ? 'Plot Outline' : '细纲'}\n\n`
  const suffix = renderPlotOutlineSynopsis('', range.to, expected).slice(title.length)
  const end = after?.index ?? (suffix && synopsis.endsWith(suffix) ? synopsis.length - suffix.length : synopsis.length)
  const authored = synopsis.slice(entries[0].index, end).trim()
  const authoredEntries = headings(authored)
  return authoredEntries.every((entry, index) => validPlotOutlineEntry(authored.slice(entry.index, authoredEntries[index + 1]?.index).trim(), range.from + index))
    && renderPlotOutlineRange(authored, range, expected) === synopsis
}

export function plotOutlineSourceInvalid(progress: Pick<PlotOutlineProgress, 'cursor'>): boolean {
  return progress.cursor.kind === 'stopped' && progress.cursor.reason === 'source-invalid'
}

export function plotOutlineRecoveryDraft(progress: PlotOutlineProgress, failedCandidate?: string): string {
  // 来源无效时拼不回正式大纲，只留已生成的章节与失败的候选供复制。
  if (plotOutlineSourceInvalid(progress)) return joinPlotOutlineEntries(progress.composition?.text ?? '', failedCandidate ?? '')
  const completed = progress.composition?.chapters?.length ?? 0
  const chapter = progress.range.from + completed
  let body = progress.composition?.text ?? ''
  if (progress.cursor.kind === 'accept') body = joinPlotOutlineEntries(body, progress.cursor.text)
  else if (progress.cursor.kind !== 'complete' && failedCandidate?.trim()) {
    // 只并入真正有内容的候选。绝不能补一个「有标题、无正文」的空章，
    // 否则恢复稿无法通过连续完整章节校验，作者也会被卡在保存失败。
    body = joinPlotOutlineEntries(body, failedCandidate.trim())
  }
  return renderPlotOutlineRange(body, { from: progress.range.from, to: Math.min(chapter, progress.range.to) }, progress.sourceExpected)
}

export interface PlotOutlineContextOptions {
  /** 注入上下文的最大字符数。 */
  budgetChars?: number
  /** 最近 N 章保留全文。 */
  recentFullChapters?: number
  /** 已知人物名，用于生成人物索引。 */
  characterNames?: readonly string[]
}

/**
 * 构造本次请求注入模型的大纲上下文。
 *
 * 关键修复：旧实现把「已接受大纲前缀」全文拼进 prompt，前缀随章数线性增长，
 * 到 300 章时单次输入约 27 万 token，输出额度被挤空导致必然失败。
 * 现在改走 buildOutlineRetrievalContext：最近章节保留全文，更早章节压成
 * 对数式区间摘要，总长度恒定有界；合并与校验仍使用完整前缀（本地计算）。
 */
export function plotOutlineContextForPrompt(
  progress: PlotOutlineProgress,
  options: PlotOutlineContextOptions = {},
): { text: string; stats: { totalChapters: number; usedChars: number; compacted: boolean; budgetChars: number } } {
  if (progress.confirmedPrefix === null) throw new Error('GENERATION_PLOT_OUTLINE_PREFIX_INVALID')
  const fullPrefix = joinPlotOutlineEntries(progress.confirmedPrefix, progress.composition?.text ?? '')
  const built = buildOutlineRetrievalContext(fullPrefix, {
    writingLanguage: progress.sourceExpected.writingLanguage,
    budgetChars: options.budgetChars ?? DEFAULT_OUTLINE_CONTEXT_BUDGET,
    recentFullChapters: options.recentFullChapters,
    characterNames: options.characterNames,
  })
  return { text: built.text, stats: built.stats }
}

export interface ChapterOutlineArcSegment {
  fromChapter: number
  toChapter: number
  title: string
  summary: string
  beat: string
  status?: string
}

/**
 * 每章都必须看到完整粗纲索引，以及本段实际覆盖的粗纲段全文。
 */
export function chapterOutlineArcDirective(
  arcs: readonly ChapterOutlineArcSegment[],
  chapter: number,
  language: WritingLanguage,
): string {
  const covering = arcs.filter(arc => arc.fromChapter <= chapter && arc.toChapter >= chapter)
  const index = arcs.map(arc => `- 第${arc.fromChapter}–${arc.toChapter}章（${arc.beat}）${arc.title}${arc.status === 'confirmed' ? '' : '［未确认］'}`).join('\n')
  const coveringText = covering.map(arc => `第${arc.fromChapter}–${arc.toChapter}章（${arc.beat}）${arc.title}：\n${arc.summary}`).join('\n\n')
  return language === 'en-US'
    ? `[Full arc outline index (direction overview)]\n${index}\n\n[Owning arc segment for Chapter ${chapter} (the chapter must follow this direction)]\n${coveringText || '(no confirmed arc segment covers this chapter)'}`
    : `【全书粗纲索引（方向总览，供判断前后文）】\n${index}\n\n【当前章所属粗纲段（第 ${chapter} 章必须服从其方向与转折，不得改写走向）】\n${coveringText || '（当前章没有对应的已确认粗纲段）'}`
}

/** 章级细纲的固定事实合同。 */
export function chapterOutlineCoreContract(
  facts: { coreOutline: string; premise: string; charactersArch: string; worldbuilding: string; globalGuidance: string },
  language: WritingLanguage,
): string {
  const none = language === 'en-US' ? '(not provided)' : '（未填写）'
  return language === 'en-US'
    ? `[Core outline (book-level direction, must follow)]\n${facts.coreOutline || none}\n\n[Premise]\n${facts.premise}\n\n[Character graph (author facts; do not rewrite character settings)]\n${facts.charactersArch}\n\n[Worldbuilding]\n${facts.worldbuilding}\n\n[Global writing guidance]\n${facts.globalGuidance || none}`
    : `【核心大纲（全书方向，必须遵守）】\n${facts.coreOutline || none}\n\n【故事前提】\n${facts.premise}\n\n【角色图谱（作者事实，不得改写人物设定）】\n${facts.charactersArch}\n\n【世界观】\n${facts.worldbuilding}\n\n【全局写作要求】\n${facts.globalGuidance || none}`
}

/**
 * 细纲必须是章节规划，不是按时间罗列的日记/账本。
 * 识别模型把正文文风（压力—应对—结算）误套到细纲排版上的典型形态。
 */
export function isLedgerStyleOutline(text: string): boolean {
  const timeMarks = text.match(/^[\t ]*(?:[上下]午)?[零一二三四五六七八九十百\d]{1,3}点(?:半|整|多)?[，,。]/gmu)?.length ?? 0
  return timeMarks >= 4 || /\*\*结算\*\*/u.test(text) || /账页最上面一行/u.test(text)
}

export function plotOutlineRequestContract(
  progress: PlotOutlineProgress,
  chapter: number,
  attempt: PlotOutlineAttemptKind,
  options: PlotOutlineContextOptions = {},
): string {
  if (progress.confirmedPrefix === null) throw new Error('GENERATION_PLOT_OUTLINE_PREFIX_INVALID')
  const contextText = plotOutlineContextForPrompt(progress, options).text
  const english = progress.sourceExpected.writingLanguage === 'en-US'
  return english
    ? `[Accepted outline context]\n${contextText}\n[/Accepted outline context]\n\n`
      + `Write only Chapter ${chapter}, inside the selected range ${progress.range.from}-${progress.range.to}. Use exactly one level-two Markdown heading "## Chapter ${chapter}: Title" with Arabic chapter digits, followed by a non-empty body. No chapter groups, list headings, other chapters, preface, progress line or later overview. ${planningTargetInstruction('outline', progress.targetUnits, progress.sourceExpected.writingLanguage)} Preserve all author facts, required events and ending requirements. Do not rewrite the accepted context.`
      + '\n\n[Required sections (all six, in this order)]\n**Scene and cast** / **Chapter goal** / **Resistance and escalation** / **Turn and cost** / **Closing hook** / **Foreshadowing**. One paragraph each, section name in bold.'
      + '\n\n[How to write this chapter outline]\n- State what happens, why, and with what consequence; do not list a timetable.\n- Use dramatic units: scene and cast -> goal -> resistance and escalation -> turn or cost -> closing hook.\n- Prose style rules (pressure-response-settlement, number echoes) govern the novel prose, not the outline layout.\n- Forbidden: timestamped segments, per-item settlement lists, ledger excerpts, or a closing **Settlement** block.\n- Use the accepted context only for continuity; do not imitate its layout.'
      + (attempt === 'compact' ? '\nRebuild this chapter once from the original frozen facts and accepted context. The failed candidate is not a source. Produce a complete concise replacement, not a continuation or a cut-off excerpt.' : '')
    : `【已接受大纲上下文】\n${contextText}\n【已接受大纲上下文结束】\n\n`
      + `本次只写第 ${chapter} 章，所选范围为第 ${progress.range.from}–${progress.range.to} 章。只用一个二级 Markdown 章标题“## 第${chapter}章：标题”，章号使用阿拉伯数字，标题下一行写非空正文。不得输出章组、列表标题、其他章、开场说明、进度行或后续概览。${planningTargetInstruction('outline', progress.targetUnits, progress.sourceExpected.writingLanguage)}保留作者硬事实、明确事件和尾部要求，不改写已接受上下文。`
      + `\n\n【必须使用的固定小节（缺一不可，按此顺序）】\n**场景与出场人物** / **本章目标** / **阻力与升级** / **转折与代价** / **结尾钩子** / **伏笔**。每个小节写一段，小节名用粗体开头。`
      + `\n\n【这一章的大纲怎么写】\n- 写「这一章要发生什么、为什么发生、结果如何」，不是按时间罗列日程。\n- 用戏剧单元组织：场景与出场人物 → 本章目标 → 阻力与升级 → 转折或代价 → 结尾钩子。\n- 正文里的人物文风（如压力—应对—结算、数字对照）只约束将来的正文，不要套用到细纲的排版上。\n- 禁止：以「七点／八点／上午／下午／傍晚」等时间戳分段；禁止逐条结算、账目清单、日程表式罗列；禁止「他写：…」式的日记摘抄；禁止在章末写「**结算**：…」。\n- 已接受上下文只用于承接剧情、人物状态与伏笔，不要模仿它的排版或句式。`
      + (attempt === 'compact' ? '\n本次从原始冻结事实和已接受上下文重新构建此章。失败候选不是来源。输出一份完整简洁的替代大纲，不得续接失败候选或截取其片段。' : '')
}
