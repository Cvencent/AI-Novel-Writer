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

/** 形态去重：最近 window 段的 beat 与本段全同时判重复。 */
export function validateBeatDiversity(beat: ArcBeat, recentBeats: readonly ArcBeat[], window = 3):
  ValidationResult<'ARC_BEAT_REPEATED'> {
  const tail = recentBeats.slice(-window)
  if (tail.length < window) return { ok: true }
  return tail.every(item => item === beat) ? { ok: false, code: 'ARC_BEAT_REPEATED' } : { ok: true }
}
