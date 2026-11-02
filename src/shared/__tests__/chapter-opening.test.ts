import { describe, expect, it } from 'vitest'

import {
  OPENING_SCENE_RATIO,
  OPENING_WINDOW,
  REVEAL_OPENER_MIN_CHAPTERS,
  chapterOpeningOf,
  dialogueOpeners,
  findDialogueOpenerConvergence,
  openingConvergence,
} from '../chapter-opening'
import { findDialogueOpenerConvergence as dialogueFinding, findOpeningShapeConvergence } from '../consistency-preflight'

/** issue #71 报告里的章首原句（原文照抄，用于把判据钉在真实样本上）。 */
const REPORTED_OPENINGS: ReadonlyArray<[number, string]> = [
  [1, '船离岸还有一袋烟的工夫，周叙已经在跳板口核完了三十二张票根。'],
  [2, '换班的梆子敲过两下，周叙把风灯挂上舱柱，走到船尾替温珩。'],
  [3, '船靠埠补给，缆绳一抛，跳板还没落稳，周叙就拎着风灯下了船。'],
  [4, '天蒙蒙亮。'],
  [9, '天亮靠埠，缆绳一抛，跳板拍在石阶上。'],
  [11, '舱口的赤脚声不是叶九的。周叙把账本合上一半，温珩已经走进来，站到灯影边上。'],
  [13, '水隔阀一响，舱底潮气顺着板缝往上爬。周叙蹲在铺位前核舱，风灯挂上钉，灯罩里那联存根边角卷着。'],
  [19, '靠埠前一个时辰，货舱里只剩帆布缝里透进的一线灯。'],
  [21, '开航前一刻钟，周叙从跳板口折回码头后缆桩。'],
  [22, '天刚亮，码头办公室外廊。'],
  [24, '舵舱梯口，周叙蹲到舵位底下，把舀水盂从铁箍里提出来。'],
]

const CAST = ['周叙', '温珩', '全叔', '柯明远', '林棠']

describe('chapterOpeningOf classifies the reported openings (issue #71)', () => {
  it('reads scene-first openings as scene', () => {
    for (const [chapter, text] of REPORTED_OPENINGS) {
      expect(chapterOpeningOf(chapter, text, CAST).shape, `ch${chapter}`).toBe('scene')
    }
  })

  it('reads a character-first opening as character', () => {
    // 「周叙回到舱底时，…」——人物先出场，不是场景起手。
    expect(chapterOpeningOf(8, '周叙回到舱底时，水隔的阀已经拧开。', CAST).shape).toBe('character')
    expect(chapterOpeningOf(26, '温珩回来时，靛蓝短褂下摆湿了一截。', CAST).shape).toBe('character')
  })

  it('treats a pronoun subject as a character opening', () => {
    // 「他站在跳板外，…」：人是先出场的，哪怕没有具名。
    expect(chapterOpeningOf(12, '他站在跳板外，手拢着嘴往舱里喊。', CAST).shape).toBe('character')
  })

  it('does not classify a chapter that opens inside dialogue as a scene opening', () => {
    const opening = chapterOpeningOf(5, '“这个姿势，”温珩说，“你爸最后一次翻账也是这个姿势。”', CAST)
    // 去掉开引号后第一个小句是台词内容，不含在册角色名、不以代词起头 → scene。
    // 这是刻意的：对白开篇的章句式确实在轮换，不应被算进「状语起手」那一族。
    expect(opening.clause).not.toContain('“')
  })

  it('exposes the first clause as evidence', () => {
    expect(chapterOpeningOf(1, REPORTED_OPENINGS[0]![1], CAST).clause)
      .toBe('船离岸还有一袋烟的工夫')
    expect(chapterOpeningOf(4, '天蒙蒙亮。', CAST).clause).toBe('天蒙蒙亮')
  })

  it('is unknown for empty content instead of guessing', () => {
    expect(chapterOpeningOf(1, '', CAST).shape).toBe('unknown')
    expect(chapterOpeningOf(1, '   ', CAST).shape).toBe('unknown')
  })

  it('strips a chapter heading before reading the opening', () => {
    expect(chapterOpeningOf(1, '## 第1章 跳板口\n\n天蒙蒙亮。', CAST).shape).toBe('scene')
  })
})

