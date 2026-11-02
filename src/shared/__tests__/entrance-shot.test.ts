import { describe, expect, it } from 'vitest'

import {
  ENTRANCE_COMMON_MIN,
  characterEntrances,
  findRepeatedEntranceShots,
  longestCommonSubstring,
  stripForComparison,
} from '../entrance-shot'

/** issue #81 报告里的原文（照抄，把判据钉在真实样本上）。 */
const CH9 = '舱门口有赤脚踩木板的声响。温珩站在那儿，靛蓝短褂下摆往下滴。'
const CH10 = '舱门口有赤脚踩木板的声响。温珩站在那儿。靛蓝短褂，没出声。'
const CH12 = '温珩站在梯口，赤脚，靛蓝短褂下摆还滴着水。'
const CH13 = '温珩站在梯口，赤脚，短褂下摆滴水。'
const CH14 = '温珩站在舱门口，赤脚，靛蓝短褂的下摆还湿着。'

const chapters = (specs: ReadonlyArray<[number, string]>) =>
  specs.map(([chapterNumber, content]) => ({ chapterNumber, content }))

describe('stripForComparison / longestCommonSubstring', () => {
  it('drops punctuation and whitespace so 逐字 is literal', () => {
    expect(stripForComparison('温珩站在梯口，赤脚。')).toBe('温珩站在梯口赤脚')
  })

  it('finds the longest literal run without caring about word boundaries', () => {
    // 两边先各自去标点，再比字面——所以这里用已剥离的形态比较才有意义。
    expect(longestCommonSubstring(stripForComparison('温珩站在梯口，赤脚'), stripForComparison('温珩站在梯口赤脚，没出声')))
      .toBe('温珩站在梯口赤脚')
    expect(longestCommonSubstring('abcd', 'xyz')).toBe('')
    expect(longestCommonSubstring('', 'abc')).toBe('')
  })
})

describe('characterEntrances', () => {
  it('takes the paragraph where the character first appears', () => {
    const [entrance] = characterEntrances(
      chapters([[12, '第一段没提到他。\n\n' + CH12 + '\n\n温珩又出现了。']]),
      ['温珩'],
    )
    expect(entrance).toMatchObject({ character: '温珩', chapterNumber: 12, sentenceIndex: 2 })
    expect(entrance!.sentence).toBe(CH12)
  })

  it('records each character once per chapter even when a paragraph names two', () => {
    const entrances = characterEntrances(
      chapters([[1, '周叙和温珩一起走进来。']]),
      ['周叙', '温珩'],
    )
    expect(entrances.map(item => item.character).sort()).toEqual(['周叙', '温珩'])
  })

  it('ignores chapters with no cast mention', () => {
    expect(characterEntrances(chapters([[1, '船舱里没有人。']]), ['温珩'])).toEqual([])
  })
})

describe('findRepeatedEntranceShots (issue #81)', () => {
  it('reproduces the 22-character verbatim pair ch9 ↔ ch10', () => {
    const hits = findRepeatedEntranceShots(
      chapters([[9, CH9], [10, CH10]]),
      { castNames: ['温珩'] },
    )
    expect(hits).toHaveLength(1)
    expect(hits[0]!.character).toBe('温珩')
    expect(hits[0]!.chapters).toEqual([9, 10])
    // 报告实测：去标点后 22 字逐字。
    expect(hits[0]!.commonSubstring).toBe('舱门口有赤脚踩木板的声响温珩站在那儿靛蓝短褂')
    expect(hits[0]!.commonSubstring.length).toBe(22)
  })

  it('catches the three-chapter pattern that only swaps a function word', () => {
    const hits = findRepeatedEntranceShots(
      chapters([[12, CH12], [13, CH13], [14, CH14]]),
      { castNames: ['温珩'] },
    )
    expect(hits).toHaveLength(1)
    expect(hits[0]!.chapters.length).toBeGreaterThanOrEqual(2)
    expect(hits[0]!.commonSubstring.length).toBeGreaterThanOrEqual(ENTRANCE_COMMON_MIN)
  })

  it('is word-list free: a different character and different clothing still fire', () => {
    // 不枚举「赤脚/靛蓝短褂」——换人物、换衣饰照样命中（判据是字面相似度）。
    const hits = findRepeatedEntranceShots(chapters([
      [4, '邵广海进来，绸褂敞着领口，手里捏着烟盒。'],
      [12, '邵广海已经站在柜台前，绸褂敞着领口，手里捏着烟盒。'],
    ]), { castNames: ['邵广海'] })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.commonSubstring).toContain('绸褂敞着领口')
  })

  it('does not compare different characters against each other', () => {
    // 同一句被两个不同角色用——那是另一类问题，本条只按角色归一。
    const hits = findRepeatedEntranceShots(chapters([
      [1, '温珩站在梯口，赤脚，靛蓝短褂下摆滴水。'],
      [2, '周叙站在梯口，赤脚，靛蓝短褂下摆滴水。'],
    ]), { castNames: ['温珩', '周叙'] })
    expect(hits).toEqual([])
  })

  it('stays silent for genuinely varied entrances', () => {
    const hits = findRepeatedEntranceShots(chapters([
      [1, '温珩肩上搭着那件洗白的短褂，从雨里走进来。'],
      [2, '温珩把缆绳甩上桩，回头看了一眼舱口。'],
      [3, '温珩端着碗蹲在灶边，半天没抬头。'],
    ]), { castNames: ['温珩'] })
    expect(hits).toEqual([])
  })

  it('does not bridge entrances that are too far apart', () => {
    // 隔得远时读者早已接受，不再读作同构。
    expect(findRepeatedEntranceShots(chapters([
      [1, CH9], [30, CH10],
    ]), { castNames: ['温珩'] })).toEqual([])
  })

  it('reports nothing without a cast roster', () => {
    expect(findRepeatedEntranceShots(chapters([[9, CH9], [10, CH10]]))).toEqual([])
  })
})
