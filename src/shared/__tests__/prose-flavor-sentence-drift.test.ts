import { describe, expect, it } from 'vitest'

import {
  AI_FLAVOR_QUOTAS,
  DRIFT_BASE_CHAPTERS,
  DRIFT_WINDOW,
  SENTENCE_RHYTHM_RULE_ZH_CN,
  measureProseFlavor,
  narrativeSentenceLengths,
  proseFlavorDriftFindings,
  proseFlavorFindings,
} from '../prose-flavor'

const ch = (chapterNumber: number, content: string) => ({ chapterNumber, content })

/** 造一句恰好 n 个汉字（不含标点）的叙述句。 */
const sentenceOf = (n: number) => '事'.repeat(n) + '。'

/** 造一章：把若干句拼成一段（去对白，叙述句）。 */
const chapterWith = (chapterNumber: number, lengths: readonly number[]) =>
  ch(chapterNumber, lengths.map(sentenceOf).join(''))

describe('narrativeSentenceLengths (issue #114)', () => {
  it('measures narration only — dialogue length is the speaker’s business, not the rhythm', () => {
    // 「他说，」的台词不进叙述句；剩下两句按去标点后的字数算。
    const content = '“我答应过的事，一定办到，绝不算话。”他推开门，走了进去。门轴响了一声。'
    expect(narrativeSentenceLengths(content)).toEqual([8, 6])
  })

  it('counts by characters after stripping punctuation, not raw length', () => {
    // 「他推开门，走了进去。」= 8 字（逗号与句号不算）。
    expect(narrativeSentenceLengths('他推开门，走了进去。')).toEqual([8])
  })

  it('does not treat a comma as a sentence end (unlike proseSentences)', () => {
    // 一句带逗号的话是**一句**，不是两句——按逗号切会把口径整体压短。
    expect(narrativeSentenceLengths('他推开门，走了进去，回手把门带上。')).toEqual([14])
  })

  it('returns nothing for an empty chapter', () => {
    expect(narrativeSentenceLengths('')).toEqual([])
  })
})

describe('measureProseFlavor narrative fields (issue #114)', () => {
  it('reports the narrative average, count and both tails', () => {
    const measurement = measureProseFlavor(chapterWith(1, [40, 10, 30, 8]))
    expect(measurement.narrativeSentenceCount).toBe(4)
    expect(measurement.narrativeAverageChars).toBeCloseTo(22, 5)
    expect(measurement.longNarrativeSentences).toBe(2)
    expect(measurement.shortNarrativeSentences).toBe(2)
  })

  it('keeps the legacy averageSentenceChars metric untouched', () => {
    // 旧口径（含对白、按所有标点切）仍要保留：既有判据与既有测试都依赖它。
    const measurement = measureProseFlavor(ch(1, '他推开门，走了进去。“我来了。”'))
    expect(measurement.averageSentenceChars).not.toBeNull()
  })
})

describe('句长下限判据 (issue #114)', () => {
  it('reports a chapter whose narration is all short beats', () => {
    // 后段形态：一串 4–6 字的短拍，均长 5 字。
    const chapter = chapterWith(48, [5, 6, 4, 5, 6, 4, 5, 6, 5, 4])
    const findings = proseFlavorFindings([chapter], 49, [])
    const floor = findings.find(finding => finding.stableFactKey === 'prose-flavor:sentence-length-floor:48')
    expect(floor).toBeDefined()
    expect(floor!.severity).toBe('warning')
    expect(floor!.evidence).toContain('低于清单下限')
  })

  it('stays silent on a chapter with alternating short and long narration', () => {
    // 长短交替是**要**的形态：均长落在下限之上就不报。
    const chapter = chapterWith(1, [30, 8, 28, 10, 26, 9, 30, 12, 28, 11])
    expect(proseFlavorFindings([chapter], 2, []).some(f => f.stableFactKey.startsWith('prose-flavor:sentence-length-floor'))).toBe(false)
  })

  it('does not judge a very short chapter (too few sentences to average)', () => {
    const chapter = chapterWith(1, [4, 5, 6])
    expect(proseFlavorFindings([chapter], 2, []).some(f => f.stableFactKey.startsWith('prose-flavor:sentence-length-floor'))).toBe(false)
  })

  it('keeps the upper-bound report and no longer pushes the author to only shorten', () => {
    // 上限侧仍然报（#93 的原判据），但建议里必须出现「别只朝短的方向改」的提醒。
    const chapter = chapterWith(1, Array.from({ length: 10 }, () => 40))
    const upper = proseFlavorFindings([chapter], 2, []).find(f => f.stableFactKey === 'prose-flavor:sentence-length:1')
    expect(upper).toBeDefined()
    expect(upper!.suggestion.zhCN).toContain('别只朝短的方向改')
  })
})

