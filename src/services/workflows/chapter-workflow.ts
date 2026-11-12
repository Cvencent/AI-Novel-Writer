import { formatResourceUri } from '../../shared/project-paths'
import { canonicalResourceUri, parseResourceUri, resourceWriteAllowed } from '../../shared/project-paths'
import { useWorkflowStore, workflowResourceKey, type WorkflowDefinition } from '../../stores/workflow-store'
import type { DraftMeta } from '../draft-index'
import { requireIpcSuccess } from '../ipc-result'
import { ipc } from '../ipc-client'

import type { DraftStatus } from '../../shared/draft-status'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { sameProjectPathKey } from '../../shared/project-session-context'
import { FINALIZATION_SHARED_WRITE_RESOURCE_KINDS } from '../../shared/workflow-resource-claims'
import { normalizeChapterWordsTarget } from './chapter-creation-parameters'
import { localize } from '../../i18n/core'
import type { Locale } from '../../i18n/types'
import { useLocaleStore } from '../../stores/locale-store'
// 章节工作流的步骤原来没有任何传输重试（issue #85）：同一次网络抖动，细纲能扛过去
// （架构工作流四个步骤都被 withTransientRetry 包住），起草却在第一步就整章失败。
import { transientRetryLimitFor, withTransientRetry } from './transient-retry'

// ==========================================
// 1. 结构与类型导出 (保留对外的向后兼容)
// ==========================================
export type { DraftStatus, DraftMeta }

export interface ChapterInfo {
  projectPath: string
  chapterNumber: number
  title: string
  role: string
  purpose: string
  characters: string[]
  keyEvents: string
  suspenseHook?: string
  /** 本章当场付出的代价或不可逆后果（来自蓝图）。 */
  costsAndTurns?: string
  /** 本章埋下或回收的伏笔（来自蓝图）。 */
  foreshadowing?: string
  userGuidance?: string
  /** 本次单章创作的用户目标字数；未提供时沿用项目默认值。 */
  wordsTarget?: number
  /** 用户自定义知识库检索关键词（追加到向量搜索 query） */
  knowledgeQueryHint?: string
  /** 重写基准：本章权威定稿；提供时本次写作变成「基于定稿重写」 */
  rewriteBase?: import('../../shared/chapter-rewrite-contract').ChapterRewriteBase
  /** 作者对这一版的修改想法 */
  rewriteGuidance?: string
}

export interface ChapterWorkflowOptions {
  /** A frozen Agent-originated model choice for this draft run only. */
  generationModelId?: string
  /** Visible interface locale captured by the launcher. */
  uiLocale?: Locale
}

export interface FrozenDraftSourceIdentity {
  readonly id: number
  readonly chapterNumber: number
  readonly version: number
  readonly status: DraftStatus
  /** Renderer edit generation captured with the body shown to the author. */
  readonly contentRevision: number
}

export interface RefineOnlyParams {
  projectPath: string
  chapterNumber: number
  chapterTitle: string
  draftPath: string
  draftContent: string
  sourceDraft: FrozenDraftSourceIdentity
  userRefinePrompt?: string
}

export interface RefineFromReviewParams {
  projectPath: string
  chapterNumber: number
  chapterTitle: string
  draftPath: string
  draftContent: string
  /** Persisted JSON from the human-confirmation review row. */
  confirmedReviewContent?: string
  /** ID of the confirmation review row, recorded on the resulting revision. */
  reviewSourceId?: number
  /** @deprecated Raw AI review text must not become a model instruction. */
  reviewReport?: string
  reviewFileName?: string
  /** Renderer-owned selection, frozen onto this workflow rather than LLM input. */
  generationModelId?: string
  /** @deprecated Author guidance is part of the confirmation snapshot. */
  userRefinePrompt?: string
}

export interface ReviewOnlyParams {
  projectPath: string
  chapterNumber: number
  chapterTitle: string
  draftPath: string
  draftContent: string
  sourceDraft: FrozenDraftSourceIdentity
  /** 审稿维度侧重点（可选） */
  reviewFocus?: string
  reviewCycleId?: string
  expectedMergedHash?: string
  /**
   * 深度检查维度（issue #229 ①②）：审稿完成后自动追加的模型核对（原写前预检的
   * 13 颗「核对…」按钮搬家到这里）。省略时按持久化偏好执行（缺省全勾）。
   */
  deepCheckKeys?: import('../../shared/deep-review-dimensions').DeepReviewDimensionKey[]
  /** 深度检查的取数 IPC 会话；缺省时回退到工作流自身的 session（chapterWorkflow 流转的会话）。 */
  projectSession?: ProjectSessionContext
}

export interface FinalizeOnlyParams {
  projectPath: string
  chapterNumber: number
  chapterTitle: string
  draftPath: string
  draftContent: string
  snapshot?: import('../finalization-snapshot').FinalizationSnapshot
}

// ==========================================
// 2. 草稿文件工具函数 (供前端 UI 侧调用)
// ==========================================

export function getDraftDir(_projectPath: string, chapterNumber: number): string {
  return `ai-novel://draft/ch${chapterNumber}`
}

export function getDraftPath(_projectPath: string, chapterNumber: number, version: number): string {
  return `ai-novel://draft/ch${chapterNumber}/v${version}`
}

