import { describe, expect, it } from 'vitest'
import {
  clearReviewChecklistDraft,
  getReviewChecklistDraft,
  parseReviewChecklistDraftLedger,
  persistReviewChecklistDraft,
  REVIEW_CHECKLIST_DRAFT_TAB_ID,
  type ReviewChecklistDraft,
} from '../review-checklist-draft'

function writer() {
  const store: Record<string, string> = {}
  return { store, ...store, draftLedgers: store, setDraftLedger(key: string, content: string) { store[key] = content } }
}

const draft = (over: Partial<ReviewChecklistDraft> = {}): ReviewChecklistDraft => ({
  draftId: 3, reviewId: 4, items: [], authorGuidance: '', savedAt: '', ...over,
})

describe('review checklist draft ledger', () => {
  it('persists and reads back an editing checklist', () => {
    const w = writer()
    persistReviewChecklistDraft(w, 'C:/p', draft({ authorGuidance: '保持克制', items: [{ id: 'author-1', reviewItemIndex: 0, category: '作者补充', severity: 'warning', description: '突兀', decision: 'apply', origin: 'author' }] }))
    const ledger = parseReviewChecklistDraftLedger(w.store[REVIEW_CHECKLIST_DRAFT_TAB_ID])
    expect(getReviewChecklistDraft(ledger, 'C:/p', 3, 4)?.authorGuidance).toBe('保持克制')
    expect(getReviewChecklistDraft(ledger, 'C:/p', 3, 4)?.items).toHaveLength(1)
  })

  it('keeps one editing checklist per draft+review and other projects', () => {
    const w = writer()
    persistReviewChecklistDraft(w, 'C:/p', draft({ authorGuidance: 'v1' }))
    persistReviewChecklistDraft(w, 'C:/p', draft({ authorGuidance: 'v2' }))
    persistReviewChecklistDraft(w, 'C:/other', draft({ draftId: 9, reviewId: 1, authorGuidance: 'x' }))
    const ledger = parseReviewChecklistDraftLedger(w.store[REVIEW_CHECKLIST_DRAFT_TAB_ID])
    expect(getReviewChecklistDraft(ledger, 'C:/p', 3, 4)?.authorGuidance).toBe('v2')
    expect(getReviewChecklistDraft(ledger, 'C:/other', 9, 1)?.authorGuidance).toBe('x')
  })

  it('clears the draft after confirmation', () => {
    const w = writer()
    persistReviewChecklistDraft(w, 'C:/p', draft())
    clearReviewChecklistDraft(w, 'C:/p', 3, 4)
    expect(getReviewChecklistDraft(parseReviewChecklistDraftLedger(w.store[REVIEW_CHECKLIST_DRAFT_TAB_ID]), 'C:/p', 3, 4)).toBeUndefined()
  })

  it('tolerates corrupt ledger content', () => {
    expect(parseReviewChecklistDraftLedger('{broken')).toEqual({ version: 1, projects: [] })
  })
})

/**
 * 编辑部评审并入 AI 审稿后，五角色发现要**自动**进清单（作者点一次审稿就够）。
 * 自动并入必须幂等：作者删掉某条发现后，侧页重挂载不能把它塞回来——否则像删不掉。
 * 幂等靠账本里的 `mergedEditorialKeys`（已并入过的 `描述|证据` 键）。
 */
describe('editorial auto-merge ledger (issue #245 现场)', () => {
  const item = (id: string, description: string) => ({
    id, reviewItemIndex: 0, category: '编辑部评审·情节', severity: 'warning' as const,
    description, decision: 'apply' as const, origin: 'author' as const,
  })

  it('round-trips the merged keys so a removal stays removed', () => {
    const w = writer()
    persistReviewChecklistDraft(w, 'C:/p', draft({ mergedEditorialKeys: ['遗漏巡逻队|原文'], items: [item('editorial-1', '遗漏巡逻队')] }))
    const restored = getReviewChecklistDraft(parseReviewChecklistDraftLedger(w.store[REVIEW_CHECKLIST_DRAFT_TAB_ID]), 'C:/p', 3, 4)
    expect(restored?.mergedEditorialKeys).toEqual(['遗漏巡逻队|原文'])
    expect(restored?.items).toHaveLength(1)
  })

  it('treats the merged keys as optional (older ledgers stay readable)', () => {
    const w = writer()
    persistReviewChecklistDraft(w, 'C:/p', draft())
    const restored = getReviewChecklistDraft(parseReviewChecklistDraftLedger(w.store[REVIEW_CHECKLIST_DRAFT_TAB_ID]), 'C:/p', 3, 4)
    expect(restored?.mergedEditorialKeys).toBeUndefined()
  })
})
