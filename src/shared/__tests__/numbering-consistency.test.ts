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
