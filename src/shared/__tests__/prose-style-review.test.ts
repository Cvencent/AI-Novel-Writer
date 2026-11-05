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

/** issue #164：同章同类合并成一条（与 content-review 同一形态）。 */
describe('styleIssueFindings 同章同类合并 (issue #164)', () => {
  it('merges and keeps both quotes', () => {
    const findings = styleIssueFindings([
      { chapterNumber: 7, kind: 'metaphor', quote: '他的手抖得像筛糠。', explanation: '比喻一' },
      { chapterNumber: 7, kind: 'metaphor', quote: '灯影像一尾鱼。', explanation: '比喻二' },
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0]!.stableFactKey).toBe('prose-flavor:metaphor:7')
    expect(findings[0]!.evidence).toContain('2 处')
    expect(new Set(findings.map(item => item.stableFactKey)).size).toBe(findings.length)
  })
})

/**
 * issue #161：`motif` 轴必须排除**术语 / 场所 / 关键概念**。
 *
 * 旧判据（已随 `prose-flavor.ts` 删除）靠「词频 × 位置」：第 75 章「经手」6 次
 * （6 次全在台词里，且从没被处置过）被判成「反复承担情绪的意象」，唯一依据是
 * 「**按**经手人处置」这个错位窗口。12 条命中里至少 3 条（经手/调阅/案桌）是这个错。
 */
describe('motif 轴排除术语与场所 (issue #161)', () => {
  it('tells the model that terminology is not a motif', () => {
    const { system } = buildStyleReviewPrompt(request)
    expect(system).toContain('术语/职务/单据名')
    // 现场的具体形态要写明，否则模型不知道「经手人」这类算术语。
    expect(system).toContain('经手人')
    expect(system).toContain('调阅条')
  })

  it('tells the model that a place is not a motif', () => {
    const { system } = buildStyleReviewPrompt(request)
    expect(system).toContain('场所')
    expect(system).toContain('案桌上')
  })

  it('tells the model that a concept the reader must remember is not a motif', () => {
    const { system } = buildStyleReviewPrompt(request)
    expect(system).toContain('必须记住')
  })

  it('keeps the positive criterion: only mood-only words count', () => {
    // 判据的正面仍是「换掉也不影响理解、纯粹用来抒情」——不是「一个词出现多次就报」。
    const { system } = buildStyleReviewPrompt(request)
    expect(system).toContain('换掉也不影响理解')
  })
})
