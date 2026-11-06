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

/**
 * 定稿确认框要**提示**的「审稿已经看见、但没被处理」的发现（issue #230）。
 *
 * 现场：第 31 章 v3 定稿时审稿 cycle 已抓到「印面拓扑与第 30 章相反」（objective、
 * status=unresolved），但 `finalizationReviewBlocked` 只拦「**已确认走 apply 决策**且 unresolved」
 * 的意见——这一条是审稿直接给出、作者从没在确认清单里做过决策的，于是不在阻塞集里，
 * 定稿照常跑完，「审稿已经看见了」这个事实静默流失。
 *
 * ⚠️ 这是**提示**不是阻塞（作者有权坚持定稿）；阻塞口径（已确认 apply + unresolved）不变。
 *
 * 「没被处理」的两种真实形态：
 * 1. **审稿报告还没被作者确认过**（`reviewConfirmed === false`）——报告躺在那里，
 *    一条意见都没进过确认清单。这正是 #230 现场的那一种（v3 是 E2E 生成后直接定稿，
 *    确认流程整个被跳过）。只要本章有审稿报告且未确认，就计它的意见数（由调用方给）。
 * 2. 确认过，但有些条目作者**没给决策就留下**——decision 是 `apply` 且 status 仍停在
 *    审稿当初的 `unverified` / `unresolved` / `unknown`（没有修稿复验把它 resolve，
 *    作者也没 waive）。`ignore` 是作者看过后明确「不处理」，算已处理；`waive` 同理。
 */
const UNHANDLED_STATUSES: ReadonlySet<ReviewFindingStatus> = new Set(['unverified', 'unresolved', 'unknown'])

export function unhandledReviewFindings(
  items: readonly FinalizationReviewItem[],
  reviewConfirmed: boolean,
): number {
  if (!reviewConfirmed) return 0
  return items.filter(item =>
    item.decision === 'apply' && (item.findingStatus === undefined || UNHANDLED_STATUSES.has(item.findingStatus)),
  ).length
}