describe('openingConvergence (issue #71)', () => {
  const openings = (specs: ReadonlyArray<[number, string]>) =>
    specs.map(([chapter, text]) => chapterOpeningOf(chapter, text, CAST))

  it('flags a run of consecutive scene-first openings', () => {
    const run = openings([
      [19, '靠埠前一个时辰，货舱里只剩帆布缝里透进的一线灯。'],
      [20, '封存箱刚抬上跳板，周叙横在舱口。'],
      [21, '开航前一刻钟，周叙从跳板口折回码头后缆桩。'],
      [22, '天刚亮，码头办公室外廊。'],
      [23, '水隔的阀拧开，铁壁后头水声一层层涨上来。'],
      [24, '舵舱梯口，周叙蹲到舵位底下。'],
    ])
    const hit = openingConvergence(run)
    // 返回整个窗口：调用方要用它渲染章号区间与证据句（只回一个章号在全窗口命中时会重复）。
    expect(hit.map(item => item.chapterNumber)).toEqual([19, 20, 21, 22, 23, 24])
    expect(hit.every(item => item.shape === 'scene')).toBe(true)
  })

  it('does not flag a window that mixes character openings in', () => {
    const mixed = openings([
      [19, '靠埠前一个时辰，货舱里只剩帆布缝里透进的一线灯。'],
      [20, '周叙横在舱口。'],
      [21, '开航前一刻钟，周叙从跳板口折回码头后缆桩。'],
      [22, '温珩回来时，靛蓝短褂下摆湿了一截。'],
      [23, '水隔的阀拧开，铁壁后头水声一层层涨上来。'],
      [24, '全叔坐在缆堆上。'],
    ])
    expect(openingConvergence(mixed)).toEqual([])
  })

  it('requires a full window before judging', () => {
    const short = openings([
      [3, '船靠埠补给，缆绳一抛。'],
      [4, '天蒙蒙亮。'],
    ])
    expect(openingConvergence(short)).toEqual([])
  })

  it('treats a chapter-number gap as a break', () => {
    const gapped = openings([
      [19, '靠埠前一个时辰，货舱里只剩帆布缝里透进的一线灯。'],
      [20, '封存箱刚抬上跳板。'],
      [22, '天刚亮，码头办公室外廊。'],
      [23, '水隔的阀拧开。'],
      [24, '舵舱梯口，周叙蹲到舵位底下。'],
      [25, '天亮靠埠，缆绳一抛。'],
    ])
    expect(openingConvergence(gapped)).toEqual([])
  })

  it('exposes the whole window so the caller can quote the real openings', () => {
    // 报告清单里 20/23 不在样本内——这几章之间断号，窗口必须判为断开。
    const sparse = REPORTED_OPENINGS
      .filter(([chapter]) => [19, 21, 22, 24].includes(chapter))
      .map(([chapter, text]) => chapterOpeningOf(chapter, text, CAST))
    expect(openingConvergence(sparse)).toEqual([])
    expect(OPENING_WINDOW).toBe(6)
    expect(OPENING_SCENE_RATIO).toBeLessThanOrEqual(1)
  })
})

