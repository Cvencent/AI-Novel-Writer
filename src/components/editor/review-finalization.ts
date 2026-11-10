import type { HumanConfirmedReviewDecision } from '../../shared/human-confirmed-review'
import type { ReviewFindingStatus } from '../../shared/review-cycle'

export interface FinalizationReviewItem {
  decision: HumanConfirmedReviewDecision
  findingStatus?: ReviewFindingStatus
  /**
   * 这条是「AI 审稿发现」还是「作者侧条目」（含编辑部评审纳入的那些）。
   *
   * 状态来源不同：AI 发现在 `review_findings` 里有行、状态由 cycle 状态机推进；
   * 作者侧条目**从来没有 findingId**（它们不是可定位到正文的 finding），
   * 于是 `findingStatus` 恒为 `undefined`，永不可能被 resolve。
   */
  origin?: 'ai' | 'author'
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

/**
 * 作者侧条目（`origin === 'author'`）在**修稿合并成功后**算已处理（issue #245 现场）。
 *
 * 现场（`源起` 第 1 章）：作者点了审稿（2 条发现）→ 五角色评审（10 条）→ 勾了全部 12 条
 * → 按 12 条一起修稿 → 合并成功 → 点定稿，得到「这 12 条都未确认」。
 *
 * 那 10 条是 `appendEditorialFindings` 纳入的作者侧条目，**结构上就没有 findingId**：
 *
 * ```ts
 * { id, reviewItemIndex, category, severity, description, quote, decision: 'apply', origin: 'author' }
 * //                          没有 findingId ↓
 * ```
 *
 * 而状态是从 cycle 里按 findingId 反查的（`review-checklist.ts` 的
 * `findingStatus: finding?.status`），于是 `findingStatus` 恒 `undefined` →
 * 无论作者修了几遍、合并多少次，它们**永远**被算作「未处理」。作者越认真改，
 * 这个提示越顽固。
 *
 * 判据只认**已落库的事实**：修稿合并已提交（`mergeCommitted`，由 cycle 的
 * `revisionStatus === 'merge-committed'` 给出）。那时作者勾选的修稿内容确实进了
 * 新正文——「处理过」不再是我替作者推断，而是合并这件事本身证明了它。
 * 未合并（`not-generated` / `generated`）时照旧计入：那时正文还没变。
 */
export function unhandledReviewFindings(
  items: readonly FinalizationReviewItem[],
  reviewConfirmed: boolean,
  mergeCommitted = false,
): number {
  if (!reviewConfirmed) return 0
  return items.filter(item => {
    if (item.decision !== 'apply') return false
    // 作者侧条目没有 findingId 可查状态；合并成功后它们的内容已进正文，算已处理。
    if (item.origin === 'author') return !mergeCommitted
    return item.findingStatus === undefined || UNHANDLED_STATUSES.has(item.findingStatus)
  }).length
}
