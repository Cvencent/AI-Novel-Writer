import { describe, expect, it } from 'vitest'

import {
  classifyOpener,
  findParagraphOpenerConvergence,
  narrativeParagraphs,
  PRONOUN_OPENERS,
} from '../paragraph-opener'

const ch = (chapterNumber: number, content: string) => ({ chapterNumber, content })

// issue #94：那本 42 章的书里，929 个叙述段有 223 段（24.0%）以「周叙」起手、
// 107 段（11.5%）以「他」起手，合计 35.5%——「每三段里有一段先报一次主角的名字」。
// 位置轴：章首（#71）／登场句（#81）／核心戏（#32/#33）／章末（#28/#65/#66）之后，
// **每一段的第一个词**是产品里零覆盖的第四层。
describe('narrativeParagraphs (issue #94)', () => {
  it('drops dialogue paragraphs, which begin with a quote by nature', () => {
    const paragraphs = narrativeParagraphs(ch(1, '周叙推门。\n\n“你来了。”\n\n他坐下。'))
    expect(paragraphs.map(item => item.text)).toEqual(['周叙推门。', '他坐下。'])
  })

  it('keeps paragraph indices aligned with the original chapter', () => {
    const paragraphs = narrativeParagraphs(ch(1, '周叙推门。\n\n“你来了。”\n\n他坐下。'))
    // 第二段是对白，被剔掉；第三段的序号仍是 3（作者要按原文段号定位）。
    expect(paragraphs[1]!.paragraphIndex).toBe(3)
  })

  it('ignores blank and whitespace-only blocks', () => {
    expect(narrativeParagraphs(ch(1, '\n\n   \n\n')).length).toBe(0)
  })
})

describe('classifyOpener (issue #94)', () => {
  it('recognizes a cast name from the roster — never a hard-coded name list', () => {
    expect(classifyOpener('周叙把票根压上舱板。', ['周叙'])).toEqual({ kind: 'cast', name: '周叙' })
    expect(classifyOpener('沈砚推门进来。', ['沈砚'])).toEqual({ kind: 'cast', name: '沈砚' })
  })

  it('prefers the longer cast name when the roster holds overlapping entries', () => {
    expect(classifyOpener('全叔的旧油布围裙歪到一边。', ['全叔', '全叔的旧油布围裙']))
      .toEqual({ kind: 'cast', name: '全叔的旧油布围裙' })
  })

  it('recognizes the closed pronoun class', () => {
    expect(classifyOpener('他推开门。', [])).toEqual({ kind: 'pronoun', word: '他' })
    expect(classifyOpener('他们一起走进来。', [])).toEqual({ kind: 'pronoun', word: '他们' })
    expect(PRONOUN_OPENERS).toContain('她')
  })

  it('does not treat a demonstrative as a pronoun opener', () => {
    // 「这」起手是指示（「这一幕他记住了」），不是「谁在做」——混进来会让代词比例失真。
    expect(classifyOpener('这一幕他记住了。', [])).toEqual({ kind: 'other' })
  })

  it('classifies a scene opening as other', () => {
    expect(classifyOpener('舱门口有赤脚踩木板的声响。', ['周叙'])).toEqual({ kind: 'other' })
  })
})