const CHAPTER_CONTEXT_READ_RESOURCE_KEYS = Object.freeze([
  workflowResourceKey('novel-config'),
  workflowResourceKey('architecture'),
  workflowResourceKey('blueprints'),
])

const FINALIZE_SHARED_WRITE_RESOURCE_KEYS = Object.freeze([
  ...FINALIZATION_SHARED_WRITE_RESOURCE_KINDS.map(kind => workflowResourceKey(kind)),
])

function finalizeWriteResourceKeys(chapterNumber: number): readonly string[] {
  return Object.freeze([
    workflowResourceKey('chapter', chapterNumber),
    ...FINALIZE_SHARED_WRITE_RESOURCE_KEYS,
  ])
}

function workflowProjectSession(
  projectPath: string,
  sourceProjectSession: ProjectSessionContext,
  uiLocale: Locale = chapterWorkflowLocale(),
): ProjectSessionContext {
  if (!sameProjectPathKey(sourceProjectSession.projectPath, projectPath)) {
    throw new Error(localize(
      uiLocale,
      '工作流项目会话与目标路径不匹配',
      'Workflow project session does not match the target path',
    ))
  }
  return Object.freeze({ ...sourceProjectSession })
}

function chapterWorkflowLocale(locale?: Locale): Locale {
  return locale ?? useLocaleStore.getState().locale
}

export async function parseDraftMeta(
  filePath: string,
  expectedProjectPath: string,
  projectSession: ProjectSessionContext,
): Promise<DraftMeta | null> {
  const resource = parseResourceUri(filePath)
  if (!resource || !['draft', 'manuscript', 'chapter'].includes(resource.kind)) return null
  filePath = canonicalResourceUri(filePath)!
  if (!sameProjectPathKey(projectSession.projectPath, expectedProjectPath)) {
    throw new Error('读取草稿元数据时项目会话与目标路径不匹配')
  }

  // 优先处理 ai-novel://draft/{id} 纯数字 ID 格式（DB 化后的标准路径）
  const idMatch = filePath.match(/^ai-novel:\/\/(?:draft|manuscript)\/(\d+)$/)
  if (idMatch) {
    const draftId = parseInt(idMatch[1])
    const dbMeta = await ipc.invokeWithProjectSession(
      projectSession,
      'db:draft-get-meta',
      draftId,
      expectedProjectPath,
    )
    if (!dbMeta) return null
    return {
      ...dbMeta,
      status: dbMeta.status as DraftStatus,
      source: dbMeta.source as 'write' | 'rewrite',
      fileName: `draft_v${dbMeta.version}.md`,
      filePath: formatResourceUri({ kind: 'draft', id: dbMeta.id }),
    } as unknown as DraftMeta
  }

  // 兼容旧格式 draft_v(\d+).md 和 ai-novel://draft/ch{N}/v{V}
  const versionMatch = filePath.match(/v(\d+)(?:\.md)?$/)
  if (!versionMatch) return null
  const version = parseInt(versionMatch[1])

  // 提取章节号
  const chMatch = filePath.match(/ch(\d+)/)
  if (!chMatch) return null
  const chapterNumber = parseInt(chMatch[1])

  const drafts = await ipc.invokeWithProjectSession(
    projectSession,
    'db:draft-list',
    chapterNumber,
    expectedProjectPath,
  )
  const d = drafts.find((draft) => draft.version === version)
  return d ? (d as unknown as DraftMeta) : null
}

export async function updateDraftStatus(
  filePath: string,
  newStatus: DraftStatus,
  expectedProjectPath: string,
  projectSession: ProjectSessionContext,
): Promise<void> {
  if (!resourceWriteAllowed(filePath)) throw new Error('资源只读或无效')
  const meta = await parseDraftMeta(filePath, expectedProjectPath, projectSession)
  if (meta) {
    requireIpcSuccess(
      await ipc.invokeWithProjectSession(
        projectSession,
        'db:draft-update-status',
        meta.id,
        newStatus,
        undefined,
        expectedProjectPath,
      ),
      '更新草稿状态',
    )
  }
}

// ==========================================
// 3. 工作流定义映射工厂 (Command 调度层)
// 将原有的 1500 多行核心面条代码剥离为微内核执行器。
// ==========================================

