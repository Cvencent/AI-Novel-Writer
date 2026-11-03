import { describe, expect, it } from 'vitest'

import {
  deadlineDeclarationIn,
  findUnsettledDeadlineFindings,
  findUnsettledDeadlines,
} from '../deadline-settlement'

const ch = (chapterNumber: number, content: string) => ({ chapterNumber, content })

// issue #101：「期限」是那本书唯一的悬念装置，却 79 处宣告、0 次到期——
// 12 条明确期限里 6 条下一章整章不再提；「结案」喊了 42 章仍未结。
// 产品侧 #66 的「通牒式收尾」只判章末句式，不看这条期限后来有没有落地。
describe('deadlineDeclarationIn (issue #101)', () => {
  it('recognizes a deadline only when a deadline time and a stated consequence share the sentence', () => {
    // 两句都取自真实正文。
    expect(deadlineDeclarationIn('柯明远把一张临时移交单推过来，“账本随船，明早原样交回，当着我的面封。'))
      .toContain('明早')
    expect(deadlineDeclarationIn('“旧册今天日落前就得进档案房最里间。')).toContain('日落前')
  })

  it('ignores a plain scene time with no stated consequence', () => {
    // 「开航前，周叙去舱底取航次账」只是场景时点，不是期限——标定时靠这一条把 17 条噪声降到 8 条。
    expect(deadlineDeclarationIn('开航前，周叙去舱底取航次账。')).toBeNull()
    expect(deadlineDeclarationIn('天亮前，货郎又来了一趟。')).toBeNull()
  })

  it('ignores a standing ban that starts at a time — that is issue #105 territory, not a deadline', () => {
    // ⚠️ 标定踩到：「今晚起，你的牌子摘了」下一章确实有后续（林棠的牌子摘了），
    // 按期限口径判会报成假阳性——它是**处境变更**，不是截止期限。
    expect(deadlineDeclarationIn('他说，“这个柜台上的人，从今晚起不许再跟姓周的说一个字。')).toBeNull()
    expect(deadlineDeclarationIn('邵广海说，“今晚起，你的牌子摘了。')).toBeNull()
  })

  it('returns null for blank content', () => {
    expect(deadlineDeclarationIn('')).toBeNull()
    expect(deadlineDeclarationIn('   ')).toBeNull()
  })
})

describe('findUnsettledDeadlines (issue #101)', () => {
  it('reports a deadline the next chapter never mentions', () => {
    const chapters = [
      ch(39, '“天亮前得还。”全叔把绳头压紧。'),
      ch(40, '周叙把票根折好，塞进内襟。船开了。'),
    ]
    const hits = findUnsettledDeadlines(chapters)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ declaredAt: 39, timeToken: '天亮前' })
    expect(hits[0]!.declaration).toContain('天亮前得还')
  })

  it('treats a mention of the same time word in the next chapter as settled', () => {
    // issue 表格里 ch24「今夜别想开船」→ ch25 提到，就是这种情况（正确不报）。
    const chapters = [
      ch(24, '“不签，箱子当场扣下。今夜别想开船。”'),
      ch(25, '箱子在我手上，你这一笔不落，今夜开不了船。'),
    ]
    expect(findUnsettledDeadlines(chapters)).toEqual([])
  })

  it('treats a time-word synonym in the next chapter as settled (明早 ≈ 明天)', () => {
    // 说「明早」的人在下一章可能说「明天」——同一截止点的两种写法。
    expect(findUnsettledDeadlines([
      ch(44, '他扣上包，“明早前，谁也别再动账房的纸。”'),
      ch(45, '柯明远把包夹到腋下，“明天交。'),
    ])).toEqual([])
  })

  it('treats an explicit settlement word as settled even without the time word', () => {
    // 「作废/逾期/延期」这类落定语用标记本身就是对账。
    expect(findUnsettledDeadlines([
      ch(1, '“明早交报告，交不出就换人。”'),
      ch(2, '那份底册作废了，重出一份。'),
    ])).toEqual([])
  })

  it('requires consecutive chapter numbers — a gap is not a chain', () => {
    // 中间夹着没导入的章，不能断定「下一章没提」。
    expect(findUnsettledDeadlines([
      ch(39, '“天亮前得还。”'),
      ch(41, '别的事在发生。'),
    ])).toEqual([])
  })

  it('reports only the first deadline of a chapter (no per-chapter flooding)', () => {
    const chapters = [
      ch(1, '“明早交不出就换人。”他说完就走。\n\n“日落前核不出，这条船停。”他又回头。'),
      ch(2, '船开了，别的什么都没写。'),
    ]
    expect(findUnsettledDeadlines(chapters)).toHaveLength(1)
  })

  it('skips blank chapters instead of inventing adjacency', () => {
    expect(findUnsettledDeadlines([ch(1, '“明早交。”'), ch(2, '   '), ch(3, '别的事。')])).toEqual([])
  })
})

describe('findUnsettledDeadlineFindings (issue #101 finding shape)', () => {
  const chapters = [
    ch(39, '“天亮前得还。”全叔把绳头压紧。'),
    ch(40, '周叙把票根折好，塞进内襟。'),
  ]

  it('names the declaring chapter and the missing follow-up, and stays a warning', () => {
    const findings = findUnsettledDeadlineFindings({ chapters })
    expect(findings).toHaveLength(1)
    expect(findings[0]!.stableFactKey).toBe('deadline:unsettled:39:天亮前')
    expect(findings[0]!.severity).toBe('warning')
    // sourceChapter 指向**宣告章**（这是旧账，不是正在写的那一章——#79/#108 的教训）。
    expect(findings[0]!.sourceChapter).toBe(39)
    expect(findings[0]!.evidence).toContain('第39章')
    expect(findings[0]!.evidence).toContain('第40章')
  })

  it('hands over three executable exits (pay off / lapse / defer), each landing on the page', () => {
    const finding = findUnsettledDeadlineFindings({ chapters })[0]!
    expect(finding.suggestion.zhCN).toContain('兑现')
    expect(finding.suggestion.zhCN).toContain('逾期')
    expect(finding.suggestion.zhCN).toContain('延期')
    expect(finding.suggestion.zhCN).toContain('必须落到下一章的正文里')
    expect(finding.suggestion.enUS).toContain('pay it off')
  })

  it('keeps the key stable as the book advances — an ack must stick (issues #86/#89/#98/#108)', () => {
    const before = findUnsettledDeadlineFindings({ chapters, currentChapter: 41 })[0]!
    const after = findUnsettledDeadlineFindings({ chapters, currentChapter: 42 })[0]!
    expect(after.stableFactKey).toBe(before.stableFactKey)
    // key 里不含当前章号。
    expect(before.stableFactKey).not.toContain(':41')
    expect(before.stableFactKey).not.toContain(':42')
  })

  it('says nothing when every deadline is followed up', () => {
    expect(findUnsettledDeadlineFindings({
      chapters: [ch(1, '“明早交。”'), ch(2, '天亮他就把报告递了上去。')],
    })).toEqual([])
  })
})
