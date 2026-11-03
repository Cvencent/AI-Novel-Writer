import { describe, expect, it } from 'vitest'

import {
  QUOTE_FAMILIES,
  QUOTE_STYLE_MIN_PAIRS,
  countQuotePairs,
  findQuoteStyleDrift,
  findQuoteStyleDriftFindings,
  quoteStyleProfileOf,
} from '../quote-style'

const CURLY = QUOTE_FAMILIES[0]
const CORNER = QUOTE_FAMILIES[1]

const ch = (chapterNumber: number, content: string) => ({ chapterNumber, content })
/** 造一章：pairs 对弯引号（或直角引号）。 */
const withQuotes = (chapterNumber: number, pairs: number, family: 'curly' | 'corner' = 'curly') =>
  ch(chapterNumber, Array.from({ length: pairs }, () => family === 'curly' ? '“话。”' : '「话。」').join('\n\n'))

/**
 * issue #118：那本 51 章的书前 51 章用弯引号，**第 52 章整章改用直角引号**；
 * 起草模板硬性要求双引号（`builtin-prompt-templates.ts:871` / `:959` 都写了），
 * 模型仍整章违反，而后端没有任何一道关（所有检测器都把三套引号写进字符类兜住，
 * 没有一处比较「本章风格是否与全书一致」）。
 */
describe('countQuotePairs (issue #118)', () => {
  it('counts complete pairs only — a half pair is not one', () => {
    expect(countQuotePairs('“甲。” “乙。”', CURLY)).toBe(2)
    // 开引号后直接又开一个（没闭合）→ 不算对。
    expect(countQuotePairs('“甲“乙”', CURLY)).toBe(1)
    expect(countQuotePairs('没有对白。', CURLY)).toBe(0)
  })

  it('treats 「」 and 『』 as the same corner family', () => {
    expect(countQuotePairs('「甲。」『乙。』', CORNER)).toBe(2)
  })

  it('keeps the families separate (a chapter can have both)', () => {
    const profile = quoteStyleProfileOf(1, '“甲。” 「乙。」')
    expect(profile.curlyPairs).toBe(1)
    expect(profile.cornerPairs).toBe(1)
  })
})

describe('findQuoteStyleDrift (issue #118)', () => {
  /** 23 章弯引号 + 1 章直角 = 实际语料（0202 的 ch17）。 */
  const book = [
    ...Array.from({ length: 10 }, (_, i) => withQuotes(i + 1, 8)),
    withQuotes(11, 9, 'corner'),
    ...Array.from({ length: 12 }, (_, i) => withQuotes(i + 12, 7)),
  ]

  it('reports the one chapter that switched the whole chapter', () => {
    const hit = findQuoteStyleDrift(book.map(chapter => quoteStyleProfileOf(chapter.chapterNumber, chapter.content)))
    expect(hit).not.toBeNull()
    expect(hit!.majority).toBe('curly')
    expect(hit!.minority).toBe('corner')
    expect(hit!.driftedChapters).toEqual([11])
    expect(hit!.majorityChapters.length).toBeGreaterThan(20)
  })

  it('stays silent on a book that keeps one style throughout', () => {
    const uniform = Array.from({ length: 12 }, (_, i) => withQuotes(i + 1, 8))
    expect(findQuoteStyleDrift(uniform.map(c => quoteStyleProfileOf(c.chapterNumber, c.content)))).toBeNull()
  })

  it('stays silent on a chapter with too few dialogue pairs to judge', () => {
    // 少量直角引号（引用书名/术语这类）不是「整章切换」——报了就是噪声。
    const few = [
      ...Array.from({ length: 10 }, (_, i) => withQuotes(i + 1, 8)),
      ch(11, '他说「这册子」不算数。'),
      ...Array.from({ length: 6 }, (_, i) => withQuotes(i + 12, 7)),
    ]
    const hit = findQuoteStyleDrift(few.map(c => quoteStyleProfileOf(c.chapterNumber, c.content)))
    expect(hit).toBeNull()
  })

  it('stays silent when the two styles are split evenly (not a drift, two parallel styles)', () => {
    const split = [
      ...Array.from({ length: 6 }, (_, i) => withQuotes(i + 1, 8)),
      ...Array.from({ length: 6 }, (_, i) => withQuotes(i + 7, 8, 'corner')),
    ]
    expect(findQuoteStyleDrift(split.map(c => quoteStyleProfileOf(c.chapterNumber, c.content)))).toBeNull()
  })

  it('does not drift-report a chapter that mixes both styles substantially', () => {
    // 混用（同章两套并存）不是「整章切换」。
    const mixed = [
      ...Array.from({ length: 10 }, (_, i) => withQuotes(i + 1, 8)),
      ch(11, Array.from({ length: 6 }, () => '“甲。”「乙。」').join('\n')),
      ...Array.from({ length: 6 }, (_, i) => withQuotes(i + 12, 7)),
    ]
    expect(findQuoteStyleDrift(mixed.map(c => quoteStyleProfileOf(c.chapterNumber, c.content)))).toBeNull()
  })

  it('has a minimum-pairs threshold constant', () => {
    expect(QUOTE_STYLE_MIN_PAIRS).toBeGreaterThanOrEqual(2)
  })
})

describe('findQuoteStyleDriftFindings (issue #118 finding shape)', () => {
  const book = [
    ...Array.from({ length: 10 }, (_, i) => withQuotes(i + 1, 8)),
    withQuotes(11, 9, 'corner'),
    ...Array.from({ length: 12 }, (_, i) => withQuotes(i + 12, 7)),
  ]

  it('names both styles and the drifted chapters, and stays a warning', () => {
    const findings = findQuoteStyleDriftFindings(book)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('warning')
    expect(findings[0]!.evidence).toContain('11')
    expect(findings[0]!.evidence).toContain('直角引号')
    expect(findings[0]!.evidence).toContain('弯引号')
  })

  it('keeps the key stable and free of the chapter number (issues #86/#89/#98/#108)', () => {
    const finding = findQuoteStyleDriftFindings(book)[0]!
    expect(finding.stableFactKey).toBe('quote-style:drift:corner')
    expect(finding.stableFactKey).not.toContain(':11')
  })

  it('hands over an actionable exit (switch back, or convert the whole book)', () => {
    const finding = findQuoteStyleDriftFindings(book)[0]!
    expect(finding.suggestion.zhCN).toContain('改回全书的多数派风格')
    expect(finding.suggestion.zhCN).toContain('整本一起改')
    expect(finding.suggestion.enUS).toContain('majority style')
  })

  it('sourceChapter points at the drifted chapter, not the one being written', () => {
    expect(findQuoteStyleDriftFindings(book)[0]!.sourceChapter).toBe(11)
  })

  it('does not report internal/dev artifacts in user-facing copy (issue #112)', () => {
    const finding = findQuoteStyleDriftFindings(book)[0]!
    for (const text of [finding.evidence, finding.issue.zhCN, finding.issue.enUS, finding.suggestion.zhCN, finding.suggestion.enUS]) {
      expect(text).not.toMatch(/issue\s*#\d+/u)
      expect(text).not.toMatch(/样本/u)
    }
  })
})