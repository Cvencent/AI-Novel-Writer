/**
 * 统一 AI 检查（粗纲 / 细纲 / 蓝图）的共享类型与持久化形状。
 *
 * 三个环节的检查都产出同一形状的 findings：目标（段号或章号）+ 类别 + 严重度 +
 * 问题描述 + 建议替换文本。持久化、接受/忽略、全部接受、复检都由同一套代码处理，
 * 只是 target 的语义不同（粗纲段 / 细纲章 / 蓝图章）。
 */

/** 被检查的创作层。 */
export const STAGE_REVIEW_TARGETS = ['arc', 'outline', 'blueprint'] as const
export type StageReviewTarget = typeof STAGE_REVIEW_TARGETS[number]

export function isStageReviewTarget(value: unknown): value is StageReviewTarget {
  return typeof value === 'string' && (STAGE_REVIEW_TARGETS as readonly string[]).includes(value)
}

/** findings 的处置状态。open 表示还没被作者处理。 */
export type StageReviewFindingStatus = 'open' | 'accepted' | 'ignored'

/**
 * 一条检查建议。
 * targetIndex 的含义随 target 变化：arc 是段号，outline / blueprint 是章号。
 */
export interface StageReviewFinding {
  targetIndex: number
  category: string
  severity: string
  problemText: string
  expectedText: string
}

export interface StageReviewFindingRecord extends StageReviewFinding {
  findingId: string
  runId: string
  status: StageReviewFindingStatus
}

export interface StageReviewRunRecord {
  runId: string
  target: StageReviewTarget
  selected: number[]
  sourceHash: string
  createdAt: string
  findings: StageReviewFindingRecord[]
}

export interface StageReviewSaveInput {
  operationId: string
  runId: string
  target: StageReviewTarget
  selected: readonly number[]
  sourceHash: string
  findings: readonly StageReviewFinding[]
}
