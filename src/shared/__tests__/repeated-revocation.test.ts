import { describe, expect, it } from 'vitest'

import {
  RELAPSE_MIN_CHAPTERS,
  REVOKE_MIN_GAP,
  findRepeatedRevocationFindings,
  findRepeatedRevocations,
  irreversibleStateNouns,
} from '../repeated-revocation'

const ch = (chapterNumber: number, content: string) => ({ chapterNumber, content })
const entry = (chapterNumber: number, costs: string) => ({ chapterNumber, costs })
const CAST = ['周叙', '邵广海', '林棠']

// issue #105：同一场「撤销职务」被当成不可逆处分宣告两次——第 12 章当众夺钥匙并赶下柜台，
// 第 13–46 章她又照常在柜台上，第 47 章同样一套再演一遍；而蓝图账本也把同一笔账记了两遍。
describe('irreversibleStateNouns (issue #105)', () => {
  it('reads the two real ledger entries as irreversible losses of the same position', () => {
    // 两句都取自真实蓝图 costs_and_turns。
    expect(irreversibleStateNouns('林棠私留存根被邵广海当场坐实，售票口的位置没了，从此不能再与周叙公开见面'))
      .toContain('售票口')
    expect(irreversibleStateNouns('林棠被当众注销售票口身份、交出钥匙，从此不能再上码头'))
      .toContain('售票口')
  })

  it('does not treat a plain cost with no irreversibility wording as a revocation', () => {
    expect(irreversibleStateNouns('周叙挨训、扣半班工钱，船工里落下认死理的名声')).toEqual([])
  })

  it('does not read a facility name as the character\'s position', () => {
    // ⚠️ 标定踩到：0202 里「验票」是**场所名**（验票舱），一次正当的职务变更也会让它在
    // 正文里反复出现 → 假阳性。判据只收「这个人的这个位置」的名词，不收设施名。
    expect(irreversibleStateNouns('周叙被正式调离验票位、改任货舱帮办，彻底失去行会庇护')).toEqual([])
  })
})

describe('findRepeatedRevocations (issue #105)', () => {
  const ledger = [
    entry(12, '关系代价：林棠私留存根被当场坐实，售票口的位置没了，从此不能再与周叙公开见面'),
    entry(47, '林棠被当众注销售票口身份、交出钥匙，从此不能再上码头'),
  ]

  it('reports the reported case: same position booked irreversible twice, still in use between', () => {
    const prose = [
      ch(14, '当晚售票口收摊前，邵广海把烟盒往柜台上一拍。林棠在柜台后头数票，手没停。'),
      ch(24, '林棠从售票口里递出一张存根，周叙接了。'),
      ch(43, '林棠拉开半扇门，从售票口里把三张存根递出来。'),
    ]
    const hits = findRepeatedRevocations({ ledger, prose, castNames: CAST })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ stateNoun: '售票口', firstChapter: 12, secondChapter: 47, gap: 35 })
    expect(hits[0]!.relapseChapters).toEqual([14, 24, 43])
  })

  it('says nothing when the first revocation actually landed', () => {
    // 之后正文里她不再出现在这个位置上 → 第一次生效了，不是重复宣告。
    const prose = [
      ch(14, '周叙一个人核完账，谁也没来。'),
      ch(24, '售票口换了人，周叙不认识。'),
      ch(43, '这件事在别处发生。'),
    ]
    expect(findRepeatedRevocations({ ledger, prose, castNames: CAST })).toEqual([])
  })

  it('treats two nearby declarations as one event, not a repetition', () => {
    // 挨着的两次是同一次事件的重述（如 ch47 宣告、ch48 复述「林棠的牌子摘了」）。
    expect(findRepeatedRevocations({
      ledger: [
        entry(47, '林棠被当众注销售票口身份、交出钥匙，从此不能再上码头'),
        entry(48, '林棠交钥匙被逐出码头，这条渠道永久断掉，售票口不再收她的手写存根'),
      ],
      prose: [ch(47, '林棠解下围裙，递交了钥匙。')],
      castNames: CAST,
    })).toEqual([])
    expect(REVOKE_MIN_GAP).toBeGreaterThanOrEqual(8)
  })

  it('needs the ledger on both sides — prose alone cannot tell which loss was irreversible', () => {
    expect(findRepeatedRevocations({ ledger: ledger.slice(0, 1), prose: [ch(20, '林棠在售票口数票。')], castNames: CAST }))
      .toEqual([])
  })

  it('needs a cast roster — without it a facility name would read as a position', () => {
    // 没有名册就判不出「当事人还在这处境里做事」，宁可沉默（标定 0202 靠这一条排除）。
    expect(findRepeatedRevocations({
      ledger: [
        entry(10, '他被正式调离柜台位，彻底失去行会庇护'),
        entry(22, '柜台这一摊从此不能再动，永久断掉'),
      ],
      prose: [ch(12, '周叙在柜台后头翻账。'), ch(15, '周叙把底册压在柜台上。')],
      castNames: [],
    })).toEqual([])
  })

  it('keeps the earliest pair and one entry per position', () => {
    const hits = findRepeatedRevocations({
      ledger: [
        entry(12, '售票口的位置没了，从此不能再公开见面'),
        entry(47, '注销售票口身份，从此不能再上码头'),
        entry(60, '售票口的位置永久注销，再也回不去'),
      ],
      prose: [ch(20, '林棠在售票口数票。'), ch(30, '林棠从售票口递纸出来。')],
      castNames: CAST,
    })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.firstChapter).toBe(12)
  })

  it('requires the relapse evidence to clear its own threshold', () => {
    expect(RELAPSE_MIN_CHAPTERS).toBeGreaterThanOrEqual(2)
  })
})