export function createChapterWorkflow(
  chapterInfo: ChapterInfo,
  sourceProjectSession: ProjectSessionContext,
  options: ChapterWorkflowOptions = {},
): WorkflowDefinition {
  const uiLocale = chapterWorkflowLocale(options.uiLocale)
  const generationModelId = options.generationModelId?.trim() || undefined
  const chapterWordsTarget = normalizeChapterWordsTarget(chapterInfo.wordsTarget)
  const frozenChapterInfo = Object.freeze({ ...chapterInfo, wordsTarget: chapterWordsTarget })
  return {
    type: 'chapter_creation',
    projectPath: chapterInfo.projectPath,
    projectSession: workflowProjectSession(chapterInfo.projectPath, sourceProjectSession),
    uiLocale,
    ...(generationModelId ? { generationModelId } : {}),
    chapterWordsTarget,
    resourceKeys: [workflowResourceKey('chapter', chapterInfo.chapterNumber)],
    readResourceKeys: CHAPTER_CONTEXT_READ_RESOURCE_KEYS,
    title: localize(uiLocale,
      `第 ${chapterInfo.chapterNumber} 章 · 写稿`,
      `Chapter ${chapterInfo.chapterNumber} · Draft`,
    ),
    steps: [
      {
        name: localize(uiLocale, '写稿', 'Draft chapter'),
        description: localize(
          uiLocale,
          '基于架构 + 蓝图 + 上下文调用 Command 生成草稿',
          'Generate a draft from the architecture, blueprint, and context',
        ),
        executor: async (step, context, callbacks) => {
          const { GenerateDraftCommand } = await import('./commands/generate-draft.command')
          // 通道失败自动重试（issue #85）：报告里起草的第一步（短细纲）9 秒失败后
          // 整章没写出来，而这类失败多是瞬时的，直接重发通常就过。
          // 每轮**新建命令**（与架构工作流的 withTransientRetry 同一写法）：
          // 复用同一个命令实例会把上一轮的执行期状态带进下一轮。
          return withTransientRetry(
            () => new GenerateDraftCommand(frozenChapterInfo).execute({ step, context, callbacks }),
            line => callbacks.log(line),
            { isCancelled: () => context.cancelled },
          )
        },
      },
    ],
    onComplete: {
      mode: 'open',
      message: localize(
        uiLocale,
        `第${chapterInfo.chapterNumber}章草稿已生成`,
        `Chapter ${chapterInfo.chapterNumber} draft generated`,
      ),
    },
  }
}

export function createRefineOnlyWorkflow(
  params: RefineOnlyParams,
  sourceProjectSession: ProjectSessionContext,
): WorkflowDefinition {
  const uiLocale = chapterWorkflowLocale()
  const frozenParams = Object.freeze({
    ...params,
    sourceDraft: Object.freeze({ ...params.sourceDraft }),
  })
  return {
    type: 'chapter_creation',
    projectPath: params.projectPath,
    projectSession: workflowProjectSession(params.projectPath, sourceProjectSession),
    uiLocale,
    resourceKeys: [workflowResourceKey('chapter', params.chapterNumber)],
    readResourceKeys: CHAPTER_CONTEXT_READ_RESOURCE_KEYS,
    title: localize(uiLocale,
      `第 ${params.chapterNumber} 章 · 修稿`,
      `Chapter ${params.chapterNumber} · Revise`,
    ),
    steps: [
      {
        name: localize(uiLocale, '修稿', 'Revise draft'),
        description: localize(
          uiLocale,
          '在保留作者事实与叙事意图的前提下精修草稿，保存修订并打开合并视图',
          'Revise the draft while preserving authorial facts and intent, save the revision, and open the merge view',
        ),
        executor: async (step, context, callbacks) => {
          const { RefineDraftCommand } = await import('./commands/refine-draft.command')
          const cmd = new RefineDraftCommand({
            draftPath: frozenParams.draftPath,
            draftContent: frozenParams.draftContent,
            sourceDraft: frozenParams.sourceDraft,
            chapterNumber: frozenParams.chapterNumber,
            chapterInfo: { projectPath: frozenParams.projectPath, chapterNumber: frozenParams.chapterNumber, title: frozenParams.chapterTitle, role: '', purpose: '', characters: [], keyEvents: '' },
            userRefinePrompt: frozenParams.userRefinePrompt,
          })
          return cmd.execute({ step, context, callbacks })
        },
      },
    ],
    onComplete: { mode: 'open', openResult: async () => { } },
  }
}

export function createRefineFromReviewWorkflow(
  params: RefineFromReviewParams,
  sourceProjectSession: ProjectSessionContext,
): WorkflowDefinition {
  const uiLocale = chapterWorkflowLocale()
  const generationModelId = params.generationModelId?.trim() || undefined
  return {
    type: 'chapter_creation',
    projectPath: params.projectPath,
    projectSession: workflowProjectSession(params.projectPath, sourceProjectSession),
    uiLocale,
    ...(generationModelId ? { generationModelId } : {}),
    resourceKeys: [workflowResourceKey('chapter', params.chapterNumber)],
    readResourceKeys: CHAPTER_CONTEXT_READ_RESOURCE_KEYS,
    title: localize(uiLocale,
      `第 ${params.chapterNumber} 章 · 审稿修复`,
      `Chapter ${params.chapterNumber} · Apply review`,
    ),
    steps: [
      {
        name: localize(uiLocale, '审稿驱动修稿', 'Revise from review'),
        description: localize(
          uiLocale,
          '根据审稿报告精准修复问题调用 Command',
          'Apply the confirmed review findings to the draft',
        ),
        executor: async (step, context, callbacks) => {
          const { RefineFromReviewCommand } = await import('./commands/refine-from-review.command')
          const cmd = new RefineFromReviewCommand({
            draftPath: params.draftPath,
            draftContent: params.draftContent,
            confirmedReviewContent: params.confirmedReviewContent,
            reviewSourceId: params.reviewSourceId,
            chapterNumber: params.chapterNumber,
          })
          return cmd.execute({ step, context, callbacks })
        },
      },
    ],
    onComplete: { mode: 'open', openResult: async () => { } },
  }
}

