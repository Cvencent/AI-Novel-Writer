import { describe, expect, it } from 'vitest'

import {
  designSections,
  durationAnchors,
  durationAnchorsWithSentences,
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

/**
 * issue #245 现场（作者实报）：第一章的设定层时间冲突「点修掉之后又弹回来」，
 * 删章重生成后还是它。
 *
 * 现场三条证据（真库 `源起`）：
 *  1. 作者其实**已经**按提示把两件事分开写明了（「明确区分为两件独立事件而非同一件事」
 *     「该手环硬件与固件虽已沿用迭代了 80 年，但阈值击穿与配发明确是 2 年前」），
 *     而判据只做结构共现、不读这些区分；
 *  2. 报给作者的建议里「锚是「层电离损」」——那不是一件事，是跨标点拼出来的碎片：
 *     旧实现把一句话里的**每个时间量撒给这句的每个窗口**，一句 80 字的话污染了
 *     201 个片段（实测），于是建议无法用来定位。
 *  3. key 直接拼锚点原文，而锚点是文本切片 → **作者越按建议改，key 越变**，
 *     之前的「我已知／确认无误」全部失效，于是它反复弹回来。
 */
describe('issue #245: 同句多个时间量不能污染整句的每个片段', () => {
  it('只把时间量贴给离它最近的片段，而不是撒给整句', () => {
    // 真库原句的形态：一句话里先给一个时间、再给另一个，各自绑着自己的事件。
    const sentence = '其一是血脉源于80年前首裂大灾变遗留的家族隐性突变，并在8年前遭遇高能粒子穿透诱发深层电离损伤'
    const anchors = durationAnchorsWithSentences(sentence)
    // 「大灾变」挨着 80，「粒子穿透」挨着 8——不该两者都沾上两个数。
    expect([...(anchors.get('大灾变') ?? [])].map(item => item.value)).toEqual([80])
    expect([...(anchors.get('粒子穿') ?? [])].map(item => item.value)).toEqual([8])
    // 旧实现在这句里会产出「变遗留的」「层电离损」这类跨标点碎片，且都带 2 个数。
    for (const token of anchors.keys()) {
      expect(anchors.get(token)!.length, token).toBe(1)
    }
  })

  it('同一句里写明「沿用 80 年，但配发是 2 年前」时不再当成同一件事被写了两个时间', () => {
    // 真库原句：作者已经把两个时间绑到不同对象上（硬件 vs 配发）。
    const anchors = durationAnchorsWithSentences('该手环硬件与固件虽已沿用迭代了80年，但阈值击穿与配发明确是2年前')
    // 「手环」「硬件」应当只贴到 80；「阈值击穿」「配发」只贴到 2。
    const values = (token: string) => [...(anchors.get(token) ?? [])].map(item => item.value)
    expect(values('手环')).toEqual([80])
    expect(values('配发')).toEqual([2])
  })

  it('仍然抓得住真正的跨句冲突（判据原文的形态）', () => {
    // 「落水」在两句里各配一个时间 —— 这才是要报的。
    const hits = findTimelineAnchorConflicts(designSections(REPORTED))
    expect(hits).toHaveLength(1)
    expect(hits[0]!.durations).toEqual([10, 20])
  })

  it('同一句里说了两个数、别处只说一个数时，不算跨句冲突', () => {
    // 「十年」与「二十年」都在同一句（作者在区分两件事），不该报。
    expect(findTimelineAnchorConflicts(designSections({
      premise: '父亲十年前落水失踪，温珩二十年不换那件短褂。',
      worldbuilding: '',
      charactersArch: '',
    }))).toEqual([])
  })
})

describe('issue #245: stableFactKey 不随措辞变化', () => {
  const BROKEN = {
    premise: '源于八十年前首裂大灾变遗留的家族隐性突变。八年前遭遇高能粒子穿透诱发深层电离损伤。',
    worldbuilding: '初入源起学院预备班并配发手环明确发生在两年前。手环本身虽为沿用八十年的旧制式。',
    charactersArch: '',
  }
  it('按建议重写后，同一条冲突的 key 仍然相同（否则 ack 会失效、卡片反复弹回）', () => {
    // 作者按提示拆成「事件甲/乙/丙」并写明区分——数值结论没变，只是措辞变了。
    const rewritten = {
      premise: '事件甲（八十年前）：首裂大灾变遗留的家族隐性突变。事件乙（八年前）：林澈遭遇高能粒子穿透，诱发深层电离损伤（与甲不同）。',
      worldbuilding: '事件丙：两年前入班配发手环，此为独立事件而非甲。该手环硬件沿用八十年旧制式，但配发明确是两年前。',
      charactersArch: '',
    }
    const before = findDesignTimelineConflicts(BROKEN).map(finding => finding.stableFactKey)
    const after = findDesignTimelineConflicts(rewritten).map(finding => finding.stableFactKey)
    expect(after.filter(key => before.includes(key))).not.toEqual([])
  })

  it('key 只认结构性身份（哪几个数值 × 哪几段），不含文本切片', () => {
    const [finding] = findDesignTimelineConflicts(BROKEN)
    expect(finding!.stableFactKey).toMatch(/^timeline:design-anchor:[\d/]+:[^|]+(?:\|[^|]+)*$/u)
    expect(finding!.stableFactKey).not.toContain('大灾变')
    expect(finding!.stableFactKey).not.toContain('变遗留的')
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
