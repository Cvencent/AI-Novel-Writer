import type { DraftStatus } from '../../../shared/draft-status'
import type { ReviewCycleProjection } from '../../../shared/review-cycle'

/**
 * 单章视图所处的一步，决定主按钮：待写写作此章，草稿 AI 审稿，已审稿按意见修稿，有待合并修稿完成合并，已修稿定稿。
 * 定稿与已归档只读。
 */
export type ChapterStage = 'todo' | 'draft' | 'reviewed' | 'merge' | 'revised' | 'final' | 'archived'

export interface ChapterFacts {
  /** 打开的这一稿的状态；待写章没有稿。 */
  status: DraftStatus | null
  pendingRevisions: number
  /** 这一稿最新的审稿；cycleStatus 是它所属复验周期的修稿进度，旧审稿与合并后的复验审稿没有周期。 */
  latestReview: { cycleStatus: ReviewCycleProjection['revisionStatus'] | null } | null
}

/**
 * 数据库里没有代码把草稿设为 reviewed：审稿只是新增一条审稿记录，合并修稿才把草稿改成 revised。
 * 所以「已审稿」看这一稿有没有还没用来修稿的审稿：草稿上有审稿即是；已修稿的稿只有作者合并后又重新审稿、
 * 产生新的复验周期且尚未合并时才是，合并后自动复验留下的审稿不算。
 */
export function chapterStage({ status, pendingRevisions, latestReview }: ChapterFacts): ChapterStage {
  if (status === null) return 'todo'
  if (status === 'finalized') return 'final'
  if (status === 'archived') return 'archived'
  if (pendingRevisions > 0) return 'merge'
  if (status === 'revised') {
    return latestReview?.cycleStatus && latestReview.cycleStatus !== 'merge-committed' ? 'reviewed' : 'revised'
  }
  return latestReview ? 'reviewed' : 'draft'
}

/** 生命周期条上当前高亮的一步：0 写作、1 审稿、2 修稿、3 定稿、4 全部完成。 */
export const STAGE_STEP: Record<ChapterStage, number> = {
  todo: 0,
  draft: 1,
  reviewed: 2,
  merge: 2,
  revised: 3,
  final: 4,
  archived: 4,
}
