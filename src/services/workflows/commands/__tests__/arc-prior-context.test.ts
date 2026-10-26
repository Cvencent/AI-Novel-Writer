import { describe, expect, it } from 'vitest'
import { buildArcPriorContext, sampleAnchors, type ArcPriorArc } from '../arc-prior-context'

const arc = (n: number): ArcPriorArc => ({
  fromChapter: n * 10 - 9, toChapter: n * 10, title: `段${n}`, beat: '起', summary: `第${n}段的剧情：主角经历了事件${n}。`,
})

describe('sampleAnchors', () => {
  it('includes first and last anchor and spreads evenly', () => {
    const picked = sampleAnchors(50, 10)
    expect(picked[0]).toBe(0)
    expect(picked.at(-1)).toBe(49)
    expect(new Set(picked).size).toBe(picked.length)
    expect(picked).toEqual([...picked].sort((a, b) => a - b))
  })
  it('handles small pools', () => {
    expect(sampleAnchors(1, 10)).toEqual([0])
    expect(sampleAnchors(2, 10).length).toBe(2)
  })
})

describe('buildArcPriorContext', () => {
  it('returns null with no arcs', () => {
    expect(buildArcPriorContext([], 'zh-CN')).toBeNull()
  })

  it('includes full index, anchor summaries, and recent full summaries', () => {
    const arcs = Array.from({ length: 30 }, (_, i) => arc(i + 1))
    const context = buildArcPriorContext(arcs, 'zh-CN', { maxAnchors: 5, recentFull: 3, summaryChars: 100 })
    expect(context).toContain('【粗纲至今（所有已生成段的索引）】')
    expect(context).toContain('段30')
    expect(context).toContain('【锚点段摘要（开头 + 中段采样）】')
    expect(context).toContain('第1段的剧情')
    expect(context).toContain('【最近几段（直接衔接它们写）】')
    expect(context).toContain('第30段的剧情')
  })

  it('truncates long summaries', () => {
    const long: ArcPriorArc = { fromChapter: 1, toChapter: 9, title: 't', beat: '起', summary: '长'.repeat(2000) }
    const context = buildArcPriorContext([long], 'zh-CN', { maxAnchors: 3, recentFull: 1, summaryChars: 100 })
    expect(context!.length).toBeLessThan(1000)
    expect(context).toContain('…')
  })
})
