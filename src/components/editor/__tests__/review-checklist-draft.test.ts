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