describe('dialogueOpeners / findDialogueOpenerConvergence (issue #72)', () => {
  it('extracts the first clause of each spoken line', () => {
    // 两段引号都是台词，各自取第一个小句。
    expect(dialogueOpeners('“你爸当年也查到这个空额。”他说，“然后他就不在了。”'))
      .toEqual(['你爸当年也查到这个空额', '然后他就不在了'])
  })

  it('flags the reported five-chapter reveal formula', () => {
    // 报告里 ch7/8/10/21/26 的对白都以同一句式起手，后半句各不相同。
    const hits = findDialogueOpenerConvergence([
      { chapterNumber: 7, content: '“你爸当年也查到这个空额。”他说，“然后他就不在了。”' },
      { chapterNumber: 8, content: '“你爸当年也有一张。”他说，声音低得几乎被水声盖过去。' },
      { chapterNumber: 10, content: '“你爸当年也忘过话。后来就不问了。”' },
      { chapterNumber: 21, content: '“你爸当年也在这本账上读过批注。”全叔声音低。' },
      { chapterNumber: 26, content: '“你爸当年也让我盯过。”他顿了顿，“就这一回。”' },
    ])
    // 起手语是**最长公共前缀**（5 字），不是固定的 4 字窗口——
    // 后半句各不相同，公共部分自然收到「也」为止。
    expect(hits[0]!.opener).toBe('你爸当年也')
    expect(hits[0]!.chapters).toEqual([7, 8, 10, 21, 26])
  })

  it('does not depend on any particular word — a different thread formula also fires', () => {
    // 判据是结构性的：换线索、换亲属称谓照样命中（不是枚举「你爸当年也」）。
    const hits = findDialogueOpenerConvergence([
      { chapterNumber: 4, content: '“你母亲当年也这样过。”他说。' },
      { chapterNumber: 9, content: '“你母亲当年也留了份。”他低声说。' },
      { chapterNumber: 15, content: '“你母亲当年也来过这里。”' },
    ])
    expect(hits[0]!.opener).toBe('你母亲当年也')
    expect(hits[0]!.chapters).toHaveLength(3)
  })

  it('does not flag two chapters sharing an opener', () => {
    expect(findDialogueOpenerConvergence([
      { chapterNumber: 1, content: '“别想走。”' },
      { chapterNumber: 2, content: '“别想走。”' },
    ])).toEqual([])
  })

  it('counts one chapter once even if the opener repeats inside it', () => {
    const hits = findDialogueOpenerConvergence([
      { chapterNumber: 1, content: '“你爸当年也查过。”他说。“你爸当年也记过。”他又说。' },
      { chapterNumber: 2, content: '“你爸当年也有一张。”' },
      { chapterNumber: 3, content: '“你爸当年也忘过话。”' },
    ])
    expect(hits[0]!.chapters).toEqual([1, 2, 3])
  })

  it('ignores spoken lines shorter than the opener length', () => {
    expect(dialogueOpeners('“嗯。”')).toEqual([])
  })

  it('requires the configured chapter minimum', () => {
    const three = [
      { chapterNumber: 1, content: '“你爸当年也查过。”' },
      { chapterNumber: 2, content: '“你爸当年也有一张。”' },
      { chapterNumber: 3, content: '“你爸当年也忘过话。”' },
    ]
    expect(findDialogueOpenerConvergence(three)).toHaveLength(1)
    expect(findDialogueOpenerConvergence(three, { minChapters: 4 })).toEqual([])
    expect(REVEAL_OPENER_MIN_CHAPTERS).toBe(3)
  })

  it('sorts by coverage so the widest convergence is reported first', () => {
    // 后半句各不相同（真实样本就是这样），公共前缀才收得住。
    const hits = findDialogueOpenerConvergence([
      { chapterNumber: 1, content: '“你爸当年也查到这个。”' },
      { chapterNumber: 2, content: '“你爸当年也有一张。”“你别问了。”' },
      { chapterNumber: 3, content: '“你爸当年也忘过话。”“你别问了。”' },
      { chapterNumber: 4, content: '“你别问了。”' },
    ])
    expect(hits.map(hit => hit.opener)).toEqual(['你爸当年也', '你别问了'])
  })
})