export function createReviewOnlyWorkflow(
  params: ReviewOnlyParams,
  sourceProjectSession: ProjectSessionContext,
): WorkflowDefinition {
  const uiLocale = chapterWorkflowLocale()
  const frozenParams = Object.freeze({
    ...params,
    sourceDraft: Object.freeze({ ...params.sourceDraft }),
  })
  return {
    type: 'chapter_creation',
    projectPath: params.projectPath,
    projectSession: workflowProjectSession(params.projectPath, sourceProjectSession),
    uiLocale,
    resourceKeys: [workflowResourceKey('chapter', params.chapterNumber)],
    readResourceKeys: CHAPTER_CONTEXT_READ_RESOURCE_KEYS,
    title: localize(uiLocale,
      // 复核（合并后的复验）**不是**重审全章：它只裁决那几条作者刚修过的意见。
      // 原来这里与全章审稿共用同一个标题「第 N 章 · 审稿」和同一个首步名「审稿」，
      // 作者点完合并看到它，会以为自己白重审了一遍全章（issue #245 现场）。
      params.reviewCycleId
        ? `第 ${params.chapterNumber} 章 · 复核已修意见`
        : `第 ${params.chapterNumber} 章 · 审稿`,
      params.reviewCycleId
        ? `Chapter ${params.chapterNumber} · Recheck revised notes`
        : `Chapter ${params.chapterNumber} · Review`,
    ),
    // 复核只裁决刚修过的意见：深度检查与编辑部评审都不该跑（不是重审全章）。
    steps: ([
      {
        name: localize(uiLocale, params.reviewCycleId ? '复核已修意见' : '审稿',
          params.reviewCycleId ? 'Recheck revised notes' : 'Review chapter'),
        description: localize(
          uiLocale,
          params.reviewCycleId
            ? '只裁决你刚修过的那几条意见是否真的解决（不是重审全章）'
            : '一致性检查（角色/剧情/世界观），生成审稿报告',
          params.reviewCycleId
            ? 'Judge only whether the notes you just revised are genuinely resolved (not a full re-review)'
            : 'Check character, plot, and worldbuilding consistency and generate a review report',
        ),
        executor: async (step, context, callbacks) => {
          const { ReviewChapterCommand } = await import('./commands/review-chapter.command')
          // 审稿是最重的一步（issue #183：成功均 134 秒、失败率 13%，其中 6 条 ECONNRESET）。
          // 「统一 2 次重试」对它是错的：一次失败后重试 2 次要让作者白等 ~7 分钟。
          // 这里只给 1 次——够覆盖一次瞬时抖动，又不至于让作者等三轮。
          return withTransientRetry(
            () => new ReviewChapterCommand({
              draftPath: frozenParams.draftPath,
              draftContent: frozenParams.draftContent,
              sourceDraft: frozenParams.sourceDraft,
              chapterNumber: frozenParams.chapterNumber,
              reviewFocus: frozenParams.reviewFocus,
              reviewCycleId: frozenParams.reviewCycleId,
              expectedMergedHash: frozenParams.expectedMergedHash,
            }).execute({ step, context, callbacks }),
            line => callbacks.log(line),
            { isCancelled: () => context.cancelled, limit: transientRetryLimitFor('review-chapter') },
          )
        },
      },
      {
        // issue #229 ①：模型判据的正确家是定稿时的审稿——上一章写完时默认做（可勾选）。
        // 这一步把原写前预检的 13 颗「核对…」按钮搬过来：按持久化偏好逐维跑
        // （每维一次模型调用，串行），发现并进运行日志；作者据此走「按 N 项意见修稿」。
        name: localize(uiLocale, '深度检查', 'Deep checks'),
        description: localize(
          uiLocale,
          '按勾选的维度逐项跑模型核对（物证链、跨章重复、期限、日期等）',
          'Run the selected model checks (evidence chain, cross-chapter repeats, deadlines, dates, …)',
        ),
        executor: async (_step, context, callbacks) => {
          const { runDeepReviewChecks, readDeepReviewSelection } = await import('../deep-review-service')
          const { ipc } = await import('../ipc-client')
          const session = frozenParams.projectSession ?? workflowProjectSession(frozenParams.projectPath, sourceProjectSession)
          // 勾选优先用作者本次传的；没传就按持久化偏好（缺省全勾）。
          const selection = frozenParams.deepCheckKeys
            ? Object.fromEntries((await import('../../shared/deep-review-dimensions')).DEEP_REVIEW_DIMENSIONS
              .map(dimension => [dimension.key, frozenParams.deepCheckKeys!.includes(dimension.key)]))
            : await readDeepReviewSelection(session)
          const keys = (await import('../../shared/deep-review-dimensions')).DEEP_REVIEW_DIMENSIONS
            .map(dimension => dimension.key)
            .filter(key => selection[key])
          if (keys.length === 0) {
            callbacks.log(localize(uiLocale, '深度检查：全部维度已取消勾选，跳过。', 'Deep checks: every dimension is unchecked, skipping.'))
            return
          }
          // 取数：本章正文（未定稿）+ 全部已定稿正文 + 角色卡 + 本章蓝图断言。
          const cards = (await (async () => {
            const roster = await ipc.invokeWithProjectSession(session, 'db:character-roster-read', session.projectPath).catch(() => null)
            return ((roster?.entries ?? []) as Array<{ name?: unknown, appearance?: unknown, notes?: unknown }>).flatMap(entry => {
              const name = String(entry.name ?? '').trim()
              const appearance = String(entry.appearance ?? '')
              const notes = String(entry.notes ?? '')
              return name && `${appearance}${notes}`.trim() ? [{ name, appearance, notes }] : []
            })
          })()) as Array<{ name: string, appearance: string, notes: string }>
          const finalized = (await ipc.invokeWithProjectSession(session, 'db:draft-export-snapshot', session.projectPath)
            .catch(() => [])) as Array<{ chapterNumber: number, content: string }>
          const blueprints = (await ipc.invokeWithProjectSession(session, 'db:blueprint-get', frozenParams.chapterNumber, session.projectPath).catch(() => null)) as
            { key_events?: unknown, foreshadowing?: unknown, costs_and_turns?: unknown, notes?: unknown, purpose?: unknown, suspense_hook?: unknown } | null
          // ⚠️ 取数口径与弹层「核对蓝图自洽」对齐（6 字段）：#172 的现场（两套值）在 notes、
          // #222 的现场（互斥处置）在 keyEvents——漏字段就是漏检，且是静默的。
          // （db:blueprint-get 返回 snake_case 行；两个命名都兜，避免依赖行映射细节。）
          const claims = blueprints ? [{
            chapterNumber: frozenParams.chapterNumber,
            claims: [
              blueprints.notes ?? (blueprints as Record<string, unknown>).notes,
              blueprints.key_events ?? (blueprints as Record<string, unknown>).keyEvents,
              blueprints.purpose ?? (blueprints as Record<string, unknown>).purpose,
              blueprints.suspense_hook ?? (blueprints as Record<string, unknown>).suspenseHook,
              blueprints.costs_and_turns ?? (blueprints as Record<string, unknown>).costsAndTurns,
              blueprints.foreshadowing ?? (blueprints as Record<string, unknown>).foreshadowing,
            ]
              .map(value => String(value ?? '').trim()).filter(Boolean).join('\n'),
          }] : []
          const result = await runDeepReviewChecks({
            session,
            chapter: { chapterNumber: frozenParams.chapterNumber, content: frozenParams.draftContent },
            finalizedChapters: finalized.map(row => ({ chapterNumber: row.chapterNumber, content: String(row.content ?? '') })),
            cards,
            claims,
            worldbuilding: '',
            keys,
            onProgress: line => callbacks.log(line),
            cancelled: () => context.cancelled,
          })
          for (const line of result.lines) callbacks.log(line)
          for (const failure of result.failures) {
            callbacks.log(localize(uiLocale, `深度检查失败 · ${failure.key}：${failure.error}`, `Deep check failed · ${failure.key}: ${failure.error}`))
          }
          // issue #245 现场：这一步跑 1 分 49 秒、13 次模型调用全部成功，但结果一个字都看不见——
          // findings 只被写进 `step.logs`（全仓无人渲染），executor 又不返回值，于是运行卡片那一步
          // 永远没有可展开内容，作者只能靠切页碰运气。
          // 落地面：正文层发现写进 `stage_review_*` 的 `chapter` 目标（与粗纲/细纲/蓝图共用同一套
          // 接受/忽略/清除），供章节页「AI 检查 · 本章」就地查看。
          // ⚠️ 不并进审稿报告：那份报告的正文被 M03 用 sha256 钉死（`review_content_hash`），
          // 事后追加会让重建的哈希与落库值不等 → `MIGRATION_VERIFICATION_FAILED`（旧书打不开）。
          const { deepCheckSummary } = await import('../deep-review-service')
          const summary = deepCheckSummary({
            total: keys.length, lines: result.lines, findings: result.findings,
            failures: result.failures, cancelled: context.cancelled,
          }, uiLocale)
          if (result.findings.length > 0) {
            const stageReviewRunId = `deep-review:${context.runId}`
            const saved = await ipc.invokeWithProjectSession(session, 'db:stage-review-save', {
              operationId: stageReviewRunId,
              runId: stageReviewRunId,
              target: 'chapter',
              // 正文层的发现不针对「第几段」，只针对这一章；章号进 targetIndex 便于回显。
              selected: [frozenParams.chapterNumber],
              sourceHash: await import('../../shared/source-ref')
                .then(mod => mod.hashAuthorText(frozenParams.draftContent)),
              findings: result.findings.map(finding => ({
                targetIndex: frozenParams.chapterNumber,
                category: finding.issue.zhCN,
                severity: 'warning',
                problemText: uiLocale === 'en-US' ? finding.issue.enUS : finding.issue.zhCN,
                // 正文层发现没有机械可执行的替换文本：作者读完后自己改（设计如此，见 #229）。
                expectedText: '',
              })),
            }, session.projectPath).catch(() => null)
            // 落库失败不能吞掉摘要：作者至少还能在运行卡片看到「几处发现」。
            if (!saved?.success) callbacks.log(localize(uiLocale,
              '深度检查结果未能写入检查记录，可在运行日志里查看。',
              'The deep-check results could not be written to the review record; see the run log.'))
            else callbacks.log(localize(uiLocale,
              `深度检查结果已记入检查记录（${result.findings.length} 处）。`,
              `Deep-check results saved to the review record (${result.findings.length}).`))
          } else {
            callbacks.log(summary)
          }
          // 返回值就是运行卡片那一步的详情：作者不必切页也看得见。
          return summary
        },
      },
      {
        /**
         * 编辑部评审（五角色）并入 AI 审稿。
         *
         * 现场：五角色评审原先是审稿报告侧页里的**独立一块**，作者得再点一次「运行编辑部」
         * 才跑，跑完还要在面板里逐条/一次「纳入修稿」，才发现两边的问题能一起修。
         * 现在并成审稿的最后一步——点一次「AI 审稿」，一致性审稿 + 深度检查 + 五角色一次跑完。
         *
         * ⚠️ 发现**不写进审稿报告正文**：那份正文被 M03 用 sha256 钉死
         * （`review_cycles.review_content_hash` 与 `reviews` 的投影一起校验），事后追加
         * 会让重建哈希与落库值不等 → `MIGRATION_VERIFICATION_FAILED`（旧书打不开）。
         * 所以这里只把评分与发现落到 `writing_intelligence_quality`（独立表），
         * 由 `EditorialPanelSection` 读出来展示、并自动并入修稿清单。
         */
        name: localize(uiLocale, '编辑部评审', 'Editorial panel'),
        description: localize(
          uiLocale,
          '五位编辑（情节/连续性/角色/文风/节奏）分别评审并打分',
          'Five editors (plot, continuity, character, style, pacing) score the chapter',
        ),
        executor: async (_step, context, callbacks) => {
          /**
           * 复核（合并后的复验）**不跑五角色**：它只裁决那几条刚修过的意见，
           * 不做整章评分；再跑一次等于白花一份模型调用，而且评分还会被这一版
           * 还没来得及复审的正文影响。作者想要新评分可以显式「重新评估」。
           */
          if (frozenParams.reviewCycleId) {
            callbacks.log(localize(uiLocale, '编辑部评审：这次是复核已修意见，不重复评分。',
              'Editorial panel: this run only rechecks revised notes, so no new score.'))
            return localize(uiLocale, '编辑部评审：复核不重算评分。', 'Editorial panel: a recheck does not rescore.')
          }
          // 已有本稿的评分就不重跑：审稿会重复点（改一稿再点一次），
          // 每次重跑等于白花一份模型调用；面板里有「重新评估」可显式重跑。
          const { ipc } = await import('../ipc-client')
          const session = frozenParams.projectSession ?? workflowProjectSession(frozenParams.projectPath, sourceProjectSession)
          const existing = await ipc.invokeWithProjectSession(session, 'db:writing-intelligence-quality-get',
            frozenParams.sourceDraft.id, session.projectPath).catch(() => null) as { contentHash?: string } | null
          if (existing) {
            const contentHash = await import('../../shared/source-ref')
              .then(mod => mod.hashAuthorText(frozenParams.draftContent))
            if (existing.contentHash === contentHash) {
              callbacks.log(localize(uiLocale, '编辑部评审：本稿已有评分，跳过重跑（可在审稿报告里点「重新评估」）。',
                'Editorial panel: this draft already has a score; skipping (use “Re-evaluate” in the review report to rerun).'))
              return localize(uiLocale, '编辑部评审：沿用已有评分。', 'Editorial panel: reused the existing score.')
            }
          }
          const { EditorialPanelCommand } = await import('./commands/editorial-panel.command')
          /**
           * 重试一次瞬时传输失败，并且**失败不拖垮整个审稿**。
           *
           * 现场（issue #245）：编辑部那一步 `GENERATION_PROVIDER_FAILED`，但前一步的
           * 审稿报告**已经成功落库**了。原来这一步裸抛异常 → 整个工作流报失败，
           * 作者在界面上看到的是「审稿失败」，可实际上审稿报告好好的、只是五角色没跑成，
           * 于是既看不到「评审失败」的原因，也以为「审稿没问题」。
           *
           * 现在：瞬时失败按工作流层既有口径重试（审稿单次 100+ 秒，这里也只给 1 次）；
           * 最终仍失败就**把失败写进这一步的返回值**（运行卡片上直接可见），
           * 但**不再抛**——审稿主结果不该被一个附加评审连坐。
           */
          try {
            const panel = await withTransientRetry(
              () => new EditorialPanelCommand({
                chapterNumber: frozenParams.chapterNumber,
                draftId: frozenParams.sourceDraft.id,
                draftVersion: frozenParams.sourceDraft.version,
              }).execute({ step: _step, context, callbacks }),
              line => callbacks.log(line),
              { isCancelled: () => context.cancelled, limit: 1 },
            )
            const findings = panel.roles.reduce((total, role) => total + role.findings.length, 0)
            return localize(uiLocale,
              `编辑部评审完成：加权 ${panel.weightedScore.toFixed(1)} 分，阻断 ${panel.blockingCount} 条，共 ${findings} 处发现。`,
              `Editorial panel done: weighted ${panel.weightedScore.toFixed(1)}, ${panel.blockingCount} blocking, ${findings} findings.`)
          } catch (error) {
            // 取消是作者意图，照旧上抛（工作流会按 cancelled 收尾，不该显示成失败）。
            if (context.cancelled) throw error
            const reason = error instanceof Error ? error.message : String(error)
            callbacks.log(localize(uiLocale,
              `编辑部评审失败：${reason}（一致性审稿已完成并保存，不受影响）`,
              `Editorial panel failed: ${reason} (the consistency review finished and is saved; it is unaffected)`))
            // 返回值即运行卡片那一步的详情：**必须写清失败**，不能静默当成通过。
            return localize(uiLocale,
              `编辑部评审失败，未产生评分：${reason}。一致性审稿已完成，可在审稿报告里点「重新评估」重跑编辑部。`,
              `Editorial panel failed and produced no score: ${reason}. The consistency review is complete; rerun the panel from the review report.`)
          }
        },
      },
    ] as WorkflowDefinition['steps']).slice(0, params.reviewCycleId ? 1 : undefined),
    onComplete: {
      mode: 'open',
      message: localize(
        uiLocale,
        params.reviewCycleId
          ? `第${params.chapterNumber}章 · 已修意见复核完成`
          : `第${params.chapterNumber}章审稿完成`,
        params.reviewCycleId
          ? `Chapter ${params.chapterNumber}: revised notes rechecked`
          : `Chapter ${params.chapterNumber} review completed`,
      ),
    },
  }
}

