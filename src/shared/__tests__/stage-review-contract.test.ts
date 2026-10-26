import { describe, expect, it } from 'vitest'
import {
  normalizeStageReviewFindings,
  normalizeStageReviewFindingsDetailed,
  normalizeStageReviewCategory,
  OUTLINE_REVIEW_CATEGORIES,
} from '../stage-review-contract'

const SELECTED = [3, 4]

describe('normalizeStageReviewCategory', () => {
  it('accepts key and Chinese label aliases', () => {
    expect(normalizeStageReviewCategory('pacing', OUTLINE_REVIEW_CATEGORIES)).toBe('pacing')
    expect(normalizeStageReviewCategory(' 节奏 ', OUTLINE_REVIEW_CATEGORIES)).toBe('pacing')
    expect(normalizeStageReviewCategory('情节逻辑', OUTLINE_REVIEW_CATEGORIES)).toBe('plot_logic')
    expect(normalizeStageReviewCategory('不是类别', OUTLINE_REVIEW_CATEGORIES)).toBeNull()
  })
})

describe('normalizeStageReviewFindingsDetailed', () => {
  it('keeps valid findings and reports why others were dropped', () => {
    const report = normalizeStageReviewFindingsDetailed([
      { chapter: 3, category: 'pacing', severity: 'warning', problemText: '节奏太赶。', expectedText: '改写。' },
      { chapter: 9, category: 'pacing', problemText: '章号不在所选范围。' },
      { chapter: 4, category: '节奏', problemText: '中文别名应被接受。', expectedText: '改写。' },
      { chapter: 4, category: '不是类别', problemText: '类别未知。' },
      { chapter: 4, category: 'pacing', problemText: '   ' },
    ], SELECTED, OUTLINE_REVIEW_CATEGORIES)
    expect(report.findings.map(f => f.targetIndex)).toEqual([3, 4])
    expect(report.findings[1]!.category).toBe('pacing')
    expect(report.rawCount).toBe(5)
    expect(report.dropped).toEqual({ unmatchedChapter: 1, unknownCategory: 1, emptyProblem: 1 })
  })

  it('returns empty for non-array payloads without throwing', () => {
    const report = normalizeStageReviewFindingsDetailed(null, SELECTED, OUTLINE_REVIEW_CATEGORIES)
    expect(report).toEqual({ findings: [], rawCount: 0, dropped: { unmatchedChapter: 0, unknownCategory: 0, emptyProblem: 0 } })
  })

  it('keeps the legacy delegate returning just findings', () => {
    expect(normalizeStageReviewFindings([
      { chapter: 3, category: 'pacing', problemText: 'x' },
    ], SELECTED, OUTLINE_REVIEW_CATEGORIES)).toHaveLength(1)
  })
})
