import { describe, expect, it } from 'vitest'

import {
  LOSS_REVIEW_RECENT_CHAPTERS,
  buildLossRestatementPrompt,
  lossRestatementReviewFindings,
  parseLossRestatementReview,
} from '../loss-restatement-review'

/**
 * issue #75 的现场 + issue #163 的迁移：同一笔遗忘被跨章重新宣告。
 *
 * 现场原文（金手指代价是「每溯读一次，墨吞掉一段记忆」）：
 * ```
 * ch19  他记得自己开口要过这三个结，要它们做什么，那里空了。
 * ch20  他记得让全叔打过这三个结，要它们做什么，脑子里空着。
 * ch23  他记得让全叔打过这三个结，但为什么打，脑子里空着。
 * ch24  林棠托人递的那句话，他使劲想，还是空壳。
 * ch25  他记得有人递过话……话里是什么，空的。
 * ```
 * 代价变成可重复计价，后面再写「他又忘了一件事」就没有分量。
 *
 * ⚠️ 旧实现是五张题材措辞表（`REMEMBER_MARKERS` / `FORGET_MARKERS` / `COGNITIVE_CONTEXT` /
 * `CARRY_OVER_PHRASES`），按用户 2026-11-05 的定规（不许词表、不许短语匹配）整族改由模型判。
 * 本文件里**没有任何词表**：规则只负责喂章、校验引文与章号。
 */
const chapters = [
  { chapterNumber: 19, content: '他记得自己开口要过这三个结，要它们做什么，那里空了。' },
  { chapterNumber: 20, content: '他记得让全叔打过这三个结，要它们做什么，脑子里空着。' },
  { chapterNumber: 23, content: '他记得让全叔打过这三个结，但为什么打，脑子里空着。' },
]

describe('buildLossRestatementPrompt (issue #75 / #163)', () => {
  it('hands the chapters to the model instead of matching wording itself', () => {
    const { user } = buildLossRestatementPrompt({ chapters, language: 'zh-CN' })
    expect(user).toContain('这三个结')
    expect(user).toContain('第19章')
    expect(user).toContain('第23章')
  })

  it('asks only for the same loss re-announced as a fresh one', () => {
    const { system } = buildLossRestatementPrompt({ chapters, language: 'zh-CN' })
    expect(system).toContain('同一笔')
    // 两件不同的东西被忘掉不算。
    expect(system).toContain('两件不同的东西')
  })

  it('explicitly allows the two intended fixes (continuation / a new paid attempt)', () => {
    const { system } = buildLossRestatementPrompt({ chapters, language: 'zh-CN' })
    // 延续（「他一直没想起来」）与「新的获取尝试并付出代价」都不是问题——它们正是推荐写法。
    expect(system).toContain('延续')
    expect(system).toContain('新尝试')
  })

  it('does not build a wording list (judge by meaning)', () => {
    const { system } = buildLossRestatementPrompt({ chapters, language: 'zh-CN' })
    expect(system).toContain('按**意思**判断')
    expect(system).not.toMatch(/以下词|命中任一|封闭集合/u)
    // 旧表里的题材措辞不该出现在判据里（只可能来自我们喂进去的正文）。
    expect(system).not.toContain('空壳')
    expect(system).not.toContain('被水洇')
  })

  it('requires a verbatim quote and forbids guessing', () => {
    const { system } = buildLossRestatementPrompt({ chapters, language: 'zh-CN' })
    expect(system).toContain('逐字引用')
    expect(system).toContain('不确定就不要报')
  })

  it('bounds the window', () => {
    expect(LOSS_REVIEW_RECENT_CHAPTERS).toBeLessThanOrEqual(16)
    const many = Array.from({ length: LOSS_REVIEW_RECENT_CHAPTERS + 3 }, (_, index) => ({
      chapterNumber: index + 1, content: `第${index + 1}章的正文。`,
    }))
    const { user } = buildLossRestatementPrompt({ chapters: many, language: 'zh-CN' })
    expect(user).toContain(`第${LOSS_REVIEW_RECENT_CHAPTERS + 3}章`)
    expect(user).not.toContain('### 第1章')
  })
})

