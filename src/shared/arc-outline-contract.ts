import type { ArcBeat } from '../../electron/repositories/arc-outline-repository'

/** 粗纲段长的允许区间。模型在区间内自行判断具体跨度。 */
export const ARC_MIN_CHAPTERS = 20
export const ARC_MAX_CHAPTERS = 200

export const ARC_BEATS: readonly ArcBeat[] = Object.freeze([
  'setup', 'escalation', 'reversal', 'low', 'climax', 'aftermath', 'transition',
])

export type ArcSpanIssue = 'ARC_SPAN_TOO_SMALL' | 'ARC_SPAN_TOO_LARGE' | 'ARC_SPAN_OUT_OF_BOUNDS'

export type ValidationResult<TIssue extends string> = { ok: true } | { ok: false; code: TIssue }

/** 段长必须落在 [20, 200] 且不越出全书范围。 */
export function validateArcSpan(fromChapter: number, toChapter: number, totalChapters: number):
  { ok: true } | { ok: false; code: ArcSpanIssue } {
  if (!Number.isSafeInteger(fromChapter) || !Number.isSafeInteger(toChapter)
    || !Number.isSafeInteger(totalChapters) || totalChapters <= 0
    || fromChapter < 1 || toChapter < fromChapter || toChapter > totalChapters) {
    return { ok: false, code: 'ARC_SPAN_OUT_OF_BOUNDS' }
  }
  const span = toChapter - fromChapter + 1
  // 收官段可以短于下限：一键生成全部粗纲要铺满全书，最后一段往往不足 20 章。
  // 提示词也写明「如果剩余章节不足下限，这一段直接铺到全书末章」。只有铺到末章的
  // 收口段才放行，避免拿收官当借口把中段切碎。
  if (span < ARC_MIN_CHAPTERS && toChapter < totalChapters) return { ok: false, code: 'ARC_SPAN_TOO_SMALL' }
  if (span > ARC_MAX_CHAPTERS) return { ok: false, code: 'ARC_SPAN_TOO_LARGE' }
  return { ok: true }
}

/** 找出正文中出现的角色名（去重，按名单顺序）。 */
export function findCharacterNames(text: string, characterNames: readonly string[]): string[] {
  if (!text.trim()) return []
  const found: string[] = []
  const seen = new Set<string>()
  for (const raw of characterNames) {
    const name = raw.trim()
    if (name.length < 2 || seen.has(name)) continue
    if (text.includes(name)) {
      seen.add(name)
      found.push(name)
    }
  }
  return found
}

/** 粗纲阶段禁止出现具体人名。命中即判不合格。 */
export function validateArcNoProperNames(text: string, characterNames: readonly string[]):
  { ok: true } | { ok: false; found: string[] } {
  const found = findCharacterNames(text, characterNames)
  return found.length === 0 ? { ok: true } : { ok: false, found }
}

/**
 * 粗纲里出现具体人名时，把名字换成对应的身份词。
 *
 * 粗纲的规则是「只写方向、不写具体人名」——因为粗纲管的是走向，人名要到细纲才落地。
 * 模型偶尔会漏写名字，与其整段作废让作者白等一次生成，不如按作者名单里的角色定位
 * 把名字换回身份词：主角 → 主角，反派 → 对手，配角 → 配角。语义不变，规则也满足。
 *
 * 只替换长度 ≥ 2 的名字（与 findCharacterNames 同一门槛），避免单字名误伤正文。
 */
export function sanitizeArcProperNames(
  text: string,
  characterNames: readonly string[],
  roleByName: ReadonlyMap<string, string | undefined> = new Map(),
  language: 'zh-CN' | 'en-US' = 'zh-CN',
): { text: string; replaced: string[] } {
  let next = text
  const replaced: string[] = []
  for (const raw of characterNames) {
    const name = raw.trim()
    if (name.length < 2 || !next.includes(name)) continue
    const role = roleByName.get(name)
    const word = language === 'en-US'
      ? (role === 'protagonist' ? 'the protagonist'
        : role === 'antagonist' ? 'the antagonist'
          : role === 'supporting' ? 'a supporting character' : 'a character')
      : (role === 'protagonist' ? '主角'
        : role === 'antagonist' ? '对手'
          : role === 'supporting' ? '配角' : '某位角色')
    next = next.split(name).join(word)
    replaced.push(name)
  }
  return { text: next, replaced }
}

/** 形态去重：最近 window 段的 beat 与本段全同时判重复。 */
export function validateBeatDiversity(beat: ArcBeat, recentBeats: readonly ArcBeat[], window = 3):
  ValidationResult<'ARC_BEAT_REPEATED'> {
  const tail = recentBeats.slice(-window)
  if (tail.length < window) return { ok: true }
  return tail.every(item => item === beat) ? { ok: false, code: 'ARC_BEAT_REPEATED' } : { ok: true }
}

/** 模型返回的粗纲段（未落库前的解析结果）。 */
export interface ParsedArcSegment {
  fromChapter: number
  toChapter: number
  title: string
  beat: ArcBeat
  summary: string
}

export type ArcParseIssue =
  | 'ARC_PARSE_NO_SEGMENT'
  | 'ARC_PARSE_MISSING_BEAT'
  | 'ARC_PARSE_ILLEGAL_BEAT'
  | 'ARC_PARSE_EMPTY_SUMMARY'
  | 'ARC_PARSE_BAD_HEADING'

export type ArcParseResult =
  | { ok: true; segment: ParsedArcSegment }
  | { ok: false; code: ArcParseIssue }

