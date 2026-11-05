import { describe, expect, it } from 'vitest'

import { CONTENT_AXES, buildContentReviewPrompt, contentReviewFindings, parseContentReview } from '../content-review'

const CHAPTERS = [
  { chapterNumber: 3, content: '他蹲下来，把风灯搁在膝盖边。纸角在衬页里没了。' },
  { chapterNumber: 7, content: '他蹲下去，风灯放在膝上。册子被收走。' },
]
const request = { chapters: CHAPTERS, axes: ['repeated-reaction', 'prop-terminal'] as const, language: 'zh-CN' as const }

/**
 * 几族「重复写法 / 道具链 / 陈旧时长」判据改由模型判断（用户 2026-11-05）。
 *
 * 旧实现靠 `POSTURE_PHRASES = ['蹲','俯身',…]`、`TERMINAL_ACTIONS = ['解开','烧掉',…]`
 * 这类题材动词表——用户明确否掉：「不能去设计词表，也不能用任何的短语匹配」。
 */
describe('buildContentReviewPrompt', () => {
  it('describes each axis as a phenomenon, not as a word list', () => {
    const { system } = buildContentReviewPrompt(request)
    expect(system).toContain(CONTENT_AXES['repeated-reaction'][0])
    expect(system).toContain(CONTENT_AXES['prop-terminal'][0])
    // 轴名里不许出现题材词（那只是「问什么」，不是「按什么词找」）。
    for (const [zh] of Object.values(CONTENT_AXES)) expect(zh).not.toContain('蹲|俯身')
  })

  it('judges by meaning and requires a verbatim quote', () => {
    const { system } = buildContentReviewPrompt(request)
    expect(system).toContain('按**意思**判断')
    expect(system).toContain('同一个动作换措辞写仍然算')
    expect(system).toContain('逐字引用')
  })

  it('only asks the axes the caller selected', () => {
    const { system } = buildContentReviewPrompt(request)
    expect(system).not.toContain(CONTENT_AXES['stale-duration'][0])
  })
})

describe('parseContentReview', () => {
  const raw = (issues: unknown) => JSON.stringify({ issues })

  it('accepts an issue with a known axis and a locatable quote', () => {
    expect(parseContentReview(raw([{
      chapterNumber: 7, axis: 'repeated-reaction', quote: '他蹲下去，风灯放在膝上。', explanation: '同一个起手动作。',
    }]), request)).toEqual([{
      chapterNumber: 7, axis: 'repeated-reaction', quote: '他蹲下去，风灯放在膝上。', explanation: '同一个起手动作。',
    }])
  })

  it('drops an axis the caller did not ask about', () => {
    expect(parseContentReview(raw([{
      chapterNumber: 7, axis: 'stale-duration', quote: '他蹲下去，风灯放在膝上。', explanation: 'x',
    }]), request)).toEqual([])
  })

  it('drops a quote that is not verbatim in that chapter', () => {
    expect(parseContentReview(raw([{
      chapterNumber: 7, axis: 'repeated-reaction', quote: '他蹲在膝边。', explanation: 'x',
    }]), request)).toEqual([])
    // 引文在另一章里也不算（章号必须对）。
    expect(parseContentReview(raw([{
      chapterNumber: 3, axis: 'repeated-reaction', quote: '他蹲下去，风灯放在膝上。', explanation: 'x',
    }]), request)).toEqual([])
  })

  it('rejects malformed output, accepts an empty answer', () => {
    expect(parseContentReview('不是 JSON', request)).toBeNull()
    expect(parseContentReview('{"issues":{}}', request)).toBeNull()
    expect(parseContentReview(raw([]), request)).toEqual([])
  })
})

describe('contentReviewFindings', () => {
  it('keys on axis and chapter', () => {
    const [finding] = contentReviewFindings([{
      chapterNumber: 7, axis: 'prop-terminal', quote: '册子被收走。', explanation: 'e',
    }])
    expect(finding!.stableFactKey).toBe('prose:prop-terminal:7')
    expect(finding!.severity).toBe('warning')
  })
})

/**
 * issue #164：同章同轴的两条必须**合并成一条**，而不是同 key 的两条。
 *
 * 原本 key 只含 `轴 + 章号`，而提示词允许「每类最多 3 条」→ 第 1、2 条同 key：
 * React 列表复用错节点、**ack 按 key 精确匹配会把没修的那条一起静默掉**、
 * `findingByKey` 只留最后一条（#120 的标题错配）。
 */
describe('同章同轴的合并 (issue #164)', () => {
  it('merges two quotes on the same axis into one finding, keeping both as evidence', () => {
    const findings = contentReviewFindings([
      { chapterNumber: 7, axis: 'repeated-reaction', quote: '他蹲下去。', explanation: '同一个起手动作' },
      { chapterNumber: 7, axis: 'repeated-reaction', quote: '他把风灯搁在膝上。', explanation: '同一个落手动作' },
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0]!.stableFactKey).toBe('prose:repeated-reaction:7')
    // 两句都要出现在证据里，否则作者只看到一半。
    expect(findings[0]!.evidence).toContain('他蹲下去')
    expect(findings[0]!.evidence).toContain('他把风灯搁在膝上')
    expect(findings[0]!.evidence).toContain('2 处')
  })

  it('keeps different axes and different chapters separate', () => {
    const findings = contentReviewFindings([
      { chapterNumber: 7, axis: 'repeated-reaction', quote: 'a', explanation: '' },
      { chapterNumber: 7, axis: 'prop-terminal', quote: 'b', explanation: '' },
      { chapterNumber: 8, axis: 'repeated-reaction', quote: 'c', explanation: '' },
    ])
    expect(findings.map(item => item.stableFactKey)).toEqual([
      'prose:repeated-reaction:7', 'prose:prop-terminal:7', 'prose:repeated-reaction:8',
    ])
  })

  it('every emitted key is unique — the exit guard’s invariant', () => {
    const findings = contentReviewFindings([
      { chapterNumber: 7, axis: 'repeated-reaction', quote: 'a', explanation: '' },
      { chapterNumber: 7, axis: 'repeated-reaction', quote: 'b', explanation: '' },
      { chapterNumber: 7, axis: 'repeated-reaction', quote: 'c', explanation: '' },
    ])
    expect(new Set(findings.map(item => item.stableFactKey)).size).toBe(findings.length)
  })
})
