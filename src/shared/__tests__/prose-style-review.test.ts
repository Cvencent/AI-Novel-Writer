import { describe, expect, it } from 'vitest'

import { STYLE_KIND_LABELS, buildStyleReviewPrompt, parseStyleReview, styleIssueFindings } from '../prose-style-review'

const CHAPTERS = [{ chapterNumber: 5, content: '他的手在抖。他知道，这一切才刚刚开始。' }]
const request = { chapters: CHAPTERS, language: 'zh-CN' as const }

/**
 * 文风内容判据改由模型判断（用户 2026-11-05）。
 *
 * 旧 `prose-flavor.ts` 有 `METAPHOR_CONNECTORS` / `PHYSIOLOGICAL_CLICHES` /
 * `SUMMARY_TAIL_PATTERNS` 三张短语表——用户明确否掉这一类。
 */
describe('buildStyleReviewPrompt', () => {
  it('asks about the four axes without listing any topic words', () => {
    const { system } = buildStyleReviewPrompt(request)
    for (const [zh] of Object.values(STYLE_KIND_LABELS)) expect(system).toContain(zh)
    // 不许把旧词表里的具体短语写回提示词当作「判据」。
    expect(system).not.toContain('仿佛|犹如')
  })

  it('tells the model to judge by meaning, not by a fixed word list', () => {
    const { system } = buildStyleReviewPrompt(request)
    expect(system).toContain('按**意思**判断')
    expect(system).toContain('不写连接词的比喻仍是比喻')
  })

  it('requires a verbatim quote per issue', () => {
    expect(buildStyleReviewPrompt(request).system).toContain('逐字引用')
  })
})

describe('parseStyleReview', () => {
  it('accepts an issue whose quote is in that chapter and whose kind is known', () => {
    const raw = JSON.stringify({ issues: [{
      chapterNumber: 5, kind: 'summary-tail', quote: '他知道，这一切才刚刚开始。', explanation: '段尾替读者总结。',
    }] })
    expect(parseStyleReview(raw, request)).toEqual([{
      chapterNumber: 5, kind: 'summary-tail', quote: '他知道，这一切才刚刚开始。', explanation: '段尾替读者总结。',
    }])
  })

  it('drops an issue whose kind is outside the four axes', () => {
    const raw = JSON.stringify({ issues: [{ chapterNumber: 5, kind: 'wordy', quote: '他的手在抖。', explanation: 'x' }] })
    expect(parseStyleReview(raw, request)).toEqual([])
  })

  it('drops an issue whose quote is not verbatim in that chapter', () => {
    const raw = JSON.stringify({ issues: [{ chapterNumber: 5, kind: 'metaphor', quote: '他的手抖得像筛糠。', explanation: 'x' }] })
    expect(parseStyleReview(raw, request)).toEqual([])
  })

  it('rejects malformed output instead of silently adopting nothing', () => {
    expect(parseStyleReview('不是 JSON', request)).toBeNull()
    expect(parseStyleReview('{"items":[]}', request)).toBeNull()
  })

  it('treats an empty answer as legitimate', () => {
    expect(parseStyleReview('{"issues":[]}', request)).toEqual([])
  })
})

describe('styleIssueFindings', () => {
  it('keys on chapter and kind, so ack stays valid as the book advances', () => {
    const findings = styleIssueFindings([
      { chapterNumber: 5, kind: 'metaphor', quote: 'q', explanation: 'e' },
    ])
    expect(findings[0]!.stableFactKey).toBe('prose-flavor:metaphor:5')
    expect(findings[0]!.evidence).toContain('比喻堆叠')
  })
})