export function createFinalizeWorkflow(
  params: FinalizeOnlyParams,
  sourceProjectSession: ProjectSessionContext,
): WorkflowDefinition {
  const uiLocale = chapterWorkflowLocale()
  const chapterInfo: ChapterInfo = { projectPath: params.projectPath, chapterNumber: params.chapterNumber, title: params.chapterTitle, role: '', purpose: '', characters: [], keyEvents: '' }
  return {
    type: 'chapter_creation',
    projectPath: params.projectPath,
    projectSession: workflowProjectSession(params.projectPath, sourceProjectSession),
    uiLocale,
    resourceKeys: finalizeWriteResourceKeys(params.chapterNumber),
    readResourceKeys: CHAPTER_CONTEXT_READ_RESOURCE_KEYS,
    title: localize(uiLocale,
      `第 ${params.chapterNumber} 章 · 定稿`,
      `Chapter ${params.chapterNumber} · Finalize`,
    ),
    steps: [
      {
        name: localize(uiLocale, '定稿', 'Finalize chapter'),
        description: localize(
          uiLocale,
          '写入 manuscript/，开启后处理 Command 更新三路大纲',
          'Write to manuscript/ and run post-processing to update the three outlines',
        ),
        executor: async (step, context, callbacks) => {
          const { FinalizeChapterCommand } = await import('./commands/finalize-chapter.command')
          // 定稿后处理是报告里最常撞通道失败的链路（角色状态 47s、章节笔记 28s/44s），
          // 而它跑在「本章不会再变」的时点——一次网络抖动就整步失败代价最大。
          return withTransientRetry(
            () => new FinalizeChapterCommand({
              draftPath: params.draftPath,
              draftContent: params.draftContent,
              chapterNumber: params.chapterNumber,
              chapterInfo,
              snapshot: params.snapshot,
            }).execute({ step, context, callbacks }),
            line => callbacks.log(line),
            { isCancelled: () => context.cancelled },
          )
        },
      },
    ],
    // 关系同步从修稿合并挪到定稿后：修稿只改草稿，关系以定稿正文为准。
    // 定稿界面结算仍由携带 immutable snapshot 的 FINALIZE_COMPLETE 完成。
    onComplete: {
      mode: 'silent',
      message: localize(
        uiLocale,
        `第${params.chapterNumber}章已定稿，人物关系将按本章正文同步。`,
        `Chapter ${params.chapterNumber} finalized.`,
      ),
      openResult: async () => {
        // 关系同步从修稿合并挪到定稿后：修稿只改草稿，关系以定稿正文为准。
        try {
          const { createRosterSyncWorkflow } = await import('./roster-sync-workflow')
          const session = params.snapshot?.projectSession ?? sourceProjectSession
          const definition = createRosterSyncWorkflow({
            projectPath: params.projectPath,
            projectSession: session,
            mergedProse: params.draftContent,
          }, uiLocale)
          useWorkflowStore.getState().startWorkflow(definition).catch((error: unknown) => {
            useWorkflowStore.getState().addLog('error', localize(uiLocale, `人物关系同步启动失败：${String(error)}`, `Failed to start relationship sync: ${String(error)}`), uiLocale)
          })
        } catch (error) {
          useWorkflowStore.getState().addLog('error', localize(uiLocale, `人物关系同步启动失败：${String(error)}`, `Failed to start relationship sync: ${String(error)}`), uiLocale)
        }
      },
    },
  }
}

