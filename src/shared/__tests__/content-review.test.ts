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

/**
 * issue #185：一次调用返回 5 条、覆盖 3 个不同的轴，而**建议与解释逐字相同**。
 *
 * 那句「换这一拍的落点」对 `repeated-reaction` / `repeated-device` 成立，
 * 对 `prop-terminal`（该删一次终结）/ `prop-moved`（该补交接动作）/
 * `stale-duration`（该统一时长）**根本讲不通**：作者照字面做，
 * 会把「铜墨盒昨夜已交稽核组封存」换成另一句话，而真正缺的是那次交接动作。
 *
 * 另外轴名原来只在「来源」行的括号里，正文里完全没有 —— 作者看到 5 条一样的建议时无从分辨。
 */
describe('按轴给建议与解释 (issue #185)', () => {
  const issue = (axis: any, chapterNumber = 83) => ({
    chapterNumber, axis, quote: `第${chapterNumber}章的某一句。`, explanation: '模型的一句话',
  })

  const suggestionsOf = (axis: any) => contentReviewFindings([issue(axis)] as never)[0]!.suggestion.zhCN

  it('gives prop-moved the handover fix, not the "change the beat" fix', () => {
    const text = suggestionsOf('prop-moved')
    expect(text).toContain('交接')
    expect(text).not.toContain('换这一拍的落点')
  })

  it('gives prop-terminal the delete/explain fix', () => {
    const text = suggestionsOf('prop-terminal')
    expect(text).toContain('删掉')
    expect(text).not.toContain('换这一拍的落点')
  })

  it('gives stale-duration the unify-the-duration fix', () => {
    const text = suggestionsOf('stale-duration')
    expect(text).toContain('统一')
    expect(text).not.toContain('换这一拍的落点')
  })

  it('keeps the "change the beat" fix for the two repeated-* axes', () => {
    expect(suggestionsOf('repeated-reaction')).toContain('换这一拍的落点')
    expect(suggestionsOf('repeated-device')).toContain('开场装置')
  })

  it('five findings on five axes no longer share one suggestion string', () => {
    const axes = ['repeated-reaction', 'repeated-device', 'prop-terminal', 'prop-moved', 'stale-duration'] as const
    const texts = axes.map(axis => contentReviewFindings([issue(axis)] as never)[0]!.suggestion.zhCN)
    expect(new Set(texts).size).toBe(5)
  })

  it('names the axis inside the card text, not only in the source line', () => {
    // issue #185 建议 ③：作者要能一眼看出「这条是「道具换手没交接」还是「同一状态两个时长」」。
    const [finding] = contentReviewFindings([issue('stale-duration')] as never)
    expect(finding!.issue.zhCN).toContain('同一处状态')
    expect(finding!.issue.enUS).toContain('incompatible durations')
    // 解释串也按轴取：这句「读者读到的是流程」不该出现在 stale-duration 上。
    expect(finding!.issue.zhCN).not.toContain('读者读到的是流程')
  })

  it('keeps the per-chapter+axis key so acknowledgement stays exact', () => {
    const [finding] = contentReviewFindings([issue('prop-moved', 82)] as never)
    expect(finding!.stableFactKey).toBe('prose:prop-moved:82')
  })
})
