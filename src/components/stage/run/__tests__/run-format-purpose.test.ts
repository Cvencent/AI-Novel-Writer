import { describe, expect, it } from 'vitest'

import { callPurpose } from '../run-format'
import { REVIEW_WAIT_LABELS, isReviewWaitOperation } from '../../../../shared/review-wait'

const text = (zh: string) => zh

describe('callPurpose (issue #12)', () => {
  it('maps the purposes observed in a real project ledger', () => {
    expect(callPurpose('chapter-blueprint-directory', text)).toBe('生成蓝图')
    expect(callPurpose('chapter-draft', text)).toBe('写正文')
    expect(callPurpose('finalized-chapter-notes', text)).toBe('章节要点')
    expect(callPurpose('finalized-character-state', text)).toBe('角色状态')
    expect(callPurpose('review-chapter', text)).toBe('审稿')
  })

  it('collapses parameterized purpose keys into family labels', () => {
    expect(callPurpose('plot-outline:chapter:7:normal', text)).toBe('写细纲')
    expect(callPurpose('plot-outline:chapter:1:compact', text)).toBe('写细纲')
    expect(callPurpose('arc-outline:from:1', text)).toBe('生成粗纲')
    expect(callPurpose('arc-outline:revise:3', text)).toBe('生成粗纲')
    expect(callPurpose('chapter-blueprint-directory:compact-single:chapter-4', text)).toBe('生成蓝图')
    expect(callPurpose('finalize-sync:chapter:2', text)).toBe('定稿同步')
    expect(callPurpose('editor-ai-polish', text)).toBe('编辑器改写')
  })

  it('falls back to the raw key for unknown purposes', () => {
    expect(callPurpose('some-future-purpose', text)).toBe('some-future-purpose')
    expect(callPurpose('', text)).toBe('—')
  })
})

/**
 * issue #152：`review-chapter-rebuild` 是审稿的救援重建，界面上必须与普通审稿同样对待。
 *
 * 崩溃现场（README 级事实）：审稿 257 秒撞顶 → 触发 rebuild → rebuild 刚启动页面崩了。
 * 而「已等待 N 秒」提示只认 `review-chapter`，所以最长那段等待没有任何反馈。
 */
describe('审稿等待的用途归并 (issue #152)', () => {
  it('labels the rescue rebuild distinctly so the author knows it is a second attempt', () => {
    expect(isReviewWaitOperation('review-chapter-rebuild')).toBe(true)
    expect(REVIEW_WAIT_LABELS['review-chapter-rebuild']).toEqual(['审稿（重建报告）', 'Review (rebuilding the report)'])
  })

  it('keeps the first review call label unchanged', () => {
    expect(REVIEW_WAIT_LABELS['review-chapter']).toEqual(['审稿', 'Review'])
  })
})
