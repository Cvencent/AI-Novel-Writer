/**
 * 「这次生成属于哪一段任务」的判定（issue #152）。
 *
 * 现场：审稿并定稿第 25 章时渲染进程崩溃（`Page crashed`），崩溃前审稿已跑 398 秒。
 * `generation_attempts` 显示：`review-chapter` 撞顶 257 秒 → 触发救援路径
 * `review-chapter-rebuild` → **rebuild 刚启动就崩了**。
 *
 * 而界面上的「已等待 N 秒 / 距最近响应…」提示只在 `operation === 'review-chapter'`
 * 时渲染——也就是说**最长的那一段等待（rebuild 走 32k 上限，比普通审稿更久）
 * 完全没有提示**，作者看到的是一个不动的进度圈。这不是「文案没写到位」，
 * 是判定只认了一个用途名，而审稿这条链路上**有两个**用途名。
 *
 * 所以把「哪些 purpose 属于同一条等待」收在这里一处，界面只问 `isReviewWait`。
 * 与 `main-generation-plan.ts` 的 `REVIEW_PURPOSES` 同一口径（那两处必须一致：
 * 那边决定输出上限，这边决定界面是否提示「正在等模型说完」）。
 */

/** 属于「审稿整份回复」的用途：普通审稿与它的救援重建。 */
const REVIEW_PURPOSES: ReadonlySet<string> = new Set(['review-chapter', 'review-chapter-rebuild', 'chapter-review'])

/**
 * 这次生成是不是「等模型整份回复」（没有逐字输出）的那一类。
 *
 * ⚠️ 判据是**封闭集合**，不是 `startsWith('review-')`：后者会把将来任何新的
 * `review-*` 用途都算进来，而它们未必是「整份回复、无逐字输出」的形态
 * （例如 `review-outline`/`review-arc-outline` 是可见文本输出，有逐字流）。
 */
export function isReviewWaitOperation(operation: string | undefined | null): boolean {
  return operation !== undefined && operation !== null && REVIEW_PURPOSES.has(operation)
}

/** 该用途的显示名（`run-format.ts` 的 PURPOSES 之外的补充，保持两处不漂）。 */
export const REVIEW_WAIT_LABELS: Readonly<Record<string, [string, string]>> = Object.freeze({
  'review-chapter': ['审稿', 'Review'],
  'review-chapter-rebuild': ['审稿（重建报告）', 'Review (rebuilding the report)'],
  'chapter-review': ['审稿', 'Review'],
})