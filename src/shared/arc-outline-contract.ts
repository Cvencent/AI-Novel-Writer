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
  if (span < ARC_MIN_CHAPTERS) return { ok: false, code: 'ARC_SPAN_TOO_SMALL' }
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

const ARC_HEADING = /^#{1,4}\s*第\s*(\d+)\s*[–—~-]\s*(\d+)\s*章\s*[:：]\s*(.*)$/u
const ARC_SINGLE_HEADING = /^#{1,4}\s*第\s*(\d+)\s*章\s*[:：]\s*(.*)$/u

/**
 * 解析模型返回的单个粗纲段。要求：
 *   ## 第{from}–{to}章：{标题}
 *   beat: {beat}
 *   {正文}
 */
export function parseArcSegment(text: string): ArcParseResult {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n')
  let fromChapter = -1
  let toChapter = -1
  let title = ''
  let beat: ArcBeat | null = null
  const body: string[] = []
  let sawHeading = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!sawHeading) {
      if (!line) continue
      const range = ARC_HEADING.exec(line)
      if (range) {
        fromChapter = Number(range[1]); toChapter = Number(range[2]); title = (range[3] ?? '').trim()
        sawHeading = true
        continue
      }
      const single = ARC_SINGLE_HEADING.exec(line)
      if (single) {
        fromChapter = Number(single[1]); toChapter = Number(single[1]); title = (single[2] ?? '').trim()
        sawHeading = true
        continue
      }
      return { ok: false, code: 'ARC_PARSE_BAD_HEADING' }
    }
    if (!line) { body.push(''); continue }
    const beatMatch = /^beat\s*[:：]\s*(\S+)\s*$/iu.exec(line)
    if (beatMatch && beat === null) {
      const candidate = beatMatch[1]!.toLowerCase()
      if (!(ARC_BEATS as readonly string[]).includes(candidate)) return { ok: false, code: 'ARC_PARSE_ILLEGAL_BEAT' }
      beat = candidate as ArcBeat
      continue
    }
    body.push(rawLine)
  }

  if (!sawHeading) return { ok: false, code: 'ARC_PARSE_NO_SEGMENT' }
  if (beat === null) return { ok: false, code: 'ARC_PARSE_MISSING_BEAT' }
  const summary = body.join('\n').trim()
  if (!summary) return { ok: false, code: 'ARC_PARSE_EMPTY_SUMMARY' }
  return { ok: true, segment: { fromChapter, toChapter, title, beat, summary } }
}
