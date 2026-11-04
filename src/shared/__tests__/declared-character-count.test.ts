import { describe, expect, it } from 'vitest'

import { findDeclaredCharacterCountMismatches } from '../declared-character-count'

/**
 * issue #131：正文自己写的「N 个字」与实际写出的字串对不上。
 *
 * 这类句子是推理小说的承重墙——读者跟着数「这几个字」来核对推理。判据完全机械化：
 * 声明 N 个字 + 紧随其后由正文自己引出的实体，比一比汉字数即可。
 */
describe('findDeclaredCharacterCountMismatches (issue #131)', () => {
  it('flags all three real mismatches quoted in the issue', () => {
    // ch57：声明 6，实际「核至本班次为止」7 个字。
    expect(findDeclaredCharacterCountMismatches('周叙拿起笔，在“核清”后头添了六个字——核至本班次为止。')[0])
      .toMatchObject({ declared: 6, actual: 7 })
    // ch57：声明 3，实际「三日内化浆」5 个字。
    expect(findDeclaredCharacterCountMismatches('底下三个字：三日内化浆。')[0]).toMatchObject({ declared: 3, actual: 5 })
    // ch36：声明 3，实际「徐哥」2 个字。
    expect(findDeclaredCharacterCountMismatches('周叙用指头拨开墨汁。名字栏三个字：徐哥。')[0])
      .toMatchObject({ declared: 3, actual: 2 })
  })

  it('stays silent on the correct controls the same book already writes', () => {
    // 正对照：同一本书里对得上的两处（名字栏两个字：周叙 / 那四个字：完整无缺）。
    expect(findDeclaredCharacterCountMismatches('名字栏两个字写得稳：周叙')).toEqual([])
    expect(findDeclaredCharacterCountMismatches('周叙盯着那四个字：完整无缺')).toEqual([])
  })

  it('does not judge a residual (scraped/damaged) reading as a miscount', () => {
    // 声明的是原字数，后面写的是残留字数——两者都成立，不能报。
    for (const text of [
      '两个名字，中间被刮断，只剩半边“余”',
      '原本三个字，被磨掉一角，只剩一个',
    ]) expect(findDeclaredCharacterCountMismatches(text), text).toEqual([])
  })

  it('requires the entity to end at the sentence boundary, not swallow the next clause', () => {
    // 实测误报形态：实体取到行尾会把下一句数进来（声明四个字 → 数成 24 个字）。
    const text = '四个字：完整无缺。他伸手把笔拿起来，笔尖斜着划过去，把“完整无缺”划掉。'
    expect(findDeclaredCharacterCountMismatches(text)).toEqual([])
    // 也不把「三个字他也对过——起笔重，末横压住…」这种续写句当成引出的实体。
    expect(findDeclaredCharacterCountMismatches('三个字他也对过——起笔重，末横压住，签押底下带一道反划。')).toEqual([])
  })

  it('counts only Han characters, so punctuation inside the quoted entity is not a character', () => {
    // 引号只是引渡符：实体的汉字数是 2，与声明一致 → 不报。
    expect(findDeclaredCharacterCountMismatches('签押底下两个字：“周叙”')).toEqual([])
    // 实体末尾的逗号不算字。
    expect(findDeclaredCharacterCountMismatches('那一栏两个字：周叙，')).toEqual([])
    // 声明两个字、引出三个汉字 → 报。
    expect(findDeclaredCharacterCountMismatches('签押底下两个字：周叙先。')[0]).toMatchObject({ declared: 2, actual: 3 })
  })

  it('does not fire without an entity the text introduces itself', () => {
    for (const text of [
      '他只说了三个字就转身走了。',
      '那六个字压在纸背，没人看见。',
    ]) expect(findDeclaredCharacterCountMismatches(text), text).toEqual([])
  })

  it('is structural, not a phrase list: any declared count with an introduced entity is judged', () => {
    // 换一套名目与量词位置，判据照样成立。
    expect(findDeclaredCharacterCountMismatches('账册末页五个字：丙申年腊。')[0]).toMatchObject({ declared: 5, actual: 4 })
    // 一致时不报（四个字：甲乙丙丁）。
    expect(findDeclaredCharacterCountMismatches('柜牌四个字：甲乙丙丁。')).toEqual([])
  })
})