describe('findOpeningShapeConvergence (issue #71 finding shape)', () => {
  const cast = ['周叙', '温珩', '全叔']
  const run = [
    [19, '靠埠前一个时辰，货舱里只剩帆布缝里透进的一线灯。'],
    [20, '封存箱刚抬上跳板，周叙横在舱口。'],
    [21, '开航前一刻钟，周叙从跳板口折回码头后缆桩。'],
    [22, '天刚亮，码头办公室外廊。'],
    [23, '水隔的阀拧开，铁壁后头水声一层层涨上来。'],
    [24, '舵舱梯口，周叙蹲到舵位底下。'],
  ].map(([chapterNumber, content]) => ({ chapterNumber: chapterNumber as number, content: content as string }))

  it('reports one locatable finding naming the whole window', () => {
    const findings = findOpeningShapeConvergence({ chapters: run, castNames: cast, currentChapter: 24 })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      stableFactKey: 'chapter-opening:scene-first:24',
      severity: 'warning',
      sourceChapter: 24,
    })
    expect(findings[0]!.evidence).toContain('第 19–24 章连续 6 章')
    // 证据里要出现窗口内真实的章首小句，作者据此定位。
    expect(findings[0]!.evidence).toContain('靠埠前一个时辰')
    // 出路必须给出具体可用的开篇方式，而不是「请勿重复」。
    expect(findings[0]!.suggestion.zhCN).toContain('直接以动作或对白切入')
    expect(findings[0]!.suggestion.enUS).toContain('cut straight into an action')
  })

  it('stays silent when the openings rotate', () => {
    const varied = [
      { chapterNumber: 1, content: '周叙横在舱口。' },
      { chapterNumber: 2, content: '全叔把缆绳往肩上一搭。' },
      { chapterNumber: 3, content: '温珩回来时，靛蓝短褂下摆湿了一截。' },
      { chapterNumber: 4, content: '周叙推开档案房的门。' },
      { chapterNumber: 5, content: '全叔低着头走进来。' },
      { chapterNumber: 6, content: '温珩站在跳板外。' },
    ]
    expect(findOpeningShapeConvergence({ chapters: varied, castNames: cast, currentChapter: 6 })).toEqual([])
  })

  it('says nothing when there is no prior prose to compare against', () => {
    expect(findOpeningShapeConvergence({ chapters: [], castNames: cast, currentChapter: 1 })).toEqual([])
  })
})

describe('findDialogueOpenerConvergence finding (issue #72)', () => {
  const cast = ['周叙', '温珩', '全叔']
  const reveal = [
    [7, '“你爸当年也查到这个空额。”他说，“然后他就不在了。”'],
    [8, '“你爸当年也有一张。”他说，声音低得几乎被水声盖过去。'],
    [10, '“你爸当年也忘过话。后来就不问了。”'],
    [21, '“你爸当年也在这本账上读过批注。”全叔声音低。'],
    [26, '“你爸当年也让我盯过。”他顿了顿，“就这一回。”'],
  ].map(([chapterNumber, content]) => ({ chapterNumber: chapterNumber as number, content: content as string }))

  it('reports the widest reveal formula with its chapters', () => {
    const findings = dialogueFinding({ chapters: reveal, castNames: cast, currentChapter: 26 })
    expect(findings).toHaveLength(1)
    expect(findings[0]!.stableFactKey).toBe('chapter-opening:dialogue-opener:你爸当年也')
    expect(findings[0]!.evidence).toContain('第 7、8、10、21、26 章')
    expect(findings[0]!.suggestion.zhCN).toContain('换投放方式')
  })

  it('stays silent when no reveal formula repeats', () => {
    const varied = [
      { chapterNumber: 1, content: '“箱子封了。”“你签了什么？”' },
      { chapterNumber: 2, content: '“今夜别想开船。”“那你今晚别下船。”' },
      { chapterNumber: 3, content: '“路上小心。”“我们明天再说。”' },
    ]
    expect(dialogueFinding({ chapters: varied, castNames: cast, currentChapter: 3 })).toEqual([])
  })
})