/**
 * 把编辑器里整篇粗纲 Markdown 解析回分段。
 *
 * 格式与 renderArcOutlineMarkdown 一致：
 *   ## 第 1–120 章：标题
 *   beat: setup · 状态: confirmed
 *
 *   <正文>
 * 作者可能改动标题、beat、正文；区间由段结构决定，解析结果必须能对回既有段。
 */
export interface ParsedArcDocumentSegment extends ParsedArcSegment {
  status: string | null
}

export function parseArcOutlineDocument(markdown: string): ParsedArcDocumentSegment[] {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n")
  const segments: ParsedArcDocumentSegment[] = []
  let current: { fromChapter: number; toChapter: number; title: string; beat: ArcBeat | null; status: string | null; body: string[] } | null = null
  const push = () => {
    if (!current) return
    const summary = normalizeArcSummary(current.body.join("\n"))
    if (!summary) { current = null; return }
    segments.push({ fromChapter: current.fromChapter, toChapter: current.toChapter, title: current.title,
      beat: current.beat ?? "escalation", status: current.status, summary })
    current = null
  }
  for (const rawLine of lines) {
    const heading = tryParseArcHeading(rawLine.trim())
    if (heading) {
      push()
      current = { ...heading, beat: null, status: null, body: [] }
      continue
    }
    if (!current) continue
    const line = normalizeArcText(rawLine).trim()
    const meta = /^\**\s*(?:beat|形态)\s*\**\s*[：:\-–—]\s*([^·|\n]+?)\s*(?:[·|]\s*(?:状态|status)\s*[：:\-–—]\s*([^\n]+?)\s*)?$/iu.exec(line)
    if (meta && current.beat === null) {
      const candidate = normalizeArcText(meta[1]!).toLowerCase() as ArcBeat
      if ((ARC_BEATS as readonly string[]).includes(candidate)) current.beat = candidate
      current.status = (meta[2] ?? "").trim() || null
      continue
    }
    current.body.push(rawLine)
  }
  push()
  return segments
}

/** 把全角数字归一，避免模型换了键盘就解析不了。 */
function normalizeArcText(text: string): string {
  return text.replace(/[\uFF10-\uFF19]/gu, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).replace(/\uFF1A/gu, ":")
}

/**
 * 粗纲段标题。容忍模型常见写法：
 *   ## 第1–30章：标题   /  ## 第 1 - 30 章 标题
 *   ## 第1章至第30章：标题 / **第1-30章：标题** / 第1-30章：标题
 */
const ARC_HEADING = /^[#*\s]*第\s*(\d+)\s*(?:[–—~\-至到]\s*(?:第\s*)?(\d+)\s*)?章\s*[：:\-–—]?\s*(.*?)[*\s]*$/u

/** beat 行：beat: setup / **beat**：setup / 形态: setup / Beat - setup */
const ARC_BEAT_LINE = /^\**\s*(?:beat|形态)\s*\**\s*[：:\-–—]\s*\**\s*([^\s:：]+)\s*\**\s*$/iu

export function tryParseArcHeading(line: string): { fromChapter: number; toChapter: number; title: string } | null {
  const match = ARC_HEADING.exec(normalizeArcText(line.trim()))
  if (!match) return null
  const fromChapter = Number(match[1])
  const toChapter = Number(match[2] ?? match[1])
  if (!Number.isSafeInteger(fromChapter) || !Number.isSafeInteger(toChapter)) return null
  return { fromChapter, toChapter, title: (match[3] ?? "").trim() }
}

/**
 * 只保留「当前这一节」的正文。
 * 模型有时会把后面几段一起吐出来，从第二段标题处截断，避免后续内容并进本段造成重复。
 */
export function normalizeArcSummary(summary: string): string {
  const lines = summary.replace(/\r\n?/gu, "\n").split("\n")
  const kept: string[] = []
  for (const line of lines) {
    if (kept.some(item => item.trim()) && tryParseArcHeading(line)) break
    kept.push(line)
  }
  return kept.join("\n").trim()
}

/**
 * 解析模型返回的单个粗纲段。
 * 标题前允许有模型的寒暄或说明；标题格式见 ARC_HEADING。
 */
export function parseArcSegment(text: string): ArcParseResult {
  const lines = normalizeArcText(text).replace(/\r\n?/gu, "\n").split("\n")
  let fromChapter = -1
  let toChapter = -1
  let title = ""
  let beat: ArcBeat | null = null
  const body: string[] = []
  let sawHeading = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!sawHeading) {
      if (!line) continue
      const heading = tryParseArcHeading(line)
      if (heading) {
        fromChapter = heading.fromChapter
        toChapter = heading.toChapter
        title = heading.title
        sawHeading = true
      }
      continue
    }
    if (!line) { body.push(""); continue }
    // 后面又出现一段标题：一次调用只应产出当前这一段，直接截断。
    if (tryParseArcHeading(line)) break
    const beatMatch = ARC_BEAT_LINE.exec(line)
    if (beatMatch && beat === null) {
      const candidate = beatMatch[1]!.toLowerCase()
      if (!(ARC_BEATS as readonly string[]).includes(candidate)) return { ok: false, code: "ARC_PARSE_ILLEGAL_BEAT" }
      beat = candidate as ArcBeat
      continue
    }
    body.push(rawLine)
  }

  if (!sawHeading) return { ok: false, code: "ARC_PARSE_NO_SEGMENT" }
  // 缺 beat 时不作废：粗纲的关键是方向，用中性形态兜底。
  if (beat === null) beat = "escalation"
  const summary = normalizeArcSummary(body.join("\n"))
  if (!summary) return { ok: false, code: "ARC_PARSE_EMPTY_SUMMARY" }
  return { ok: true, segment: { fromChapter, toChapter, title, beat, summary } }
}