describe('跨章趋势：句长单向收敛 (issue #114)', () => {
  /** 前 10 章 22 字 → 后 10 章 11 字：正是 issue 报告的形态。 */
  const drifting = Array.from({ length: DRIFT_BASE_CHAPTERS + DRIFT_WINDOW }, (_, index) =>
    chapterWith(index + 1, Array.from({ length: 10 }, () => (index < DRIFT_BASE_CHAPTERS ? 22 : 11))))

  it('reports one drift finding when the recent chapters fall well below the opening baseline', () => {
    const findings = proseFlavorDriftFindings(drifting)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.stableFactKey).toBe('prose-flavor:sentence-length-drift')
    expect(findings[0]!.severity).toBe('warning')
    expect(findings[0]!.evidence).toContain('比开篇')
  })

  it('stays silent when the book keeps its rhythm', () => {
    const steady = Array.from({ length: DRIFT_BASE_CHAPTERS + DRIFT_WINDOW }, (_, index) =>
      chapterWith(index + 1, Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? 24 : 10))))
    expect(proseFlavorDriftFindings(steady)).toEqual([])
  })

  it('stays silent when the book has not accumulated base+window chapters yet', () => {
    // ⚠️ 设计规则⑪：接了检测 ≠ 检测会响。样本不足时判据必须**明确不触发**，
    // 而不是给出半个结论（这里 base+window 各 10 章）。
    expect(proseFlavorDriftFindings(drifting.slice(0, DRIFT_BASE_CHAPTERS + DRIFT_WINDOW - 1))).toEqual([])
    expect(proseFlavorDriftFindings([])).toEqual([])
  })

  it('keeps the key stable as the book advances (issues #86/#89/#98/#108)', () => {
    // key 不带章号/窗口末章号：带末章号的 key 会随窗口滚动，作者点「我已知」永远关不掉。
    const longer = [...drifting, chapterWith(DRIFT_BASE_CHAPTERS + DRIFT_WINDOW + 1, Array.from({ length: 10 }, () => 11))]
    expect(proseFlavorDriftFindings(longer)[0]!.stableFactKey).toBe(proseFlavorDriftFindings(drifting)[0]!.stableFactKey)
    expect(proseFlavorDriftFindings(longer)[0]!.stableFactKey).not.toMatch(/:\d+$/u)
  })

  it('does not fire when the drift is only a 1-character wobble', () => {
    // 绝对门槛（2.5 字）+ 相对门槛（15%）——只抖 1 字不该报。
    const wobble = Array.from({ length: DRIFT_BASE_CHAPTERS + DRIFT_WINDOW }, (_, index) =>
      chapterWith(index + 1, Array.from({ length: 10 }, () => (index < DRIFT_BASE_CHAPTERS ? 20 : 19))))
    expect(proseFlavorDriftFindings(wobble)).toEqual([])
  })

  it('hands over actionable exits (restore alternation, not shorten further)', () => {
    const finding = proseFlavorDriftFindings(drifting)[0]!
    expect(finding.suggestion.zhCN).toContain('长短交替')
    expect(finding.suggestion.enUS).toContain('alternation')
  })
})

describe('起草清单与判据共用同一份文字 (issue #114)', () => {
  it('states a two-sided rule, not just the ceiling', () => {
    expect(SENTENCE_RHYTHM_RULE_ZH_CN).toContain('12–22 字')
    expect(SENTENCE_RHYTHM_RULE_ZH_CN).toContain('25 字以上')
    // 原来的三条上限都要保留（不要为了加下限把既有约束删掉）。
    expect(SENTENCE_RHYTHM_RULE_ZH_CN).toContain('35 字')
  })

  it('uses the same numbers as the detector constants', () => {
    expect(SENTENCE_RHYTHM_RULE_ZH_CN).toContain(String(AI_FLAVOR_QUOTAS.minAverageSentenceChars))
    expect(SENTENCE_RHYTHM_RULE_ZH_CN).toContain(String(AI_FLAVOR_QUOTAS.averageSentenceChars))
    expect(SENTENCE_RHYTHM_RULE_ZH_CN).toContain(String(AI_FLAVOR_QUOTAS.longSentenceChars))
  })
})