describe('parseLossRestatementReview (issue #75 / #163)', () => {
  const request = { chapters }
  const issue = {
    referent: '这三个结是做什么用的',
    chapterNumbers: [19, 20, 23],
    quoteChapterNumber: 19,
    quote: '他记得自己开口要过这三个结，要它们做什么，那里空了。',
    explanation: '同一笔缺失被宣告了三次',
  }

  it('keeps a report whose quote locates verbatim and whose chapters are all in range', () => {
    expect(parseLossRestatementReview(JSON.stringify({ issues: [issue] }), request)).toEqual([issue])
  })

  it('drops a report whose quote is paraphrased', () => {
    expect(parseLossRestatementReview(
      JSON.stringify({ issues: [{ ...issue, quote: '他记得要过那三个结，那里是空的' }] }), request,
    )).toEqual([])
  })

  it('drops a report naming fewer than two chapters (one chapter cannot be a repeat)', () => {
    expect(parseLossRestatementReview(
      JSON.stringify({ issues: [{ ...issue, chapterNumbers: [19] }] }), request,
    )).toEqual([])
  })

  it('drops chapter numbers outside the sample, keeping the valid ones', () => {
    const parsed = parseLossRestatementReview(
      JSON.stringify({ issues: [{ ...issue, chapterNumbers: [19, 20, 999] }] }), request,
    )
    expect(parsed).toHaveLength(1)
    expect(parsed![0]!.chapterNumbers).toEqual([19, 20])
  })

  it('drops a report with no referent and rejects malformed output', () => {
    expect(parseLossRestatementReview(JSON.stringify({ issues: [{ ...issue, referent: ' ' }] }), request)).toEqual([])
    expect(parseLossRestatementReview('{not json', request)).toBeNull()
    expect(parseLossRestatementReview(JSON.stringify({ contradictions: [] }), request)).toBeNull()
  })

  it('dedupes the same report twice', () => {
    expect(parseLossRestatementReview(JSON.stringify({ issues: [issue, issue] }), request)).toHaveLength(1)
  })
})

describe('lossRestatementReviewFindings (issue #75 / #163)', () => {
  const issue = {
    referent: '这三个结是做什么用的',
    chapterNumbers: [19, 20, 23],
    quoteChapterNumber: 19,
    quote: '他记得自己开口要过这三个结，要它们做什么，那里空了。',
    explanation: '同一笔缺失被宣告了三次',
  }

  it('keeps the old key shape so historical acknowledgements still apply', () => {
    const [finding] = lossRestatementReviewFindings([issue])
    // 与旧实现同形（`continuity:loss-restatement:<referent>`）：换判据不能让历史 ack 失效。
    expect(finding!.stableFactKey).toBe('continuity:loss-restatement:这三个结是做什么用的')
    expect(finding!.sourceChapter).toBe(23)
  })

  it('names the chapters and the quoted sentence', () => {
    const [finding] = lossRestatementReviewFindings([issue])
    expect(finding!.evidence).toContain('19、20、23')
    expect(finding!.evidence).toContain('那里空了')
    // 说明「同一笔被反复宣告」的后果：读者学到代价可以重复计价，后面的分量就没了。
    expect(finding!.issue.zhCN).toContain('重复计价')
  })

  it('offers the two intended repairs', () => {
    const [finding] = lossRestatementReviewFindings([issue])
    expect(finding!.suggestion.zhCN).toContain('延续')
    expect(finding!.suggestion.zhCN).toContain('新的获取尝试')
  })

  it('gives the English side too', () => {
    const [finding] = lossRestatementReviewFindings([issue])
    expect(finding!.issue.enUS).toContain('re-charged')
    expect(finding!.suggestion.enUS).toContain('continuation')
  })

  it('says nothing when the model found nothing', () => {
    expect(lossRestatementReviewFindings([])).toEqual([])
  })
})