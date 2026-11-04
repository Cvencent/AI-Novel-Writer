import { describe, expect, it } from 'vitest'

import { isReviewWaitOperation } from '../review-wait'

/**
 * issue #152：审稿并定稿时渲染进程崩溃，崩溃点在**救援重建**阶段
 * （`review-chapter-rebuild`）。而界面上「已等待 N 秒 / 距最近响应…」的提示
 * 只在 `operation === 'review-chapter'` 时渲染——最长的那一段等待反而没有提示。
 */
describe('isReviewWaitOperation (issue #152)', () => {
  it('covers the rescue rebuild, not just the first review call', () => {
    // 崩溃现场的 attempts 顺序：review-chapter 撞顶 257 秒 → review-chapter-rebuild。
    expect(isReviewWaitOperation('review-chapter')).toBe(true)
    expect(isReviewWaitOperation('review-chapter-rebuild')).toBe(true)
  })

  it('does not swallow other review flows that stream visible text', () => {
    // 封闭集合，不是 startsWith('review-')：细纲/粗纲审查有逐字输出，不该走「等整份回复」的文案。
    expect(isReviewWaitOperation('review-outline')).toBe(false)
    expect(isReviewWaitOperation('review-arc-outline')).toBe(false)
    expect(isReviewWaitOperation('review-blueprints')).toBe(false)
    expect(isReviewWaitOperation('chapter-draft')).toBe(false)
  })

  it('treats a missing operation as not waiting', () => {
    expect(isReviewWaitOperation(undefined)).toBe(false)
    expect(isReviewWaitOperation(null)).toBe(false)
    expect(isReviewWaitOperation('')).toBe(false)
  })
})
