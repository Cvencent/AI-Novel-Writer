import { describe, expect, it } from 'vitest'

import {
  ENTRANCE_COMMON_MIN,
  ENTRANCE_MAX_GAP,
  ENTRANCE_WINDOW_CHAPTERS,
  characterEntrances,
  findRepeatedEntranceShots,
  isEntranceParagraph,
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

  // issue #87 根因：旧判据取「本章第一个提到该名字的段」，于是「先提名、后到场」
  // （回忆、他人台词里点名）会把真正的登场段整段跳过。实测那本书 ch7/ch9 就是这样。
  it('takes the ACTUAL entrance paragraph, not the first paragraph that merely names them (issue #87)', () => {
    const [entrance] = characterEntrances(chapters([[7,
      // 回忆引述：先提到名字，人不在场。
      '他手停住了。温珩说“一直空着”。\n\n'
      // 实体登场：名字 + 进场动作 + 穿戴同段。
      + '温珩站在舱门口，赤脚，靛蓝短褂下摆垂着。']]), ['温珩'])
    expect(entrance!.sentenceIndex).toBe(2)
    expect(entrance!.sentence).toContain('站在舱门口')
    expect(entrance!.sentence).not.toContain('一直空着')
  })

  it('also skips a paragraph that only names them inside someone else’s line (issue #87)', () => {
    const [entrance] = characterEntrances(chapters([[9,
      '“是从水里捞上来的。”全叔把绳梢塞进绳圈，“原本不属于温珩。”\n\n'
      + '舱门口有赤脚踩木板的声响。温珩站在那儿，靛蓝短褂下摆往下滴。']]), ['温珩'])
    expect(entrance!.sentenceIndex).toBe(2)
    expect(entrance!.sentence).toContain('舱门口有赤脚踩木板的声响')
  })

  it('falls back to the first mention when the chapter never shows them entering', () => {
    // 保底：有的章确实只靠对白/回忆交代一个角色，那也仍是本章给他的位置。
    const [entrance] = characterEntrances(chapters([[3, '他记得温珩说过一句话。']]), ['温珩'])
    expect(entrance!.sentenceIndex).toBe(1)
    expect(entrance!.sentence).toContain('温珩')
  })

  it('does not treat a naming with neither action nor dress as an entrance', () => {
    // 判据三条缺一不可：名字 + 进场动作 + 穿戴/随身物。
    expect(isEntranceParagraph('他记得温珩说过话。', '温珩')).toBe(false)
    expect(isEntranceParagraph('温珩站在门口。', '温珩')).toBe(false) // 无穿戴
    expect(isEntranceParagraph('靛蓝短褂下摆垂着。', '温珩')).toBe(false) // 无人名
    expect(isEntranceParagraph('温珩站在舱门口，赤脚，靛蓝短褂下摆垂着。', '温珩')).toBe(true)
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

  // issue #87：写前预检传的是**全部在册角色**，而旧实现末尾直接 `.slice(0, 4)`——
  // 同一个角色的多组会把别的角色整组挤掉（实测全名册只出 4 组、逐角色能出 7 组）。
  it('gives every character a slot before a second group from the same character (issue #87)', () => {
    // 实测形状：那本书全名册调用只出 4 组、**整段丢掉了林棠这个角色**，
    // 因为它的一组被温珩的两组（子串更长、排名更前）挤出了 `.slice(0, 4)`。
    // 这里照这个形状搭：温珩两组排最前，另外四个角色各一组。
    const long1 = '温珩站在梯口，赤脚，靛蓝短褂的袖口卷到肘弯，手里攥着缆绳。'
    const long2 = '温珩站在舱门口，赤脚，靛蓝短褂的下摆还湿着，手里攥着缆绳。'
    const book = chapters([
      [1, long1], [5, long1],           // 温珩组一（子串最长 → 排第 1）
      [12, long2], [13, long2],          // 温珩组二（子串次长 → 排第 2，与组一相隔 11 章不算同一链）
      [3, '邵广海靠着柜台，绸褂敞着领口。'], [9, '邵广海靠着柜台，绸褂敞着领口。'],
      [4, '林棠蹲在台阶上，指尖染着复写纸的紫。'], [10, '林棠蹲在台阶上，指尖染着复写纸的紫。'],
      [6, '全叔蹲在桩边，旧油布围裙歪到一边。'], [11, '全叔蹲在桩边，旧油布围裙歪到一边。'],
      [7, '柯明远夹着黑皮公文包，袖口扣得整齐。'], [14, '柯明远夹着黑皮公文包，袖口扣得整齐。'],
    ])
    const names = ['温珩', '邵广海', '林棠', '全叔', '柯明远']
    const hits = findRepeatedEntranceShots(book, { castNames: names })
    // 五个角色一个都不能少——旧实现会在这里丢掉一个（实测丢的是林棠）。
    expect(new Set(hits.map(hit => hit.character))).toEqual(new Set(names))
    // 且每个角色的第一组先占名额，温珩的第二组排在所有角色的首组之后。
    expect(hits.slice(0, 5).map(hit => hit.character))
      .toEqual(expect.arrayContaining(names))
  })
})

// issue #92：判据允许相隔 `ENTRANCE_MAX_GAP`(=8) 章配对、链子还能更长，
// 而写前预检原来硬编码 `slice(-10)` —— 实测 39 章的书**全书 7 组**、10 章窗口 **0 组**。
// 窗口滑过去就永久静音，而预检标题仍显示正数条数（作者以为检查过了）。
describe('the caller window must cover the judge semantics (issue #92)', () => {
  it('exposes a window that is at least 2×ENTRANCE_MAX_GAP so a multi-link chain fits', () => {
    expect(ENTRANCE_WINDOW_CHAPTERS).toBeGreaterThanOrEqual(ENTRANCE_MAX_GAP * 2)
  })

  it('keeps a two-link chain that a 10-chapter window would cut', () => {
    // 复现那本书的形状：同一角色在第 7、12、14 章各登场一次（相邻间隔 ≤ ENTRANCE_MAX_GAP），
    // 后面还有 12 章别的戏。只喂最近 10 章会把第 7 章切掉、第一对配对随之消失。
    const book = chapters([
      [7, '温珩站在舱门口，赤脚，靛蓝短褂下摆垂着。'],
      [12, '温珩站在梯口，赤脚，靛蓝短褂。'],
      [14, '温珩站在舱门口，赤脚，靛蓝短褂的下摆还湿着。'],
      ...Array.from({ length: 12 }, (_, index) => [15 + index, `第${15 + index}章：别人在做别的事。`] as [number, string]),
    ])
    const full = findRepeatedEntranceShots(book, { castNames: ['温珩'] })
    expect(full.length).toBeGreaterThan(0)
    expect(full[0]!.chapters).toContain(7)

    // 旧窗口（10 章）看不到第 7 章——那条链的第一环已经滑出窗口。
    const narrowed = findRepeatedEntranceShots(book.slice(-10), { castNames: ['温珩'] })
    expect(narrowed.every(hit => !hit.chapters.includes(7))).toBe(true)

    // 新窗口覆盖到第 7 章。
    const widened = findRepeatedEntranceShots(book.slice(-ENTRANCE_WINDOW_CHAPTERS), { castNames: ['温珩'] })
    expect(widened.some(hit => hit.chapters.includes(7))).toBe(true)
  })
})
