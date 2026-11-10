/**
 * 统一 AI 检查（粗纲 / 细纲 / 蓝图 / 正文深度检查）的共享类型与持久化形状。
 *
 * 四个环节的检查都产出同一形状的 findings：目标（段号或章号）+ 类别 + 严重度 +
 * 问题描述 + 建议替换文本。持久化、接受/忽略、全部接受、复检都由同一套代码处理，
 * 只是 target 的语义不同（粗纲段 / 细纲章 / 蓝图章 / 正文单章）。
 *
 * `chapter`（issue #245 现场）：定稿审稿会带着「深度检查」一起跑（`#229` 设计——模型
 * 判据的家在定稿审稿，不在写下一章的预检）。那些维度产出的是**正文层**发现，没有可
 * 写回的「替换文本」，只能由作者阅读/复制后自己改。它们原先只写进运行日志，而
 * `WorkflowStep.logs` 全仓无人渲染 → 跑完 1 分 49 秒、结果一个字都看不见。
 * 这里给它们一个真正的落地面：与其它三层共用同一张表与同一套接受/忽略处理。
 */

/** 被检查的创作层。 */
export const STAGE_REVIEW_TARGETS = ['arc', 'outline', 'blueprint', 'chapter'] as const
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

/** 单次 AI 检查最多覆盖的目标数；超出的范围分多次检查，避免一次性把整本书塞进模型。 */
export const STAGE_REVIEW_MAX_TARGETS = 50
