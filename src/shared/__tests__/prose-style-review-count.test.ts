import { describe, expect, it } from 'vitest'

import {
  STYLE_KIND_LABELS,
  buildStyleReviewPrompt,
  countOccurrences,
  parseStyleReview,
  styleIssueFindings,
} from '../prose-style-review'

/**
 * issue #177：「核对文风」判「同一个词反复承担情绪」时**不看这个词出现了几次**。
 *
 * 现场（5 次独立调用、40 条判据）：点名了具体词的 15 条里 **7 条那个词只出现 2 次** ——
 * 正好是产品自己起草清单写的上限（`builtin-prompt-templates.ts:879`
 * 「每个词在本章最多出现 2 次」）。起草侧把 2 次当**上限**、核实侧把 2 次当**反复**，
 * 两个口径直接打架。
 *
 * 还有一条「布角」连自己的引文里都没有那两个字（引文写的是「那角布」）——
 * `parseStyleReview` 只校验「引文能逐字定位」，**没校验被点名的词是否在自己的引文里**。
 */
const chapter = (content: string) => [{ chapterNumber: 75, content }]

describe('countOccurrences (issue #177)', () => {
  it('counts verbatim occurrences only', () => {
    expect(countOccurrences('名册照列。名册里还有我。', '名册')).toBe(2)
    expect(countOccurrences('名册照列。', '名册')).toBe(1)
    expect(countOccurrences('名册照列。', '名册上')).toBe(0)
  })

  it('returns 0 for an empty word (nothing to count)', () => {
    expect(countOccurrences('名册照列。', '   ')).toBe(0)
  })
})

describe('提示词要看次数 (issue #177 建议 ①)', () => {
  it('tells the model that twice is an echo, not a problem', () => {
    const { system } = buildStyleReviewPrompt({ chapters: chapter('名册照列。'), language: 'zh-CN' })
    // 2 次是呼应——与起草清单那条「每词每章最多 2 次」的口径对齐。
    expect(system).toContain('2 次是**呼应**')
    expect(system).toContain('5 次以上')
  })

  it('asks for subject and occurrences, and requires the word to appear in its own quote', () => {
    const { system } = buildStyleReviewPrompt({ chapters: chapter('名册照列。'), language: 'zh-CN' })
    expect(system).toContain('subject')
    expect(system).toContain('occurrences')
    // 「报告的词与引用的句子必须对得上」——这是结构要求，不涉及内容判断。
    expect(system).toContain('必须出现在你自己的 quote 里')
  })

  it('drops the vague 「反复」 from the axis label (issue #177 建议 ④)', () => {
    // 「反复」是含糊的量（2 次可以是呼应，6 次才是摩挲），而起草清单把 2 次写成上限。
    expect(STYLE_KIND_LABELS.motif[0]).not.toContain('反复')
  })
})

describe('parseStyleReview 结构校验 (issue #177 建议 ③)', () => {
  const body = '名册照列。他把名册合上。'
  const request = { chapters: chapter(body) }

  const motif = (extra: Record<string, unknown>) => JSON.stringify({
    issues: [{ chapterNumber: 75, kind: 'motif', quote: '名册照列。', ...extra }],
  })

  it('keeps a motif whose subject really appears in its own quote, and recounts the occurrences itself', () => {
    // 模型报 9 次——**不信它**，规则自己数（正文里「名册」出现 2 次）。
    const parsed = parseStyleReview(motif({ subject: '名册', occurrences: 9 }), request)
    expect(parsed).toHaveLength(1)
    expect(parsed![0]!.subject).toBe('名册')
    expect(parsed![0]!.occurrences).toBe(2)
  })

  it('drops a motif whose subject does not appear in its own quote', () => {
    // 现场那条：判据说「布角」反复，引文却是「那角布」——两个字都不在引文里。
    const wrong = JSON.stringify({
      issues: [{ chapterNumber: 75, kind: 'motif', quote: '他把名册合上。', subject: '名册照列' }],
    })
    expect(parseStyleReview(wrong, request)).toEqual([])
  })

  it('drops a motif with no subject at all (the author cannot check what word it means)', () => {
    expect(parseStyleReview(motif({}), request)).toEqual([])
  })

  it('leaves the other three axes without subject/occurrences', () => {
    const parsed = parseStyleReview(JSON.stringify({
      issues: [{ chapterNumber: 75, kind: 'summary-tail', quote: '名册照列。', explanation: 'x' }],
    }), request)
    expect(parsed).toHaveLength(1)
    expect(parsed![0]!.subject).toBeUndefined()
    expect(parsed![0]!.occurrences).toBeUndefined()
  })
})

describe('卡片要写明次数 (issue #177 建议 ②)', () => {
  it('prints the word and how many times it occurs', () => {
    const [finding] = styleIssueFindings([{
      chapterNumber: 79, kind: 'motif', quote: '绳头朝里。', subject: '绳', occurrences: 7, explanation: '同一根绳',
    }])
    // 作者要有依据决定改不改——原来卡片上不给次数，只能自己回正文里数。
    expect(finding!.evidence).toContain('绳')
    expect(finding!.evidence).toContain('7 次')
  })

  it('tells the author that twice is fine, before telling them how to rewrite', () => {
    const [finding] = styleIssueFindings([{
      chapterNumber: 68, kind: 'motif', quote: '布角从舵板上揭起来。', subject: '布角', occurrences: 2, explanation: 'x',
    }])
    // 2 次是起草清单自订的上限，不是「反复」——必须先说清这一句，否则作者会把合规的词也改掉。
    expect(finding!.suggestion.zhCN).toContain('2 次是呼应')
  })

  it('does not add the count sentence to the other axes', () => {
    const [finding] = styleIssueFindings([{
      chapterNumber: 68, kind: 'metaphor', quote: '像一层壳。', explanation: 'x',
    }])
    expect(finding!.suggestion.zhCN).not.toContain('2 次是呼应')
  })
})