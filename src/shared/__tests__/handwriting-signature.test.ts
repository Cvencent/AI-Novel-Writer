import { describe, expect, it } from 'vitest'

import {
  findHandwritingConflictFindings,
  findHandwritingConflicts,
  handwritingOwnerIn,
  handwritingQualityFamilies,
} from '../handwriting-signature'

const ch = (chapterNumber: number, content: string) => ({ chapterNumber, content })
const CAST = ['周叙', '温珩', '叶九', '柯明远', '全叔']

// issue #97：核心金手指是「靠笔迹特征认出是谁的手」，而笔迹特征这一层没有账本——
// 同一个叶九在第 11 章被写成「横折收得急」、第 13/19 章被写成「稳、匀，起笔带锋」；
// 父亲在第 17 章是「起笔轻，收笔回锋」、第 28–39 章是「起笔重，末横压住」。
describe('handwritingOwnerIn (issue #97)', () => {
  it('attributes through the possessive 「X 的笔/手/字/签押」', () => {
    expect(handwritingOwnerIn('最上头是叶九的手，稳、匀，起笔带锋。', CAST)).toBe('叶九')
    expect(handwritingOwnerIn('叶九的笔稳、匀，起笔带锋。', CAST)).toBe('叶九')
  })

  it('attributes through the dash form 「——X 的，」', () => {
    expect(handwritingOwnerIn('第一层墨浮起来——叶九的，横折收得急。', CAST)).toBe('叶九')
  })

  it('attributes the kin label with a signature or note', () => {
    expect(handwritingOwnerIn('父亲那一笔签押，起笔重，末横压住。', CAST)).toBe('父亲')
    expect(handwritingOwnerIn('笔压和旧票夹里父亲留的纸条一模一样，起笔轻，收笔回锋。', CAST)).toBe('父亲')
  })

  // ⚠️ 标定踩到：若把「同句含角色名」也算归属，「跳板落稳时天泛青」「手指抖了一下」
  // 这类普通叙述会被算成笔迹归属，假阳性成片。所以归属刻意只认上面三种形态。
  it('does NOT attribute merely because a cast name is in the sentence', () => {
    expect(handwritingOwnerIn('周叙蹲回舱角，把溯读出的东西记在手心：名字的笔画、几层涂改。', CAST)).toBeNull()
    expect(handwritingOwnerIn('周叙把票根压上去，只浮出半个笔画，横折收得急。', CAST)).toBeNull()
    expect(handwritingOwnerIn('全叔手按在第三个结上，慢慢收得更紧。', CAST)).toBeNull()
  })

  it('returns null when no cast name and no kin label is present', () => {
    expect(handwritingOwnerIn('那两笔跟他旧票夹里那张纸条的力道，是同一个上手势。', CAST)).toBeNull()
  })
})

describe('handwritingQualityFamilies (issue #97)', () => {
  it('reads the steady and the hurried families', () => {
    expect(handwritingQualityFamilies('稳、匀，起笔带锋')).toEqual(['稳匀'])
    expect(handwritingQualityFamilies('横折收得急')).toEqual(['急促'])
  })

  it('reads the heavy and the light families', () => {
    expect(handwritingQualityFamilies('起笔重，末横压住')).toEqual(['重笔'])
    expect(handwritingQualityFamilies('起笔轻，收笔回锋')).toEqual(['轻笔'])
  })

  it('does not fire on bare narrative verbs such as 「稳」 or 「抖」 alone', () => {
    // 单字会撞叙事语域（「跳板落稳」「手指抖了一下」）——只认书写质量的完整说法。
    expect(handwritingQualityFamilies('跳板落稳时天泛青。')).toEqual([])
    expect(handwritingQualityFamilies('温珩手指抖了一下。')).toEqual([])
  })

  it('reports both families when a sentence carries them', () => {
    expect(handwritingQualityFamilies('墨迹新，笔压稳，跟那笔发慌的追改不是一只手').sort())
      .toEqual(['急促', '稳匀'])
  })
})

