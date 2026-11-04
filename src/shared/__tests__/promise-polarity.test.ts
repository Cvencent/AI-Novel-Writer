import { describe, expect, it } from 'vitest'

import { findPromisePolarityReversals } from '../promise-polarity'

const ch = (chapterNumber: number, content: string) => ({ chapterNumber, content })

/**
 * issue #142：第 60 章温珩要周叙答应的是**「不要写」**，第 63 章复述成**「答应了要写」**，
 * 而第 63 章整段戏建立在这个反了的前提上，事实账本也把反的那版记成了事实。
 *
 * 上游三层（蓝图 bp60/bp63、第 63 章短细纲）全写「不写」，只有正文这一层反了；
 * 而没有任何一层比对「承诺的内容」——#52 的判据只认「是 X / 不是 X」同形短语。
 */
describe('findPromisePolarityReversals (issue #142)', () => {
  const CH60 = '「送出去，那人就销号。」\n「哪个人。」\n「答应我。座号不写进任何册。」\n周叙看着他。\n「不写。」'
  const CH63 = '「你的册。写没写。」\n周叙搁下笔。\n「一七四。」温珩说，「你答应过写进册。」'
  /** 第 64 章自己纠回来了（合法换写：字面不同）。 */
  const CH64 = '「你的座号，我不往册上写。」\n温珩看他。\n「不写，第三格就没东西换。」'

  it('flags the promise that is restated in the opposite direction', () => {
    const [hit] = findPromisePolarityReversals([ch(60, CH60), ch(63, CH63)])
    expect(hit).toBeDefined()
    expect(hit!.stableFactKey).toBe('promise:polarity:60:写进册')
    expect(hit!.evidence).toContain('第60章约定「不写进册」')
    expect(hit!.evidence).toContain('第63章复述成「写进册」')
  })

  it('treats the limiting word as the same promise (写进任何册 ≡ 写进册)', () => {
    // 这两句字面不同、语义相同——必须能配上，否则整条判据在这本书上 0 命中（实测过）。
    expect(findPromisePolarityReversals([ch(60, CH60), ch(63, CH63)]).length).toBe(1)
  })

  it('does not flag a differently-worded but consistent restatement', () => {
    // 第 64 章「不往册上写」与第 60 章方向一致，只是换了说法 → 不报。
    expect(findPromisePolarityReversals([ch(60, CH60), ch(64, CH64)])).toEqual([])
  })

  it('stays silent when both sides have the same polarity', () => {
    expect(findPromisePolarityReversals([
      ch(60, '「答应我。座号不写进任何册。」'),
      ch(63, '「你答应过不写进册。」'),
    ])).toEqual([])
  })

  it('needs a promise verb: a bare action phrase is not a promise', () => {
    // 只是叙述「他写进册」，没有「答应/约定」→ 不判。
    expect(findPromisePolarityReversals([
      ch(60, '「写进册了。」他说。'),
      ch(63, '「他没写进册。」'),
    ])).toEqual([])
  })

  it('does not compare beyond the window', () => {
    expect(findPromisePolarityReversals([ch(1, CH60), ch(40, CH63)])).toEqual([])
  })

  it('keys name the chapter where the promise was made, so they do not drift', () => {
    const base = findPromisePolarityReversals([ch(60, CH60), ch(63, CH63)])[0]!.stableFactKey
    const later = findPromisePolarityReversals([ch(60, CH60), ch(63, CH63), ch(65, '他把笔搁下。')])[0]!.stableFactKey
    expect(base).toBe(later)
  })

  it('is structural: another promise pair with different wording is judged the same way', () => {
    const hits = findPromisePolarityReversals([
      ch(7, '「答应我，别交出去。」'),
      ch(9, '「你答应过交出去。」'),
    ])
    expect(hits.length).toBe(1)
    expect(hits[0]!.evidence).toContain('不交出')
  })
})
