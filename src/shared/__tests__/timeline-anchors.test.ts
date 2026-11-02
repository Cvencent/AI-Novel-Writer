import { describe, expect, it } from 'vitest'

import {
  designSections,
  durationAnchors,
  durationValue,
  findTimelineAnchorConflicts,
} from '../timeline-anchors'
import { findDesignTimelineConflicts } from '../consistency-preflight'

/** issue #2 报告里的三段设定（原文照抄，把判据钉在真实样本上）。 */
const REPORTED = {
  premise: '周叙是沿海小城夜航船上的杂工，十年前父亲在同一航次“落水失踪”，官方记录写着意外。搭档温珩二十年不换那件洗得发白的靛蓝短褂，因为那正是周叙父亲落水那夜穿走的衣服。',
  worldbuilding: '周叙父亲失踪十年，要彻底翻案至少需要补写三笔。温珩二十年不换靛蓝短褂，因为那正是周叙父亲落水那夜穿走的衣服。',
  charactersArch: '周叙，年龄：28。背景：十八岁那年父亲在同一航次落水失踪，留船做杂工十年。\n温珩，年龄：52。背景：二十年来在夜航船帮工，身上却是周叙父亲落水那夜的靛蓝短褂。备注：短褂是父亲落水那夜的物证。',
}

describe('durationValue', () => {
  it('parses arabic numerals', () => {
    expect(durationValue('10')).toBe(10)
    expect(durationValue('3000')).toBe(3000)
  })

  it('parses the common chinese forms', () => {
    expect(durationValue('十')).toBe(10)
    expect(durationValue('二十')).toBe(20)
    expect(durationValue('三十五')).toBe(35)
    expect(durationValue('一百')).toBe(100)
  })

  it('handles the 零 placeholder inside a chinese numeral', () => {
    expect(durationValue('一百零二')).toBe(102)
  })

  it('returns null instead of guessing an unparseable form', () => {
    expect(durationValue('若干')).toBeNull()
    expect(durationValue('')).toBeNull()
    expect(durationValue('半')).toBeNull()
  })
})

describe('durationAnchors', () => {
  it('pairs a noun phrase with the duration in the same sentence', () => {
    const anchors = durationAnchors('温珩二十年不换靛蓝短褂，因为那正是周叙父亲落水那夜穿走的衣服。')
    expect(anchors.get('靛蓝短褂')?.has(20)).toBe(true)
    expect(anchors.get('周叙父亲')?.has(20)).toBe(true)
  })

  it('does not pair durations from different sentences', () => {
    const anchors = durationAnchors('周叙父亲失踪十年。温珩不换靛蓝短褂。')
    expect(anchors.get('靛蓝短褂')).toBeUndefined()
    expect(anchors.get('父亲失踪')?.has(10)).toBe(true)
  })
})

describe('findTimelineAnchorConflicts (issue #2)', () => {
  it('flags the reported ten-vs-twenty contradiction', () => {
    const hits = findTimelineAnchorConflicts(designSections(REPORTED))
    expect(hits).toHaveLength(1)
    expect(hits[0]!.durations).toEqual([10, 20])
    // 锚点要能定位到那段文字。
    expect(hits[0]!.anchors.some(anchor => anchor.includes('父亲'))).toBe(true)
    // 冲突跨了两段（世界观与角色图谱），这是这条 issue 的关键形态。
    expect(hits[0]!.sources).toContain('世界观')
    expect(hits[0]!.sources).toContain('角色图谱')
  })

  it('does not collapse the anchors into every overlapping substring', () => {
    const [hit] = findTimelineAnchorConflicts(designSections(REPORTED))
    // 「父亲」「落水」「父亲落水」会同时命中，只该保留最长的几个。
    expect(hit!.anchors.length).toBeLessThanOrEqual(3)
    expect(hit!.anchors).not.toContain('父')
    expect(hit!.anchors).not.toContain('亲')
  })

  it('stays silent when the durations agree', () => {
    expect(findTimelineAnchorConflicts(designSections({
      premise: '十年前父亲在同一航次落水失踪。',
      worldbuilding: '父亲的去向至今十年无人过问。',
      charactersArch: '周叙：穿衣。',
    }))).toEqual([])
  })

  it('does not compare durations that sit on different subjects', () => {
    // 「父亲落水十年前的成因」与「温珩二十年不换短褂」是两件事，不该判成冲突。
    expect(findTimelineAnchorConflicts(designSections({
      premise: '父亲十年前落水失踪。温珩二十年不换短褂。',
      worldbuilding: '',
      charactersArch: '',
    }))).toEqual([])
  })

  it('is structural: a different event and different numbers still fire', () => {
    // 换事件、换数值、换语言仍成立——判据不依赖「父亲」「落水」这些词。
    const hits = findTimelineAnchorConflicts(designSections({
      premise: '那场大火发生在三年前。',
      worldbuilding: '村落被大火焚毁已有三十年。',
      charactersArch: '',
    }))
    expect(hits).toHaveLength(1)
    expect(hits[0]!.durations).toEqual([3, 30])
  })

  it('ignores sections that are empty', () => {
    expect(designSections({ premise: '', worldbuilding: '  ', charactersArch: '' })).toEqual([])
  })

  it('keeps section labels so the finding can point at where to fix', () => {
    expect(designSections(REPORTED).map(section => section.label))
      .toEqual(['故事前提', '世界观', '角色图谱'])
  })
})

describe('findDesignTimelineConflicts (issue #2 finding shape)', () => {
  it('reports a locatable finding naming both passages and the anchor', () => {
    const findings = findDesignTimelineConflicts(REPORTED)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ severity: 'warning', sourceChapter: 1 })
    expect(findings[0]!.evidence).toContain('10 / 20')
    expect(findings[0]!.evidence).toContain('世界观')
    // 出路要告诉作者定哪一个锚，而不是「请保持一致」。
    expect(findings[0]!.suggestion.zhCN).toContain('先定一个权威年份')
    expect(findings[0]!.suggestion.zhCN).toContain('锚是')
    expect(findings[0]!.suggestion.enUS).toContain('Pick one authoritative date')
  })

  it('stays silent for a consistent design layer', () => {
    expect(findDesignTimelineConflicts({
      premise: '十年前父亲在同一航次落水失踪。',
      worldbuilding: '父亲的去向至今十年无人过问。',
      charactersArch: '',
    })).toEqual([])
  })

  it('caps the report so a messy design layer cannot flood the panel', () => {
    const messy = Array.from({ length: 8 }, (_, index) => `事件${index}发生在${index + 2}年前。`).join('')
    const later = Array.from({ length: 8 }, (_, index) => `事件${index}已过去${index + 20}年。`).join('')
    expect(findDesignTimelineConflicts({ premise: messy, worldbuilding: later, charactersArch: '' }).length)
      .toBeLessThanOrEqual(3)
  })
})