/**
 * 修复定稿后处理工作流 — 当定稿后的三路推演失败时可重跑
 * 从 manuscript/ 读取已定稿内容，重新执行 FinalizeChapterCommand 的后处理部分
 */
export function createRepairFinalizeWorkflow(
  chapterNumber: number,
  projectPath: string,
  sourceProjectSession: ProjectSessionContext,
  stepKey?: string,
): WorkflowDefinition {
  const uiLocale = chapterWorkflowLocale()
  const text = (zhCNText: string, enUSText: string) => localize(uiLocale, zhCNText, enUSText)
  return {
    type: 'chapter_creation',
    projectPath,
    projectSession: workflowProjectSession(projectPath, sourceProjectSession, uiLocale),
    uiLocale,
    resourceKeys: finalizeWriteResourceKeys(chapterNumber),
    readResourceKeys: CHAPTER_CONTEXT_READ_RESOURCE_KEYS,
    title: text(
      `第 ${chapterNumber} 章 · 修复后处理`,
      `Chapter ${chapterNumber} · Repair post-processing`,
    ),
    steps: [
      {
        name: text('重建后处理', 'Rebuild post-processing'),
        description: text(
          '从定稿正文重新生成章节要点、连续性事实和角色状态',
          'Regenerate chapter notes, continuity facts, and character state from the finalized manuscript',
        ),
        executor: async (_step, context, callbacks) => {
          const { useProjectStore } = await import('../../stores/project-store')
          const { ipc } = await import('../ipc-client')
          const { projectSessionContextFromProject, sameProjectSessionContext } = await import('../../shared/project-session-context')
          const { requireWorkflowProjectSession } = await import('./workflow-project-session')
          const projectSession = requireWorkflowProjectSession(context)
          const project = useProjectStore.getState().currentProject
          if (!project || !sameProjectSessionContext(projectSession, projectSessionContextFromProject(project))) {
            throw new Error(text(
              '当前项目已切换，修复已停止',
              'The project changed, so repair was stopped.',
            ))
          }

          // 使用数据库定稿源
          const draftMeta = await ipc.invokeWithProjectSession(
            projectSession,
            'db:draft-get-finalized',
            chapterNumber,
            projectPath,
          )
          if (!draftMeta) throw new Error(text(
            `第 ${chapterNumber} 章的定稿记录未获取到`,
            `The finalized record for Chapter ${chapterNumber} could not be found.`,
          ))
          const full = await ipc.invokeWithProjectSession(projectSession, 'db:draft-get-full', draftMeta.id, projectPath)
          if (!full) throw new Error(text(
            `正文提取失败: ID=${draftMeta.id}`,
            `Could not read finalized manuscript content: ID=${draftMeta.id}`,
          ))
          const finalizedSource = await ipc.invokeWithProjectSession(
            projectSession,
            'db:continuity-read-source',
            draftMeta.id,
            projectPath,
          )
          if (
            finalizedSource.status !== 'valid'
            || finalizedSource.snapshot.content !== full.content
          ) throw new Error(text(
            '定稿正文来源收据已失效',
            'The finalized manuscript source receipt is stale.',
          ))

          // 从数据库蓝图读取正式标题
          let chapterTitle = text(`第${chapterNumber}章`, `Chapter ${chapterNumber}`)
          let chapterEntities: string[] = []
          try {
            const bp = await ipc.invokeWithProjectSession(projectSession, 'db:blueprint-get', chapterNumber, projectPath)
            if (bp?.title) chapterTitle = bp.title
            if (Array.isArray(bp?.characters)) chapterEntities = bp.characters
          } catch { /* 蓝图读取失败时使用默认标题 */ }

          // 修复运行也冻结一次模型租约，全部 LLM 后处理共享一个预算。
          const { RunFinalizePostProcessCommand } = await import('./commands/finalize-chapter.command')
          const status = await new RunFinalizePostProcessCommand({
            project,
            chapterNumber,
            chapterTitle,
            draftContent: full.content,
            draftId: draftMeta.id,
            finalizedSource: finalizedSource.snapshot.source,
            sourceLabel: text(
              `第${chapterNumber}章定稿`,
              `Chapter ${chapterNumber} finalized manuscript`,
            ),
            onlyFailed: true,
            retryInvalidResult: true,
            stepKey,
            chapterEntities,
          }).execute({ step: {}, context, callbacks })

          // 后处理修复不会产生新定稿快照，只请求项目资源刷新。
          const { globalEventBus } = await import('../../shared/event-bus')
          globalEventBus.emit('REFRESH_RESOURCE', {
            resources: ['fileTree', 'characterCards', 'drafts'],
            projectPath,
            projectSession,
          })
          const failedSteps = Object.entries(status.steps)
            .filter(([key, result]) => (!stepKey || key === stepKey) && !result.ok)
            .map(([, result]) => result.label)
          if (failedSteps.length > 0) {
            throw new Error(text(
              `后处理修复失败：${failedSteps.join('、')}。已定稿正文和已成功步骤已保留。`,
              `Post-processing repair failed: ${failedSteps.join(', ')}. The finalized manuscript and successful steps were preserved.`,
            ))
          }
        },
      },
    ],
    onComplete: {
      mode: 'open',
      message: text(
        `第${chapterNumber}章后处理修复完成`,
        `Chapter ${chapterNumber} post-processing repair completed`,
      ),
    },
  }
}
