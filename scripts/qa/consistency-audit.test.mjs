/**
 * 一致性检查器颜色识别回归（issue #9）：
 * 全词表时代「洗白的靛蓝短褂」0 命中却输出「无冲突」（假阴性）。
 * 语素扫描后必须命中复合色，且状态色（泛白/发白）不与固定色互判。
 */
import { describe, expect, it } from 'vitest'

import { extractMentions, findConflicts, outfitColorFor, scanHueColors } from './consistency-audit.mjs'

const CH1 = '温珩伏案抄录，洗白的靛蓝短褂袖口搭在纸面上。'
const CH3 = '温珩坐在角落，靛蓝短褂洗得发白。'
const CH4A = '温珩的靛蓝短褂映着灯，又浅了一层。'
const CH4B = '温珩那件靛蓝短褂褪得跟纸一个色。'
const CH5 = '温珩换了件月白长衫走进来。'

const chaptersOf = (...bodies) => bodies.map((body, index) => ({ chapterNumber: index + 1, body }))

describe('issue #9 复合色命中', () => {
  it('「洗白的靛蓝短褂」命中靛蓝（hue），洗白归入 faded 不参与互斥', () => {
    const found = outfitColorFor(CH1, '靛蓝', CH1.indexOf('靛蓝'))
    expect(found.hues).toContain('靛蓝')
    expect(found.hues).not.toContain('洗白')
  })

  it('语素扫描兜底全词表外的复合色（月白/黛青/赭黄）', () => {
    expect(scanHueColors('月白长衫')).toContain('月白')
    expect(scanHueColors('黛青的披风')).toContain('黛青')
    expect(scanHueColors('赭黄袖口')).toContain('赭黄')
  })

  it('issue 抽样的四句全部进入 mentions（此前 0 命中）', () => {
    const mentions = extractMentions(chaptersOf(CH1, '与温珩无关的一段。', CH3, CH4A), ['温珩'])
    expect(mentions.filter(mention => mention.attribute === 'outfit')).toHaveLength(3)
    for (const mention of mentions.filter(mention => mention.attribute === 'outfit')) {
      expect(mention.colors).toContain('靛蓝')
    }
  })

  it('同一角色同色系跨章不报冲突；换色（月白）报硬冲突', () => {
    const same = extractMentions(chaptersOf(CH1, CH3, CH4A, CH4B), ['温珩'])
    expect(findConflicts(same)).toHaveLength(0)

    const changed = extractMentions(chaptersOf(CH1, CH5), ['温珩'])
    const conflicts = findConflicts(changed)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].evidence.map(item => item.value).sort()).toEqual(['月白', '靛蓝'])
  })

  it('「白色」与「洗得发白」不算互斥（状态色不与固定色互判）', () => {
    const mentions = extractMentions(chaptersOf('老周穿一件白色外勤服站岗。', '老周的外勤服洗得发白。'), ['老周'])
    const conflicts = findConflicts(mentions)
    expect(conflicts).toHaveLength(0)
    // 白色（hue）与发白（faded）都留了证据。
    const hues = mentions.flatMap(mention => mention.colors)
    const faded = mentions.flatMap(mention => mention.fadedColors ?? [])
    expect(hues).toContain('白色')
    expect(faded).toContain('发白')
  })

  it('非颜色语素的段落（白纸/ gradients）不误报衣着色', () => {
    const mentions = extractMentions(chaptersOf('温珩把白纸压平，指关节微微泛白。'), ['温珩'])
    // 段内没有衣着词：不产生衣着 mention（「泛白」单独出现也不算衣着取色）。
    expect(mentions.filter(mention => mention.attribute === 'outfit')).toHaveLength(0)
  })
})

/**
 * issue #30：假阳性 —— 检查器把「底册封面是深蓝硬布」记成周叙的衣着。
 * 根因两条：① 颜色词自己就算衣着（没有衣物名词邻接）；② 归属取「段落里最后一个名字」。
 * 修的时候必须同时守住 #9 那一侧（「洗白的靛蓝短褂」仍要命中）。
 */
