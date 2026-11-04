import { describe, expect, it } from 'vitest'

import { findUnreconcilableAgeFindings, proseAgeStatements } from '../character-age-ledger'

const CAST = ['周叙', '温珩', '徐汐', '邵广海']
const ch = (chapterNumber: number, content: string) => ({ chapterNumber, content })

/**
 * issue #149：正文里给出的年龄**没有任何落点**。
 *
 * 现场：同一角色四章内从「女人」变成「七岁上船的孩子」；第 68 章正文「那一年她七岁」，
 * 而她连角色卡都没有——「她多大」这件事全系统没有任何一处存着，后续也无从对账。
 */
describe('proseAgeStatements (issue #149)', () => {
  it('reads the age and attributes it when the sentence names exactly one carded character', () => {
    const [statement] = proseAgeStatements(5, '那一年徐汐七岁。', CAST)
    expect(statement).toMatchObject({ age: 7, attributedTo: '徐汐' })
  })

  it('leaves the age unattributed when the subject is only a pronoun', () => {
    // 实测 ch68 原文：主语是「她」，句中没有任何在册名字。
    expect(proseAgeStatements(68, '那一年她七岁。', CAST)).toMatchObject([{ age: 7, attributedTo: null }])
  })

  it('does not attribute through a bystander named in the same sentence', () => {
    // 实测 ch69 原文：「她哥要赶在**邵广海**把这孩子弄走之前送她出港——七岁。」
    // 句子里唯一的在册人名是邵广海，而「七岁」说的是「她」。
    // 按整句归属会把年龄记到一个错的人头上——那不是漏报，是写错了账本。
    const [statement] = proseAgeStatements(69, '“她哥要赶在邵广海把这孩子弄走之前送她出港——七岁。”', CAST)
    expect(statement).toMatchObject({ age: 7, attributedTo: null })
  })

  it('does not count ages of objects, vintages or honorific exaggeration', () => {
    for (const text of ['这坛酒三十岁。', '那棵老槐树两百岁。', '吾皇万岁。']) {
      expect(proseAgeStatements(3, text, CAST), text).toEqual([])
    }
  })

  it('reads arabic and 周岁 forms too', () => {
    expect(proseAgeStatements(9, '周叙那年 7 岁。', CAST)[0]).toMatchObject({ age: 7, attributedTo: '周叙' })
    expect(proseAgeStatements(9, '温珩满七周岁。', CAST)[0]).toMatchObject({ age: 7, attributedTo: '温珩' })
  })
})

describe('findUnreconcilableAgeFindings (issue #149)', () => {
  it('flags the real chapter whose only age statement names nobody', () => {
    const [hit] = findUnreconcilableAgeFindings([ch(68, '周叙没有接。那一年她七岁。没有户籍。')], CAST)
    expect(hit).toBeDefined()
    expect(hit!.stableFactKey).toBe('character-age:unreconcilable:68')
    expect(hit!.evidence).toContain('那一年她七岁')
    expect(hit!.issue.zhCN).toContain('没有任何落点')
  })

  it('stays silent when at least one age in the chapter is attributed', () => {
    // 同一章里两处声明：一处归不上、一处归得上 → 这章的年龄**有落点**，不报。
    expect(findUnreconcilableAgeFindings([
      ch(68, '那一年她七岁。温珩那年三十一岁。'),
    ], CAST)).toEqual([])
  })

  it('stays silent on chapters that state no age at all', () => {
    expect(findUnreconcilableAgeFindings([ch(1, '周叙把缆绳搁下。')], CAST)).toEqual([])
    // 没有名册就不判：名册是归属的唯一依据。
    expect(findUnreconcilableAgeFindings([ch(68, '那一年她七岁。')], [])).toEqual([])
  })

  it('reports per chapter, listing every unattributable statement once', () => {
    const hits = findUnreconcilableAgeFindings([
      ch(68, '那一年她七岁。'),
      ch(69, '“送她出港——七岁。”'),
    ], CAST)
    expect(hits.map(hit => hit.stableFactKey))
      .toEqual(['character-age:unreconcilable:68', 'character-age:unreconcilable:69'])
  })

  it('keys on the chapter, so the finding does not drift as the book advances', () => {
    const base = findUnreconcilableAgeFindings([ch(68, '那一年她七岁。')], CAST)[0]!.stableFactKey
    const later = findUnreconcilableAgeFindings([ch(68, '那一年她七岁。'), ch(90, '又一章。')], CAST)[0]!.stableFactKey
    expect(later).toBe(base)
  })

  it('is structural: a different book with a different cast is judged the same way', () => {
    const [hit] = findUnreconcilableAgeFindings([ch(4, '那孩子那一年九岁。')], ['沈砚'])
    expect(hit!.evidence).toContain('九岁')
  })
})
