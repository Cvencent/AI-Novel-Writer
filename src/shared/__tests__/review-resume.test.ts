import { describe, expect, it } from 'vitest'

import { canAttemptReviewPurpose, reviewResumeRoute } from '../review-resume'

/**
 * issue #152：崩溃现场的**续跑路线**。
 *
 * `generation_attempts` 的现场是：
 *
 * ```
 * review-chapter          finishReason=length  elapsedMs=257505   ← 撞顶
 * review-chapter-rebuild  finishReason=NULL    elapsedMs=NULL     ← 崩在这里，未结算
 * ```
 *
 * 重开之后必须判断出「上次走到 rebuild 就断了，直接接着 rebuild」——否则作者
 * 要再等一次 400 秒。这段判断原来内联在命令里（夹在材料装配与模型调用之间），
 * 抽成纯函数后才钉得住。
 */
describe('reviewResumeRoute (issue #152)', () => {
  it('resumes straight into the rebuild after a crash leaves an unsettled rebuild attempt', () => {
    // 崩溃留下的正是这个形态：attempt 有记录、产物没结算（finishReason 读不到）。
    expect(reviewResumeRoute({
      attemptedPurposes: ['review-chapter', 'review-chapter-rebuild', 'review-chapter'],
      latestArtifactFinishReason: null,
      hasLatestArtifact: false,
    })).toEqual({ kind: 'rebuild' })
  })

  it('reuses an artifact that already finished with stop', () => {
    // 上次其实拿到了完整结果、只是没提交 → 先尝试复用，不要重新烧一次审稿。
    expect(reviewResumeRoute({
      attemptedPurposes: ['review-chapter'],
      latestArtifactFinishReason: 'stop',
      hasLatestArtifact: true,
    })).toEqual({ kind: 'reuse-artifact' })
  })

  it('starts with a plain review when nothing has been attempted yet', () => {
    expect(reviewResumeRoute({
      attemptedPurposes: [],
      latestArtifactFinishReason: null,
      hasLatestArtifact: false,
    })).toEqual({ kind: 'review' })
  })

  it('does not treat an unsettled attempt as a reusable artifact', () => {
    // ⚠️ finishReason 为 null 时**不能**当成 'stop' 去解析一份不存在的产物。
    expect(reviewResumeRoute({
      attemptedPurposes: [],
      latestArtifactFinishReason: null,
      hasLatestArtifact: true,
    })).toEqual({ kind: 'review' })
  })

  it('does not treat a length-exhausted attempt as reusable either', () => {
    expect(reviewResumeRoute({
      attemptedPurposes: ['review-chapter'],
      latestArtifactFinishReason: 'length',
      hasLatestArtifact: true,
    })).toEqual({ kind: 'review' })
  })
})

describe('canAttemptReviewPurpose (issue #152)', () => {
  it('allows each purpose up to two attempts and then stops', () => {
    expect(canAttemptReviewPurpose([], 'review-chapter')).toBe(true)
    expect(canAttemptReviewPurpose(['review-chapter'], 'review-chapter')).toBe(true)
    // 第三次不再发：这条上限是「不许无限重试烧钱」的那道闸。
    expect(canAttemptReviewPurpose(['review-chapter', 'review-chapter'], 'review-chapter')).toBe(false)
    expect(canAttemptReviewPurpose(['review-chapter-rebuild'], 'review-chapter-rebuild')).toBe(true)
    expect(canAttemptReviewPurpose(['review-chapter-rebuild', 'review-chapter-rebuild'], 'review-chapter-rebuild')).toBe(false)
  })

  it('counts purposes independently', () => {
    // 普通审稿用满两次不影响重建的那两次。
    expect(canAttemptReviewPurpose(['review-chapter', 'review-chapter'], 'review-chapter-rebuild')).toBe(true)
  })
})