describe('issue #30 宾语 / 主语归属', () => {
  it('「底册封面是深蓝硬布」不产生任何衣着 mention', () => {
    const body = '新底册的封面是深蓝硬布，边角压得平整。周叙翻开内页，纸页泛旧。'
    const mentions = extractMentions(chaptersOf(body), ['周叙'])
    expect(mentions.filter(mention => mention.attribute === 'outfit')).toHaveLength(0)
  })

  it('同一段里颜色修饰的是旁观者的衣服时，归给衣服的主人而不是段末名字', () => {
    const body = '温珩的靛蓝短褂下摆滴着水，周叙站在一旁看着。'
    const mentions = extractMentions(chaptersOf(body), ['温珩', '周叙'])
    const outfits = mentions.filter(mention => mention.attribute === 'outfit')
    expect(outfits).toHaveLength(1)
    expect(outfits[0].character).toBe('温珩')
    expect(outfits[0].colors).toContain('靛蓝')
  })

  it('#9 那一侧不能被修坏：紧邻衣物名词的复合色仍要命中', () => {
    for (const [body, color] of [
      ['温珩伏案抄录，洗白的靛蓝短褂袖口搭在纸面上。', '靛蓝'],
      ['温珩坐在角落，靛蓝短褂洗得发白。', '靛蓝'],
      ['温珩换了件月白长衫走进来。', '月白'],
      ['老周穿一件白色外勤服站岗。', '白色'],
    ]) {
      const outfits = extractMentions(chaptersOf(body), ['温珩', '老周']).filter(mention => mention.attribute === 'outfit')
      expect(outfits, body).toHaveLength(1)
      expect(outfits[0].colors, body).toContain(color)
    }
  })

  it('真冲突仍然报：同一人不同章穿互斥色', () => {
    const mentions = extractMentions(chaptersOf(
      '温珩的靛蓝短褂下摆滴着水。',
      '温珩换了件月白长衫走进来。',
    ), ['温珩'])
    expect(findConflicts(mentions)).toHaveLength(1)
  })
})

/**
 * issue #43：单字色全部漏报——「灰风衣 vs 靛蓝短褂」判 ✓ 无冲突。
 * 根因是 HUE_COLOR 的两条分支都要求至少两个字；中文里「灰风衣」比「灰色的风衣」更自然，
 * 于是工具在最该命中的写法上系统性失明。修的时候必须守住 #30（深蓝硬布不是衣着）。
 */
describe('issue #43 单字色', () => {
  const ch1 = '周叙穿一件靛蓝短褂。'

  it('「灰风衣」必须与「靛蓝短褂」报冲突', () => {
    const mentions = extractMentions(chaptersOf(ch1, '周叙穿灰风衣。'), ['周叙'])
    const conflicts = findConflicts(mentions)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].summary).toContain('灰')
    expect(conflicts[0].summary).toContain('靛蓝')
  })

  it('其余典型单字写法也都能命中', () => {
    for (const sentence of ['周叙穿白风衣。', '周叙穿黑风衣。', '周叙穿灰短褂。', '周叙穿青长衫。', '周叙换了件灰短褂。', '周叙身上那件风衣是灰的。']) {
      const mentions = extractMentions(chaptersOf(ch1, sentence), ['周叙'])
      expect(findConflicts(mentions), sentence).toHaveLength(1)
    }
  })

  it('「灰色风衣」与「灰风衣」是同一色，不得互判为冲突', () => {
    const mentions = extractMentions(chaptersOf('周叙穿灰风衣。', '周叙穿灰色风衣。'), ['周叙'])
    expect(findConflicts(mentions)).toHaveLength(0)
  })

  it('#30 那一侧不能被修坏：物件色不算衣着', () => {
    for (const sentence of ['新底册的封面是深蓝硬布。周叙翻开内页。', '周叙把白纸压平，指关节微微泛白。', '周叙提着黑灯走过。']) {
      const mentions = extractMentions(chaptersOf(sentence), ['周叙'])
      expect(mentions.filter(mention => mention.attribute === 'outfit'), sentence).toHaveLength(0)
    }
  })

  it('两字色的写法仍然正常（守 #9）', () => {
    const mentions = extractMentions(chaptersOf('周叙穿一件靛蓝短褂。', '周叙穿深蓝外套。'), ['周叙'])
    expect(findConflicts(mentions)).toHaveLength(1)
  })
})
