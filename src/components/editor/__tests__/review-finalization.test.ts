import { describe, expect, it } from 'vitest'

import { finalizationReviewBlocked, type FinalizationReviewItem } from '../review-finalization'

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