describe('findHandwritingConflicts (issue #97)', () => {
  it('catches the reported 叶九 case — 急 vs 稳匀 on the same writer', () => {
    const hits = findHandwritingConflicts({
      chapters: [
        ch(11, '第一层墨浮起来——叶九的，横折收得急。'),
        ch(13, '最上头是叶九的手，稳、匀，起笔带锋。'),
        ch(19, '不是叶九的手。叶九的笔稳、匀，起笔带锋。'),
      ],
      castNames: CAST,
    })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.owner).toBe('叶九')
    expect(hits[0]!.families).toEqual(['稳匀', '急促'])
  })

  it('catches the reported 父亲 case — 轻 vs 重 on the same writer', () => {
    const hits = findHandwritingConflicts({
      chapters: [
        ch(17, '笔压和旧票夹里父亲留的纸条一模一样，起笔轻，收笔回锋。'),
        ch(29, '父亲那一笔签押，起笔重，末横压住。'),
      ],
      castNames: CAST,
    })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.owner).toBe('父亲')
    expect(hits[0]!.families).toEqual(['重笔', '轻笔'])
  })

  it('stays silent when one writer keeps one consistent trait', () => {
    expect(findHandwritingConflicts({
      chapters: [
        ch(11, '叶九的笔稳、匀，起笔带锋。'),
        ch(13, '叶九的手，稳、匀，一笔不抖。'),
      ],
      castNames: CAST,
    })).toEqual([])
  })

  it('does not cross-compare two different writers', () => {
    // 「叶九的笔稳」与「徐哥收得急」是两个不同的人，不是自相矛盾。
    expect(findHandwritingConflicts({
      chapters: [
        ch(11, '叶九的笔稳、匀，起笔带锋。'),
        ch(21, '徐哥的手，笔画生，横折收得急。'),
      ],
      castNames: [...CAST, '徐哥'],
    })).toEqual([])
  })

  it('needs a cast roster — without one there is nothing to attribute to', () => {
    expect(findHandwritingConflicts({
      chapters: [ch(11, '叶九的笔稳、匀。'), ch(13, '叶九的手，收得急。')],
      castNames: [],
    })).toEqual([])
  })
})

describe('findHandwritingConflictFindings (issue #97 finding shape)', () => {
  const chapters = [
    ch(11, '第一层墨浮起来——叶九的，横折收得急。'),
    ch(13, '最上头是叶九的手，稳、匀，起笔带锋。'),
  ]

  it('names the writer, both families and both chapter ranges, and stays a warning', () => {
    const findings = findHandwritingConflictFindings({ chapters, castNames: CAST })
    expect(findings).toHaveLength(1)
    expect(findings[0]!.stableFactKey).toBe('handwriting:conflict:叶九')
    expect(findings[0]!.severity).toBe('warning')
    // sourceChapter 指向**最早那条观察**所在的章（旧账，不是正在写的那一章——#79/#108）。
    expect(findings[0]!.sourceChapter).toBe(11)
    expect(findings[0]!.evidence).toContain('叶九')
    expect(findings[0]!.evidence).toContain('11')
    expect(findings[0]!.evidence).toContain('13')
  })

  it('hands over an actionable exit (fix the signature / explain the change)', () => {
    const finding = findHandwritingConflictFindings({ chapters, castNames: CAST })[0]!
    expect(finding.suggestion.zhCN).toContain('固定下来')
    expect(finding.suggestion.zhCN).toContain('为什么会变')
    expect(finding.suggestion.enUS).toContain('Fix')
  })

  it('keeps the key stable as the book advances (issues #86/#89/#98/#108)', () => {
    const before = findHandwritingConflictFindings({ chapters, castNames: CAST })[0]!
    const after = findHandwritingConflictFindings({ chapters: [...chapters, ch(50, '别的事。')], castNames: CAST })[0]!
    expect(after.stableFactKey).toBe(before.stableFactKey)
    expect(before.stableFactKey).not.toContain(':11')
  })

  it('says nothing when every writer has one consistent hand', () => {
    expect(findHandwritingConflictFindings({
      chapters: [ch(11, '叶九的笔稳、匀。'), ch(13, '叶九的手，稳、匀，一笔不抖。')],
      castNames: CAST,
    })).toEqual([])
  })
})
