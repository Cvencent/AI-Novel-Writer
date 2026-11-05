import { describe, expect, it } from 'vitest'

import {
  DEADLINE_REVIEW_RECENT_CHAPTERS,
  buildDeadlineReviewPrompt,
  deadlineDeclarationSentences,
  deadlineReviewFindings,
  parseDeadlineReview,
} from '../deadline-review'

/**
 * issue #101 的现场 + issue #163 的迁移：期限宣告了却从不结算。
 *
 * 现场（46 章书）：结算词全文 **0 处**，期限类词 **79 处 / 29 章**；「结案」从第 5 章喊到第 46 章，
 * 每次都被下一个期限顶掉；12 条明确期限里 6 条下一章整章不再提。
 *
 * ⚠️ 旧实现是四张题材措辞表（`DEADLINE_TIME`/`DEADLINE_THREAT`/`PERSISTENT_BAN`/`SETTLEMENT`），
 * 按用户 2026-11-05 的定规整族改由模型判。本文件里判据只做**取数**（哪一句像宣告）
 * 与**校验**（引文可否定位），不做内容判断。
 */
const chapters = [
  { chapterNumber: 40, content: '“明早签字结案。”他把笔搁下。“交不出，卷铺盖。”' },
  { chapterNumber: 41, content: '天亮的时候他去了船坞。棚子里没人，账本还在桌上。' },
]

describe('deadlineDeclarationSentences（取数，不是判断）', () => {
  it('picks a sentence that carries both a deadline form and a threat form', () => {
    const found = deadlineDeclarationSentences(40, chapters[0]!.content)
    expect(found.length).toBeGreaterThan(0)
    expect(found[0]!.sentence).toContain('明早')
  })

  it('feeds any sentence with a deadline-time form — whether it is a deadline belongs to the model', () => {
    // ⚠️ 取数**故意宽**（issue #163）：旧实现还要求同句出现「后果威胁」，
    // 而那是拿一张 20 个词的表去判「这句有没有威胁」。现在只要含截止时点形态就喂，
    // 「『天亮的时候他去了船坞』算不算期限」交模型——提示词里已写明「出现时间词不等于它是期限」。
    expect(deadlineDeclarationSentences(41, '天亮的时候他去了船坞。')).toHaveLength(1)
    // 但完全不含时间形态的句子不进候选（这仍然省 token）。
    expect(deadlineDeclarationSentences(41, '他把账本放回桌上。')).toEqual([])
  })
})

describe('buildDeadlineReviewPrompt (issue #101)', () => {
  it('hands the deadline sentences and the chapters to the model', () => {
    const { user } = buildDeadlineReviewPrompt({ chapters, language: 'zh-CN' })
    expect(user).toContain('期限宣告句')
    expect(user).toContain('明早签字结案')
    expect(user).toContain('### 第41章')
  })

  it('asks specifically for deadlines the NEXT chapter neither settles nor carries forward', () => {
    const { system } = buildDeadlineReviewPrompt({ chapters, language: 'zh-CN' })
    expect(system).toContain('下一章')
    // 两种出路都要说清：结算 / 明确延续。
    expect(system).toContain('结算')
    expect(system).toContain('延续')
  })

  it('excludes a deadline met in the same chapter, and does not rely on a word list', () => {
    const { system } = buildDeadlineReviewPrompt({ chapters, language: 'zh-CN' })
    expect(system).toContain('同一章里当场兑现')
    expect(system).toContain('按**意思**判断')
    // 旧表里的题材措辞不许出现在判据里（只可能来自喂进去的样本）。
    expect(system).not.toContain('天亮前')
    expect(system).not.toContain('逾期')
  })

  it('requires a verbatim quote and forbids guessing', () => {
    const { system } = buildDeadlineReviewPrompt({ chapters, language: 'zh-CN' })
    expect(system).toContain('逐字引用')
    expect(system).toContain('不确定就不要报')
  })

  it('bounds the window', () => {
    expect(DEADLINE_REVIEW_RECENT_CHAPTERS).toBeLessThanOrEqual(16)
    const many = Array.from({ length: DEADLINE_REVIEW_RECENT_CHAPTERS + 3 }, (_, index) => ({
      chapterNumber: index + 1, content: `明天交货，否则作废。`,
    }))
    const { user } = buildDeadlineReviewPrompt({ chapters: many, language: 'zh-CN' })
    expect(user).toContain(`第${DEADLINE_REVIEW_RECENT_CHAPTERS + 3}章`)
    expect(user).not.toContain('### 第1章')
  })
})

