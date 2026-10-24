import { describe, expect, it } from 'vitest'
import { buildArcReviewPrompt, normalizeArcReviewFindings, ARC_REVIEW_CATEGORIES } from '../arc-review-contract'

const arcs = [
  { arcIndex: 1, fromChapter: 1, toChapter: 120, title: '零号档案', beat: 'setup', summary: '主角入学被读作零。' },
  { arcIndex: 2, fromChapter: 121, toChapter: 300, title: '低一格', beat: 'escalation', summary: '确认全校低一格。' },
]

describe('WP5 arc review contract', () => {
  it('lists the review categories', () => {
    expect(ARC_REVIEW_CATEGORIES).toContain('plot_logic')
    expect(ARC_REVIEW_CATEGORIES).toContain('reveal_pacing')
    expect(ARC_REVIEW_CATEGORIES).toContain('duplication')
    expect(ARC_REVIEW_CATEGORIES).toContain('foreshadowing')
    expect(ARC_REVIEW_CATEGORIES).toContain('core_outline_consistency')
    expect(ARC_REVIEW_CATEGORIES).toContain('worldbuilding_consistency')
  })
  it('builds a prompt that carries the full arc set and the selected range', () => {
    const prompt = buildArcReviewPrompt({ arcs, selected: [1, 2], coreOutline: '全书方向', worldbuilding: '世界观', language: 'zh-CN' })
    expect(prompt).toContain('零号档案')
    expect(prompt).toContain('低一格')
    expect(prompt).toContain('全书方向')
    expect(prompt).toContain('世界观')
    expect(prompt).toContain('reveal_pacing')
  })
  it('normalizes findings and drops entries that do not target a selected segment', () => {
    const findings = normalizeArcReviewFindings([
      { arcIndex: 2, category: 'duplication', severity: 'warning', problemText: '与第1段重复。', expectedText: '改成新方向。' },
      { arcIndex: 9, category: 'duplication', severity: 'warning', problemText: '越界。', expectedText: 'x' },
    ], [1, 2])
    expect(findings).toHaveLength(1)
    expect(findings[0]!.targetIndex).toBe(2)
    expect(findings[0]!.category).toBe('duplication')
  })
  it('rejects an unknown category and an empty problem text', () => {
    expect(normalizeArcReviewFindings([{ arcIndex: 1, category: 'nonsense', severity: 'warning', problemText: 'x', expectedText: 'y' }], [1])).toHaveLength(0)
    expect(normalizeArcReviewFindings([{ arcIndex: 1, category: 'duplication', severity: 'warning', problemText: '  ', expectedText: 'y' }], [1])).toHaveLength(0)
  })
})
