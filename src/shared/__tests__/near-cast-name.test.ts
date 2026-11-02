import { describe, expect, it } from 'vitest'

import { findNearCastNameFindings, findNearCastNames } from '../consistency-preflight'

// issue #58：第 21 章蓝图在 key_events 里凭空写出「柯阅」，并当场解释成在册角色「柯明远」；
// #42 的「未登记角色」只看 characters 数组，盖不到写在事件描述里的人名。
describe('findNearCastNames (issue #58)', () => {
  const cast = ['周叙', '温珩', '邵广海', '叶九', '柯明远', '林棠', '全叔']

  it('issue 的原文必须报出来：引号内「柯阅」≈「柯明远」', () => {
    const text = '再深一层，栏边有一道极浅的批注，笔压稳匀，是「柯阅」两个字，说明这页账在封存前柯明远亲手翻过。'
    expect(findNearCastNames(text, cast)).toEqual([{ name: '柯阅', near: '柯明远' }])
  })

  it('长度相同、差一字的写法也报（「柯明元」→「柯明远」）', () => {
    expect(findNearCastNames('落款是“柯明元”。', cast)).toEqual([{ name: '柯明元', near: '柯明远' }])
  })

  it('在册角色名本身不报（引号里写的就是名册里的人）', () => {
    expect(findNearCastNames('签名是「柯明远」。', cast)).toEqual([])
  })

  it('首字不同不报（避免把引号内普通名词当成人名）', () => {
    for (const text of ['他念了一句「三十三张」。', '那件「靛蓝短褂」还挂着。', '「空号存根」压在底下。']) {
      expect(findNearCastNames(text, cast), text).toEqual([])
    }
  })

  it('超过 3 字或明显不相近的引号词不报', () => {
    expect(findNearCastNames('写着「柯长明远」。', cast)).toEqual([])
    expect(findNearCastNames('写着「崔老四」。', cast)).toEqual([])
  })

  it('「姓氏唯一 + 引号内出现同姓的另一个名字」这一支会报，且是刻意放宽的（warning 只是提示）', () => {
    // 「柯南」与 issue 样本「柯阅」形态相同（2 字、与唯一的柯姓角色名不同），
    // 判据无法在字面上区分「同一人的另一种写法」与「另一个姓柯的人」——所以它给提示，
    // 由作者决定是补别名还是建卡（建议里已写明两条出路）。
    expect(findNearCastNames('写着「柯南」。', cast)).toEqual([{ name: '柯南', near: '柯明远' }])
  })

  it('姓氏在名册里不唯一时，只靠姓氏相近不算命中（避免把同姓的另一个人当变体）', () => {
    // 名册里两个姓柯的人 → 姓氏不再唯一，「柯阅」不报
    expect(findNearCastNames('写着「柯阅」。', ['周叙', '柯明远', '柯有顺'])).toEqual([])
  })

  it('同一章多处同一名字只留一条', () => {
    expect(findNearCastNames('他写「柯阅」。又一次「柯阅」。', cast)).toEqual([{ name: '柯阅', near: '柯明远' }])
  })

  it('finding 的 key / 证据 / 两条出路都写清楚', () => {
    const [finding] = findNearCastNameFindings({
      chapterNumber: 21,
      descriptionText: '栏边有一道极浅的批注，是「柯阅」两个字。',
      castNames: cast,
    })
    expect(finding!.severity).toBe('warning')
    expect(finding!.sourceChapter).toBe(21)
    // key 不带章号（issue #69）：同一个署名在后续章节重复出现时不再重报，
    // 确认过一次就能全书静音。
    expect(finding!.stableFactKey).toBe('blueprint-cast:near-name:柯明远:柯阅')
    expect(finding!.evidence).toContain('柯明远')
    // 两条出路都必须是产品里真的做得到的动作（issue #69）：
    // 「保存安排」是预检弹层里现成的按钮，「建卡」在角色名单里做得到。
    expect(finding!.suggestion.zhCN).toContain('保存安排')
    expect(finding!.suggestion.zhCN).toContain('建卡')
  })

  it('没有相近名字时不产生任何提示（正常章节不打扰）', () => {
    expect(findNearCastNameFindings({
      chapterNumber: 3,
      descriptionText: '周叙把「航次账」翻到待核那栏，温珩在旁边抄录。',
      castNames: cast,
    })).toEqual([])
  })
})
