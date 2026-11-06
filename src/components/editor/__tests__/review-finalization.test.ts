import { describe, expect, it } from 'vitest'

import { finalizationReviewBlocked, unhandledReviewFindings, type FinalizationReviewItem } from '../review-finalization'

const item = (decision: FinalizationReviewItem['decision'], findingStatus?: FinalizationReviewItem['findingStatus']): FinalizationReviewItem => ({
  decision,
  findingStatus,
})

describe('review finalization gate', () => {
  it.each(['unverified', 'unknown', 'resolved', 'author-waived', undefined] as const)(
    'does not block a confirmed %s finding',
    findingStatus => expect(finalizationReviewBlocked([item('apply', findingStatus)], true)).toBe(false),
  )

  it('blocks a confirmed applied finding that remains unresolved', () => {
    expect(finalizationReviewBlocked([item('apply', 'unresolved')], true)).toBe(true)
  })

  it('does not block unresolved findings the author did not apply or has not confirmed', () => {
    expect(finalizationReviewBlocked([item('ignore', 'unresolved')], true)).toBe(false)
    expect(finalizationReviewBlocked([item('apply', 'unresolved')], false)).toBe(false)
  })
})

/**
 * issue #230：审稿已经看见、但作者没处理就定稿——那个事实不能静默流失。
 *
 * 现场是审稿报告整个没被确认（E2E 生成后直接定稿），cycle 里的发现从没进过确认清单；
 * `finalizationReviewBlocked` 只拦「已确认 apply 且 unresolved」，于是这一条静默流走。
 * `unhandledReviewFindings` 是**提示**不是阻塞：定稿确认框里给一句「审稿有 N 条发现还没处理」，
 * 作者有权坚持定稿。
 */
describe('unhandled review findings shown at the finalize dialog (issue #230)', () => {
  it('counts nothing when the review was never confirmed (nothing was decided yet)', () => {
    // 报告未确认 = 清单尚未生效；提示发生在确认页，不在这里（阻塞口径同样不动）。
    expect(unhandledReviewFindings([item('apply', 'unresolved')], false)).toBe(0)
  })

  it('counts applied findings still sitting in a pre-resolution status', () => {
    expect(unhandledReviewFindings([item('apply', 'unresolved')], true)).toBe(1)
    expect(unhandledReviewFindings([item('apply', 'unverified')], true)).toBe(1)
    expect(unhandledReviewFindings([item('apply', 'unknown')], true)).toBe(1)
    expect(unhandledReviewFindings([item('apply', undefined)], true)).toBe(1)
  })

  it('does not count findings the author settled (resolved, waived, ignored)', () => {
    expect(unhandledReviewFindings([item('apply', 'resolved')], true)).toBe(0)
    expect(unhandledReviewFindings([item('apply', 'author-waived')], true)).toBe(0)
    expect(unhandledReviewFindings([item('ignore', 'unresolved')], true)).toBe(0)
    expect(unhandledReviewFindings([item('waive', 'unresolved')], true)).toBe(0)
  })

  it('counts only the unhandled ones in a mixed list', () => {
    const items = [item('apply', 'resolved'), item('apply', 'unresolved'), item('ignore', 'unverified')]
    expect(unhandledReviewFindings(items, true)).toBe(1)
  })

  it('never blocks on its own: an unhandled finding does not flip the gate', () => {
    // 提示与阻塞是两个口径：unresolved + apply 已由 finalizationReviewBlocked 负责（true），
    // 但 unverified + apply 只提示、不阻塞。
    expect(finalizationReviewBlocked([item('apply', 'unverified')], true)).toBe(false)
    expect(unhandledReviewFindings([item('apply', 'unverified')], true)).toBe(1)
  })
})
