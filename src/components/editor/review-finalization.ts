import type { HumanConfirmedReviewDecision } from '../../shared/human-confirmed-review'
import type { ReviewFindingStatus } from '../../shared/review-cycle'

export interface FinalizationReviewItem {
  decision: HumanConfirmedReviewDecision
  findingStatus?: ReviewFindingStatus
}

/**
 * Finalization is blocked only by a confirmed, applied finding that remains
 * unresolved. Unverified or unknown evidence is not a confirmed defect.
 */
export function finalizationReviewBlocked(
  items: readonly FinalizationReviewItem[],
  reviewConfirmed: boolean,
): boolean {
  if (!reviewConfirmed) return false
  return items.some(item => item.decision === 'apply' && item.findingStatus === 'unresolved')
}