describe('parseDeadlineReview (issue #101)', () => {
  const request = { chapters }
  const issue = {
    chapterNumber: 40,
    quote: '明早签字结案。”他把笔搁下。“交不出，卷铺盖',
    deadline: '明早签字结案',
    explanation: '下一章只写他去了船坞，没提交涉结果',
  }

  it('keeps a report whose quote locates verbatim and whose deadline is stated', () => {
    expect(parseDeadlineReview(JSON.stringify({ issues: [issue] }), request)).toEqual([issue])
  })

  it('drops a report whose quote is paraphrased', () => {
    expect(parseDeadlineReview(
      JSON.stringify({ issues: [{ ...issue, quote: '明天必须签字结案' }] }), request,
    )).toEqual([])
  })

  it('drops a report that does not say what the deadline demands', () => {
    expect(parseDeadlineReview(JSON.stringify({ issues: [{ ...issue, deadline: ' ' }] }), request)).toEqual([])
  })

  it('drops chapters outside the sample and rejects bad JSON', () => {
    expect(parseDeadlineReview(JSON.stringify({ issues: [{ ...issue, chapterNumber: 999 }] }), request)).toEqual([])
    expect(parseDeadlineReview('{not json', request)).toBeNull()
    expect(parseDeadlineReview(JSON.stringify({ contradictions: [] }), request)).toBeNull()
  })

  it('dedupes the same report twice', () => {
    expect(parseDeadlineReview(JSON.stringify({ issues: [issue, issue] }), request)).toHaveLength(1)
  })
})

describe('deadlineReviewFindings (issue #101 / #163)', () => {
  const issue = {
    chapterNumber: 40,
    quote: '明早签字结案。”他把笔搁下。“交不出，卷铺盖',
    deadline: '明早签字结案',
    explanation: '下一章只写他去了船坞',
  }

  it('keeps the old key shape so historical acknowledgements still apply', () => {
    const [finding] = deadlineReviewFindings([issue])
    // 与旧实现同形：`deadline:unsettled:<章号>:<时间点>`。
    expect(finding!.stableFactKey).toBe('deadline:unsettled:40:明早签字结案')
    expect(finding!.stableFactKey.startsWith('deadline:unsettled:')).toBe(true)
  })

  it('names the deadline, the quote and what the next chapter did instead', () => {
    const [finding] = deadlineReviewFindings([issue])
    expect(finding!.evidence).toContain('明早签字结案')
    expect(finding!.evidence).toContain('下一章只写他去了船坞')
    expect(finding!.issue.zhCN).toContain('期限')
  })

  it('offers three concrete repairs (settle / carry forward / drop it)', () => {
    const [finding] = deadlineReviewFindings([issue])
    expect(finding!.suggestion.zhCN).toContain('落地')
    expect(finding!.suggestion.zhCN).toContain('延续')
    expect(finding!.suggestion.zhCN).toContain('虚张声势')
  })

  it('gives the English side too', () => {
    const [finding] = deadlineReviewFindings([issue])
    expect(finding!.issue.enUS).toContain('deadline')
    expect(finding!.suggestion.enUS).toContain('carry it forward')
  })

  it('keeps distinct deadlines in one chapter as separate findings', () => {
    // 同一章的两条**不同**期限应当各自一条（旧实现按时间词分，行为一致）。
    const findings = deadlineReviewFindings([
      issue,
      { ...issue, quote: '日落前核完。', deadline: '日落前核完' },
    ])
    expect(findings).toHaveLength(2)
    expect(new Set(findings.map(item => item.stableFactKey)).size).toBe(2)
  })

  it('says nothing when the model found nothing', () => {
    expect(deadlineReviewFindings([])).toEqual([])
  })
})