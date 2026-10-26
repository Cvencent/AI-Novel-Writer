import type { EditableReviewItem } from './review-checklist'

/**
 * 审稿侧页的「未确认清单」草稿账本。
 *
 * 作者添加的意见、勾选与总体指导在没有走完「确认清单」流程前只存在于内存；
 * 切换标签会卸载审稿侧页组件，没有这份账本时作者意见会悄悄丢掉。
 * 账本挂在 editor-store 的 draftLedgers（内存，应用关闭即清），已确认的快照仍由数据库负责。
 */
export const REVIEW_CHECKLIST_DRAFT_TAB_ID = 'review-checklist-drafts'

export interface ReviewChecklistDraft {
  /** 关联草稿的数据库 id；同一稿只有一份编辑中的清单。 */
  draftId: number
  /** 正在编辑的原始 AI 审稿记录 id。 */
  reviewId: number
  items: EditableReviewItem[]
  authorGuidance: string
  savedAt: string
}

export interface ReviewChecklistDraftLedger {
  version: 1
  projects: Array<{ projectKey: string; drafts: ReviewChecklistDraft[] }>
}

export interface ReviewChecklistDraftWriter {
  draftLedgers: Record<string, string>
  setDraftLedger(key: string, content: string): void
}

export function createEmptyReviewChecklistDraftLedger(): ReviewChecklistDraftLedger {
  return { version: 1, projects: [] }
}

export function parseReviewChecklistDraftLedger(content: string | undefined): ReviewChecklistDraftLedger {
  if (!content) return createEmptyReviewChecklistDraftLedger()
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    if (parsed.version !== 1 || !Array.isArray(parsed.projects)) return createEmptyReviewChecklistDraftLedger()
    const projects = parsed.projects.filter((project): project is ReviewChecklistDraftLedger['projects'][number] => (
      Boolean(project) && typeof project === 'object' && typeof (project as Record<string, unknown>).projectKey === 'string'
      && Array.isArray((project as Record<string, unknown>).drafts)
    ))
    return { version: 1, projects }
  } catch {
    return createEmptyReviewChecklistDraftLedger()
  }
}

export function getReviewChecklistDraft(
  ledger: ReviewChecklistDraftLedger,
  projectKey: string,
  draftId: number,
  reviewId: number,
): ReviewChecklistDraft | undefined {
  return ledger.projects
    .find(project => project.projectKey === projectKey)
    ?.drafts.find(draft => draft.draftId === draftId && draft.reviewId === reviewId)
}

export function persistReviewChecklistDraft(
  writer: ReviewChecklistDraftWriter,
  projectKey: string,
  draft: ReviewChecklistDraft,
): void {
  const ledger = parseReviewChecklistDraftLedger(writer.draftLedgers[REVIEW_CHECKLIST_DRAFT_TAB_ID])
  const project = ledger.projects.find(candidate => candidate.projectKey === projectKey)
    ?? { projectKey, drafts: [] }
  const others = project.drafts.filter(candidate => !(candidate.draftId === draft.draftId && candidate.reviewId === draft.reviewId))
  const projects = [
    ...ledger.projects.filter(candidate => candidate.projectKey !== projectKey),
    { projectKey, drafts: [...others, { ...draft, savedAt: new Date().toISOString() }] },
  ]
  writer.setDraftLedger(REVIEW_CHECKLIST_DRAFT_TAB_ID, JSON.stringify({ version: 1, projects }))
}

/** 清掉对应稿的编辑中清单（确认成功或 AI 重新审稿后调用）。 */
export function clearReviewChecklistDraft(
  writer: ReviewChecklistDraftWriter,
  projectKey: string,
  draftId: number,
  reviewId: number,
): void {
  const ledger = parseReviewChecklistDraftLedger(writer.draftLedgers[REVIEW_CHECKLIST_DRAFT_TAB_ID])
  const projects = ledger.projects.map(project => project.projectKey === projectKey
    ? { projectKey, drafts: project.drafts.filter(candidate => !(candidate.draftId === draftId && candidate.reviewId === reviewId)) }
    : project).filter(project => project.drafts.length > 0)
  writer.setDraftLedger(REVIEW_CHECKLIST_DRAFT_TAB_ID, JSON.stringify({ version: 1, projects }))
}
