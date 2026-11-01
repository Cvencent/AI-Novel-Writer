import { describe, expect, it } from 'vitest'

import { findAbilityReuseContradictions } from '../ability-budget'

// issue #51：第 13 章同一段先说「最后一次溯读已经用尽，本班次再读不出第二处」，
// 紧接着又写「一行字浮出来」——两句之间只隔几十个字。
describe('findAbilityReuseContradictions (issue #51)', () => {
  it('issue 的原文必须报出来（同一段内用尽后又读出）', () => {
    const text = '他退回舱角，把存根从灯罩里抽出来。纸面发了脆，最后一次溯读已经用尽，本班次再读不出第二处。指腹蹭过背面那道直压痕——痕下有东西。一层极薄的墨，泛着靛，凑近灯，一行字浮出来：笔画生，横折收得急，跟刚才读出的一模一样。'
    const findings = findAbilityReuseContradictions(text)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.declaration).toContain('用尽')
    expect(findings[0]!.reuse).toContain('浮出来')
  })

  it('「再读不出第二处」这种否定式声明也能抓到', () => {
    const text = '水汽不够，本班次再读不出第二处。他把票根按上那层旧墨，一行字浮出来。'
    expect(findAbilityReuseContradictions(text)).toHaveLength(1)
  })

  it('声明用尽之后没有再使用时不报（正常的「这次真的用完了」）', () => {
    const text = '最后一次溯读已经用尽，本班次再读不出第二处。他把票根收回怀里，往回走，夜里什么也没再发生。'
    expect(findAbilityReuseContradictions(text)).toEqual([])
  })

  it('相距太远不判（超出窗口说明不是同一处叙述）', () => {
    const filler = '他把票根收好，沿着舱壁往外走。'.repeat(40)
    const text = `最后一次溯读已经用尽。${filler}后来他想起白天读出的那一行字浮出来过。`
    expect(findAbilityReuseContradictions(text)).toEqual([])
  })

  it('没有用尽声明的章节不报（常态，不刷噪声）', () => {
    const text = '他蹲下去，从怀里摸出油纸包，抽出那联旧票根。票根干得卷边。他蘸了水，一行字浮出来。'
    expect(findAbilityReuseContradictions(text)).toEqual([])
  })

  it('「只剩一次」之后紧接着用一次是合法的，不该报', () => {
    // 「只剩一次」本身不是「已用尽」——它还允许一次使用；判据只认用尽类声明。
    const text = '这班船到天亮靠岸，他只剩一次水汽。他掀开父亲那一页，一行字浮出来。'
    expect(findAbilityReuseContradictions(text)).toEqual([])
  })

  it('窗口可调（供不同题材校准）', () => {
    const text = '最后一次溯读已经用尽。他走了一段路。他按上票根，字浮出来。'
    expect(findAbilityReuseContradictions(text, 1_000)).toHaveLength(1)
    expect(findAbilityReuseContradictions(text, 5)).toEqual([])
  })
})