describe('findParagraphOpenerConvergence (issue #94)', () => {
  /** 造一本「每段都用主角名起手」的书。 */
  const dominated = Array.from({ length: 10 }, (_, index) => ch(index + 1,
    Array.from({ length: 4 }, (_, j) => `周叙做了第${j + 1}件事，然后走开。`).join('\n\n')))

  it('reports a cast opener that takes at least a third of narrative paragraphs', () => {
    const hits = findParagraphOpenerConvergence(dominated, ['周叙'])
    const cast = hits.find(item => item.opener.kind === 'cast')
    expect(cast).toBeDefined()
    expect(cast!.count).toBe(40)
    expect(cast!.narrativeTotal).toBe(40)
    expect(cast!.chapters.length).toBe(10)
  })

  it('reports the consecutive run with paragraph numbers so the author can locate it', () => {
    const hits = findParagraphOpenerConvergence(dominated, ['周叙'])
    expect(hits[0]!.longestRun.length).toBeGreaterThanOrEqual(3)
    expect(hits[0]!.longestRun[0]).toMatchObject({ chapterNumber: 1, paragraphIndex: 1 })
  })

  it('fires on the combined name-plus-pronoun shape the issue measured (24% + 11.5%)', () => {
    // issue 的原话是「周叙 24.0% + 他 11.5% = 35.5% —— 每三段里有一段先报一次主角」。
    // 单看人名到不了 1/3，单看代词更不够；**必须合计判**。
    // 第一版只按人名判、且代词项因为「自己没达标」根本没进候选 —— 这条最该报的问题
    // 恰好报不出来（本测试就是为了钉住它）。
    const book = Array.from({ length: 12 }, (_, index) => ch(index + 1, [
      '周叙推门。', '舱里有响动。', '他坐下。', '灯芯爆了。',
      '周叙站起来。', '雨点落下来。', '门开着。', '船还没开。',
    ].join('\n\n')))
    const hits = findParagraphOpenerConvergence(book, ['周叙'])
    const cast = hits.find(item => item.opener.kind === 'cast')
    const pronoun = hits.find(item => item.opener.kind === 'pronoun')
    // 人名 2/8 = 25% < 1/3、代词 1/8 = 12.5% —— 单看谁都不够，合计 37.5% 才达标。
    // 所以**只有代词那条被报出来**（它承载「名字+代称」这一种现象的合计语义），
    // 而人名那条因为自己没到 1/3、也没有三连段，正确地不单独报。
    expect(cast).toBeUndefined()
    expect(pronoun).toBeDefined()
    expect(pronoun!.count).toBeGreaterThan(0)
    // 合计口径就是 issue 原文的 24.0% + 11.5% = 35.5%。
    expect((24 + 11.5) / 100).toBeGreaterThanOrEqual(1 / 3)
  })

  it('does not report the pronoun alone when no cast name carries the frequency', () => {
    // 没有高频人名时，「他」起手在正常叙述里本来就常见，单报它会是噪声。
    const book = Array.from({ length: 12 }, (_, index) => ch(index + 1, [
      '他推门。', '舱里有响动。', '雨落下来。', '灯芯爆了。', '门开着。', '船还没开。',
      '舷边有脚印。', '雾散了。',
    ].join('\n\n')))
    const hits = findParagraphOpenerConvergence(book, ['周叙'])
    expect(hits.some(item => item.opener.kind === 'pronoun')).toBe(false)
  })

  it('stays silent for genuinely varied openings', () => {
    const varied = Array.from({ length: 12 }, (_, index) => ch(index + 1, [
      '舱门口有响动。', '灯芯爆了一下。', '三下，停，再两下。', '开航前一刻钟，跳板搭上。',
      '周叙推开门。', '他坐下。', '雨点砸在篷布上。', '“你来了。”',
    ].join('\n\n')))
    const hits = findParagraphOpenerConvergence(varied, ['周叙'])
    expect(hits.some(item => item.opener.kind === 'cast')).toBe(false)
  })

  it('requires the minimum chapter count before judging', () => {
    expect(findParagraphOpenerConvergence(dominated.slice(0, 4), ['周叙'])).toEqual([])
  })

  it('does not compare against a cast roster it was not given', () => {
    // 没有名册时人名起手无从判（判据刻意不写死角色名）。
    const hits = findParagraphOpenerConvergence(dominated, [])
    expect(hits.every(item => item.opener.kind !== 'cast')).toBe(true)
  })

  it('keeps the key anchored on the opener, not the chapter — so an ack sticks (issues #86/#89)', () => {
    // key 在 findings 层拼装；这里断言判据本身提供的身份是「谁起手」而不是「第几章」。
    const at40 = findParagraphOpenerConvergence(dominated, ['周叙'])[0]!
    const at41 = findParagraphOpenerConvergence([...dominated, ch(11, '周叙又走了。')], ['周叙'])[0]!
    expect(at40.opener).toEqual(at41.opener)
  })
})
