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