describe('findRepeatedRevocationFindings (issue #105 finding shape)', () => {
  const ledger = [
    entry(12, '关系代价：林棠私留存根被当场坐实，售票口的位置没了，从此不能再与周叙公开见面'),
    entry(47, '林棠被当众注销售票口身份、交出钥匙，从此不能再上码头'),
  ]
  const prose = [
    ch(14, '当晚售票口收摊前，邵广海把烟盒往柜台上一拍。林棠在柜台后头数票，手没停。'),
    ch(24, '林棠从售票口里递出一张存根，周叙接了。'),
    ch(43, '林棠拉开半扇门，从售票口里把三张存根递出来。'),
  ]

  it('names both declaration chapters, the relapse chapters, and stays a warning', () => {
    const findings = findRepeatedRevocationFindings({ ledger, prose, castNames: CAST })
    expect(findings).toHaveLength(1)
    expect(findings[0]!.stableFactKey).toBe('revocation:repeated:售票口:12')
    expect(findings[0]!.severity).toBe('warning')
    // sourceChapter 指向**首次宣告章**（旧账，不是正在写的那一章——#79/#108 的教训）。
    expect(findings[0]!.sourceChapter).toBe(12)
    expect(findings[0]!.evidence).toContain('第12章')
    expect(findings[0]!.evidence).toContain('第47章')
    expect(findings[0]!.evidence).toContain('林棠')
  })

  it('hands over three executable exits (let it land / write the reversal / keep only one)', () => {
    const finding = findRepeatedRevocationFindings({ ledger, prose, castNames: CAST })[0]!
    expect(finding.suggestion.zhCN).toContain('让第一次生效')
    expect(finding.suggestion.zhCN).toContain('写明撤销')
    expect(finding.suggestion.zhCN).toContain('只保留一次')
    expect(finding.suggestion.zhCN).toContain('必须落到正文里')
    expect(finding.suggestion.enUS).toContain('let the first one take effect')
  })

  it('keeps the key stable as the book advances — an ack must stick (issues #86/#89/#98/#108)', () => {
    const before = findRepeatedRevocationFindings({ ledger, prose, castNames: CAST })[0]!
    const after = findRepeatedRevocationFindings({ ledger, prose, castNames: CAST })[0]!
    expect(after.stableFactKey).toBe(before.stableFactKey)
    // key 里不含当前章号（这里没有 currentChapter 入参；锚点只有处境词与首次宣告章）。
    expect(before.stableFactKey).toBe('revocation:repeated:售票口:12')
  })

  it('says nothing when the ledger records each loss once', () => {
    expect(findRepeatedRevocationFindings({
      ledger: [ledger[0]!],
      prose,
      castNames: CAST,
    })).toEqual([])
  })
})
