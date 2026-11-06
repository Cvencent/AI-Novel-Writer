import { describe, expect, it } from 'vitest'

import { findDeclaredDigitCountMismatches } from '../numbering-consistency'

// issue #47：第 16 章「编号五位，零三一七」——标称五位却只写出四位；
// 第 17 章「编号一七四」是全书唯一一次三位数写法。这里只判**能直接机器判**的那类：
// 声明的位数与紧随其后的编号位数不符。
describe('findDeclaredDigitCountMismatches (issue #47)', () => {
  it('issue 的原文必须报出来（声明五位、写出四位）', () => {
    const text = '墨层慢慢活了。被覆盖的笔画浮出来：编号五位，零三一七，字尾收得急。'
    const mismatches = findDeclaredDigitCountMismatches(text)
    expect(mismatches).toHaveLength(1)
    expect(mismatches[0]).toMatchObject({ declaredDigits: 5, actualDigits: 4 })
    expect(mismatches[0]!.evidence).toContain('零三一七')
  })

  it('阿拉伯数字与汉字数字两种写法都能判', () => {
    expect(findDeclaredDigitCountMismatches('编号 5 位：零三一七。')[0]).toMatchObject({ declaredDigits: 5, actualDigits: 4 })
    expect(findDeclaredDigitCountMismatches('编号五位：0317。')[0]).toMatchObject({ declaredDigits: 5, actualDigits: 4 })
    expect(findDeclaredDigitCountMismatches('编号四位，一七四。')[0]).toMatchObject({ declaredDigits: 4, actualDigits: 3 })
  })

  it('位数一致时不报（正常写法不打扰作者）', () => {
    for (const text of [
      '编号五位，零三一七〇。',
      '编号四位，零三一七。',
      '编号 4 位：0317。',
      '编号三位，一七四。',
    ]) expect(findDeclaredDigitCountMismatches(text), text).toEqual([])
  })

  it('没有位数声明时不报（这是常态，也避免把区间描述当矛盾）', () => {
    for (const text of [
      '存根段从零三一五跳到零三一八，中间没入过底。',
      '编号是丁段一四，第 7、8、10 章都这么写。',
      '温珩，船工，编号一七四。',
    ]) expect(findDeclaredDigitCountMismatches(text), text).toEqual([])
  })

  it('普通量词不算编号声明（「十位乘客」「五位船工」不误报）', () => {
    for (const text of [
      '船上十位乘客里，其中 3 人买了票。',
      '五位船工上了船。',
      '他有三位帮手，其中 2 人负责收绳。',
    ]) expect(findDeclaredDigitCountMismatches(text), text).toEqual([])
  })

  it('同章多处矛盾各自报出，位置不同（可逐条豁免）', () => {
    const text = '编号五位，零三一七。后来他又写：票号四位，零三。'
    const mismatches = findDeclaredDigitCountMismatches(text)
    expect(mismatches).toHaveLength(2)
    expect(new Set(mismatches.map(item => item.index)).size).toBe(2)
  })
})

/**
 * issue #221：这条判据的**置位守卫是死代码**，把序数词当成了编号声明。
 *
 * 根因（不是判据的判据，而是判据的**守卫**）：
 *
 * ```ts
 * const DECLARED_DIGITS = /…([0-9…]{1,3})\s*位(?:数)?…([0-9…]+)/gu   // 模式里含「位」
 * if (!/(?:编号|票号|代号|号码|号段|编码|位)/u.test(prefix + match[0])) continue
 * //                                        ^^^ 恒为真 → 这个 if 从不拒绝任何东西
 * ```
 *
 * `match[0]` 必然包含「位」，所以字符类里那个 `位` 分支**永远成立**——
 * 守卫形同虚设，任何「N 位 + 数字」都能过关。
 *
 * 现场（第 96 章）：
 * ```
 * 头一位先露，随后三位一口气浮出来。四个数字并排，横在日期栏里。
 * ```
 * 判据报「声明 3 位、实际 1 位」——「位」在这里是**序数词的量词**，
 * 被当成「实际数字」的「一」是「一口气」的首字，而整句讲的是**溯读时数字显现的次序**。
 * 全语料 2 条命中里 1 条是它，作者照卡片改哪一边都会把一句本来正确的句子改坏。
 */
describe('置位守卫必须真的能拒绝（issue #221）', () => {
  it('does not read an ordinal 「N 位」 as a digit-count declaration', () => {
    const text = '头一位先露，随后三位一口气浮出来。四个数字并排，横在日期栏里。'
    expect(findDeclaredDigitCountMismatches(text)).toEqual([])
  })

  it('keeps the true positive: 「编号五位，零三一七」(issue #47 的原始现场)', () => {
    const text = '墨层慢慢活了。被覆盖的笔画浮出来：编号五位，零三一七，字尾收得急。'
    expect(findDeclaredDigitCountMismatches(text)[0]).toMatchObject({ declaredDigits: 5, actualDigits: 4 })
  })

  it('still rejects other ordinal forms around the same shape', () => {
    for (const text of [
      '倒数第二位先露。',                      // 序数词
      '第二位一口气浮出来。',
      '头一位先露，随后三位浮出来。',
      '随后三个数字一口气浮出来。',            // 「个」不是「位」
    ]) expect(findDeclaredDigitCountMismatches(text), text).toEqual([])
  })

  it('keeps the ordinary-quantifier cases green (they were already green, and stay so)', () => {
    for (const text of [
      '船上十位乘客里，其中 3 人买了票。',
      '五位船工上了船。',
      '他有三位帮手，其中 2 人负责收绳。',
    ]) expect(findDeclaredDigitCountMismatches(text), text).toEqual([])
  })

  it('the guard is not vacuous: a bare 「N 位 + 数字」 without any numbering word is refused', () => {
    // 这条是本条的核心断言：守卫必须有**能拒绝**的分支。
    // 若有人把 `位` 加回那个字符类，这条会红——因为模式里已含「位」，等于没守卫。
    expect(findDeclaredDigitCountMismatches('三位一七四。')).toEqual([])
    expect(findDeclaredDigitCountMismatches('共 5 位 0317。')).toEqual([])
    // 而带编号上下文时同一形态要报——两边一起钉住，才说明守卫在按上下文分流。
    expect(findDeclaredDigitCountMismatches('编号 5 位 0317。')[0]).toMatchObject({ declaredDigits: 5, actualDigits: 4 })
  })
})
