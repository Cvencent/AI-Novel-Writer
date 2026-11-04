/**
 * 「这次审稿该走哪条路」的决定（issue #152 抽出的纯函数）。
 *
 * 原本这段判断内联在 `ReviewChapterCommand.executeWithRuntime` 里，夹在材料装配、
 * 提示词拼接与模型调用之间——**崩溃恢复正是靠它决定走哪条路**，却因为没有独立入口
 * 而无法被断言。崩溃现场（常驻测试书第 25 章）是：
 *
 * ```
 * review-chapter          finishReason=length  elapsedMs=257505   ← 撞顶
 * review-chapter-rebuild  finishReason=NULL    elapsedMs=NULL     ← 崩在这里，未结算
 * ```
 *
 * 重开之后必须能判断出「上次走到 rebuild 就断了，直接接着 rebuild」，否则作者要
 * 再等一次 400 秒。把这段抽出来之后，这条判断就有了可以钉住的断言面。
 *
 * ⚠️ 抽出时**没有改变任何行为**：三条分支与 `executeWithRuntime` 里的原顺序逐条对应。
 */

export interface ReviewAttemptState {
  /** 这个运行已经尝试过的用途（按发生顺序）。 */
  attemptedPurposes: readonly string[]
  /**
   * 最近一次产物的 finishReason。
   *
   * ⚠️ 崩溃留下的那次 attempt **没有结算**，所以这里是 `null`/`undefined`——
   * 不能把它当成 `'length'`（那会误判成「需要重建」而跳过可复用的完整产物），
   * 也不能当成 `'stop'`（那会去解析一份不存在的产物）。
   */
  latestArtifactFinishReason: string | null | undefined
  /** 最近一次产物是否存在且有文本。 */
  hasLatestArtifact: boolean
}

/** 接下来该怎么走。 */
export type ReviewResumeRoute =
  /** 复用已有产物（上次已经拿到完整结果，只是没提交）。 */
  | { kind: 'reuse-artifact' }
  /** 先发一次普通审稿。 */
  | { kind: 'review' }
  /** 直接发救援重建（普通审稿已撞顶/产物不可用，或上次就断在 rebuild）。 */
  | { kind: 'rebuild' }

/**
 * 判断续跑路线。
 *
 * 三种情况：
 * 1. 上次产物 `finishReason === 'stop'`：先尝试复用（能不能真的复用由解析决定，
 *    解析失败时调用方再转重建——这里只回答「先看哪一步」）；
 * 2. 已经尝试过 `review-chapter-rebuild`：说明普通审稿这条路已经不行了，**直接重建**
 *    ——这就是崩溃现场的续跑形态；
 * 3. 其余：先正常审稿。
 */
export function reviewResumeRoute(state: ReviewAttemptState): ReviewResumeRoute {
  if (state.hasLatestArtifact && state.latestArtifactFinishReason === 'stop') return { kind: 'reuse-artifact' }
  if (state.attemptedPurposes.includes('review-chapter-rebuild')) return { kind: 'rebuild' }
  return { kind: 'review' }
}

/** 该用途是否还能再发一次（每个用途上限 2 次）。 */
export function canAttemptReviewPurpose(attemptedPurposes: readonly string[], purpose: 'review-chapter' | 'review-chapter-rebuild'): boolean {
  return attemptedPurposes.filter(item => item === purpose).length < 2
}