import { afterEach, expect, it, vi } from 'vitest'
import type { MainGenerationReasoningEvent, MainGenerationRunView, MainGenerationSnapshot } from '../../generation/generation-runtime'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import type { StepCallbacks, WorkflowContext } from '../../../stores/workflow-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowReasoningStore } from '../../../stores/workflow-reasoning-store'
import { createWorkflowMainGenerationRuntime, type WorkflowMainGenerationSelection } from '../workflow-main-generation'
import type { createMainGenerationTransport } from '../../generation/main-generation-transport'

const session: ProjectSessionContext = { projectId: 'novel', leaseId: 'lease', projectPath: 'C:/novel' }
const handle = { projectId: session.projectId, epoch: session.leaseId, rootActionId: 'root', runId: 'generation' }
const view: MainGenerationRunView = { handle, budget: { maxAttempts: 1, maxRequestedOutputTokens: 100, maxRequestedOutputTokensPerAttempt: 100, deadlineAt: 1000 }, status: 'running', nonReplayable: false, artifacts: [] }
const originalProject = useProjectStore.getState()
const originalReasoning = useWorkflowReasoningStore.getState()

afterEach(() => {
  vi.unstubAllGlobals()
  useProjectStore.setState(originalProject, true)
  useWorkflowReasoningStore.setState(originalReasoning, true)
})

it.each(['navigation', 'snapshot'] as const)('pauses the opened run and restores context after %s setup failure', async failure => {
  const pause = vi.fn(async () => ({ ...view, status: 'paused' as const }))
  const transport = { begin: vi.fn(async () => view), pause,
    read: vi.fn(async () => ({ ...view, handle: { ...handle, runId: 'wrong-run' } })),
    subscribe: vi.fn(() => () => {}), subscribeReasoning: vi.fn(() => () => {}) } as unknown as ReturnType<typeof createMainGenerationTransport>
  const previousCancellation = vi.fn()
  const previousHandle = { ...handle, runId: 'previous-run' }
  const context: WorkflowContext = { runId: 'workflow', projectPath: session.projectPath, projectSession: session,
    generationModelId: 'model', writingLanguage: 'zh-CN', uiLocale: 'zh-CN', data: {}, cancelled: false, mainGenerationRunHandle: previousHandle,
    requestMainGenerationCancellation: previousCancellation }
  await expect(createWorkflowMainGenerationRuntime({ context,
    callbacks: { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() },
    selection: { operation: 'review-chapter', promptKeys: [], skillStages: [], output: 'visible-text',
      onRunOpened: async () => { if (failure === 'navigation') throw new Error('navigation failed') } } }, transport)).rejects.toThrow()
  expect(pause).toHaveBeenCalledExactlyOnceWith(handle)
  expect(context.mainGenerationRunHandle).toBe(previousHandle)
  expect(context.mainGenerationRootHandle).toBeUndefined()
  expect(context.requestMainGenerationCancellation).toBe(previousCancellation)
})

it('keeps the import ordinal when budget preflight rejects before a physical receipt', async () => {
  const invoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(async channel => {
    if (channel === 'import-generation:read') return { view, modelId: 'model', frozenContext: {} }
    throw new Error('TASK_BUDGET_SCOPE_SPLIT_REQUIRED:1')
  })
  vi.stubGlobal('window', { aiNovelAPI: { invoke } })
  const transport = { read: vi.fn(async () => view), subscribe: vi.fn(() => () => {}) } as unknown as ReturnType<typeof createMainGenerationTransport>
  const context: WorkflowContext = { runId: 'workflow', projectPath: session.projectPath, projectSession: session,
    generationModelId: 'model', writingLanguage: 'zh-CN', uiLocale: 'zh-CN', data: {}, cancelled: false }
  const runtime = await createWorkflowMainGenerationRuntime({ context,
    callbacks: { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() },
    selection: { operation: 'import-global-facts', promptKeys: [], skillStages: [], output: 'structured-data',
      importSlot: { runId: 'import-run', stage: 'global', batchId: 'done' } } }, transport)
  await runtime.execute(async ({ session: generation }) => {
    const task = { purpose: 'import-global-facts', output: 'structured-data' as const, messages: [] }
    await expect(generation.complete(task)).rejects.toThrow('TASK_BUDGET_SCOPE_SPLIT_REQUIRED')
    await expect(generation.complete(task)).rejects.toThrow('TASK_BUDGET_SCOPE_SPLIT_REQUIRED')
  })
  expect(invoke.mock.calls.filter(([channel]) => channel === 'import-generation:execute').map(call => call[1]))
    .toEqual([expect.objectContaining({ ordinal: 0 }), expect.objectContaining({ ordinal: 0 })])
})

it('shows only current run reasoning in volatile memory and clears it on project switch', async () => {
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: 'Novel', novelConfig: {} } as never })
  let emitReasoning: (event: MainGenerationReasoningEvent) => void = () => {}
  let emitSnapshot: (snapshot: MainGenerationSnapshot) => void = () => {}
  const unsubscribeReasoning = vi.fn()
  const transport = {
    begin: vi.fn(async () => view),
    read: vi.fn(async () => view),
    subscribe: vi.fn((_handle, listener) => { emitSnapshot = listener; return () => {} }),
    subscribeReasoning: vi.fn((_handle, listener) => { emitReasoning = listener; return unsubscribeReasoning }),
  } as unknown as ReturnType<typeof createMainGenerationTransport>
  const context = { runId: 'workflow', projectPath: session.projectPath, projectSession: session,
    generationModelId: 'model', writingLanguage: 'zh-CN', uiLocale: 'zh-CN', data: {}, cancelled: false } as WorkflowContext
  const callbacks = { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn(), setGenerationActivity: vi.fn() } satisfies StepCallbacks
  const runtime = await createWorkflowMainGenerationRuntime({ context, callbacks,
    selection: { operation: 'review-chapter', chapterNumber: 1, promptKeys: [], skillStages: [], output: 'visible-text' } }, transport)
  emitReasoning({ ...handle, attemptId: 'attempt', text: '临时推理' })
  expect(useWorkflowReasoningStore.getState().entries.workflow?.text).toBe('临时推理')
  const diagnostics = { startedAt: 0, elapsedMs: 10000, firstResponseMs: 1000, lastResponseMs: 10000,
    lastOutputMs: 9000, phase: 'stream' as const, visibleEvents: 0, reasoningEvents: 5 }
  const snapshot: MainGenerationSnapshot = { ...handle, artifactId: 'artifact', attemptId: 'attempt',
    revision: 0, durableRevision: 0, text: '', textHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', status: 'running', diagnostics }
  emitSnapshot(snapshot)
  await vi.waitFor(() => expect(callbacks.setGenerationActivity).toHaveBeenLastCalledWith({ operation: 'review-chapter', diagnostics }))
  const heartbeat = { ...diagnostics, elapsedMs: 20000, lastResponseMs: 20000 }
  emitSnapshot({ ...snapshot, diagnostics: heartbeat })
  await vi.waitFor(() => expect(callbacks.setGenerationActivity).toHaveBeenLastCalledWith({ operation: 'review-chapter', diagnostics: heartbeat }))
  expect(callbacks.setGenerationActivity.mock.calls.at(-1)![0].diagnostics.lastOutputMs).toBe(9000)
  useProjectStore.setState({ currentProject: { id: 'other', path: 'C:/other', sessionLease: 'other' } as never })
  expect(useWorkflowReasoningStore.getState().entries.workflow).toBeUndefined()
  emitReasoning({ ...handle, attemptId: 'attempt', text: '迟到推理' })
  expect(useWorkflowReasoningStore.getState().entries.workflow).toBeUndefined()
  await runtime.close()
  expect(unsubscribeReasoning).toHaveBeenCalledOnce()
})

/**
 * issue #200：审稿失败后的**同一步骤重试**不许把上一次尝试自己的 root 当成 parent。
 *
 * 现场：`review-chapter` 271.9 秒后 ECONNRESET（`NETWORK_ERROR`）→ 工作流层的
 * `withTransientRetry` 用**同一个 WorkflowContext** 再跑一遍 → 主进程抛
 * `GENERATION_REVIEW_CONTEXT_MISMATCH:parentRootActionId`。
 *
 * 机制：第一次 `open()` 成功后 `context.mainGenerationRootHandle` 就是那次审稿的 root
 * （`src/services/workflows/workflow-main-generation.ts:121`）。重试时 `open()` 又读到它，
 * 于是当成「续跑同一个动作」把 `parentRootActionId` 塞进 beginRequest；而审稿准入表
 * 要求首次审稿**没有** parent（`electron/services/review-revision-generation.ts:190`）→ 撞码。
 *
 * 这条测试钉住两件事：
 *   1. 重试（同一次动作内的第二次 open，且没有显式 restart/resume）**不带** parent；
 *   2. 跨阶段的 `advance()` 仍然**带** parent（那是设计上要共享 root 的）。
 */
it('does not turn a failed attempt’s own root into a parent when the same step retries (issue #200)', async () => {
  const begin = vi.fn(async (_session: ProjectSessionContext, _request: { parentRootActionId?: string }) => view)
  const transport = { begin, read: vi.fn(async () => view), pause: vi.fn(async () => ({ ...view, status: 'paused' as const })),
    subscribe: vi.fn(() => () => {}), subscribeReasoning: vi.fn(() => () => {}),
    cancel: vi.fn(async () => ({ ...view, status: 'cancelled' as const })) } as unknown as ReturnType<typeof createMainGenerationTransport>
  const context: WorkflowContext = { runId: 'workflow', projectPath: session.projectPath, projectSession: session,
    generationModelId: 'model', writingLanguage: 'zh-CN', uiLocale: 'zh-CN', data: {}, cancelled: false }
  // 真实审稿请求一定带 `reviewRevisionContextId`（主进程 `review-revision:prepare` 发的准入凭据）。
  const selection: WorkflowMainGenerationSelection = { operation: 'review-chapter', promptKeys: ['consistency_check'],
    skillStages: ['review'], output: 'structured-data', reviewRevisionContextId: 'prepared-context' }
  // 第一次：工作流自己的第一步，父动作应当为空（这是新动作的起点）。
  const runtime = await createWorkflowMainGenerationRuntime({ context,
    callbacks: { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() }, selection }, transport)
  expect(begin).toHaveBeenCalledTimes(1)
  expect(begin.mock.calls[0]![1]).not.toHaveProperty('parentRootActionId')
  // 模拟「这次尝试失败了但 root 已经落在 context 里」，然后用同一个 selection 重试。
  const failedRoot = { ...handle, rootActionId: 'failed-attempt-root', runId: 'failed-attempt-run' }
  context.mainGenerationRootHandle = failedRoot
  context.mainGenerationRunHandle = failedRoot
  await runtime.close()
  expect(begin).toHaveBeenCalledTimes(1) // 同一次 open 只发一次 begin，不会自己重开

  // 重试 = 再建一个 runtime、同一份 context（与 withTransientRetry 的行为一致）。
  await createWorkflowMainGenerationRuntime({ context,
    callbacks: { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() }, selection }, transport)
  expect(begin).toHaveBeenCalledTimes(2)
  expect(begin.mock.calls[1]![1], '重试不许把上次失败尝试自己的 root 当 parent')
    .not.toHaveProperty('parentRootActionId')
})

/**
 * #200 的反向保护：**跨阶段**（advance）仍然共享同一个 root。
 *
 * 修 #200 时最容易犯的错是「重试别带 parent」写成「一律别带 parent」——
 * 那会把起草 → 审稿 → 定稿共享一次预算的设计整个拆掉。
 * 这两条测试成对存在：一条证明重试不带，一条证明 advance 带。
 */
it('still shares the root when advancing to the next stage (issue #200 不许把 parent 一律砍掉)', async () => {
  const begin = vi.fn(async (_session: ProjectSessionContext, _request: { parentRootActionId?: string }) => view)
  const pause = vi.fn(async () => ({ ...view, status: 'paused' as const }))
  const transport = { begin, read: vi.fn(async () => view), pause,
    subscribe: vi.fn(() => () => {}), subscribeReasoning: vi.fn(() => () => {}),
    cancel: vi.fn(async () => ({ ...view, status: 'cancelled' as const })) } as unknown as ReturnType<typeof createMainGenerationTransport>
  const context: WorkflowContext = { runId: 'workflow', projectPath: session.projectPath, projectSession: session,
    generationModelId: 'model', writingLanguage: 'zh-CN', uiLocale: 'zh-CN', data: {}, cancelled: false }
  const runtime = await createWorkflowMainGenerationRuntime({ context,
    callbacks: { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() },
    selection: { operation: 'chapter-draft', chapterNumber: 5, promptKeys: [], skillStages: [], output: 'visible-text' } }, transport)
  expect(begin.mock.calls[0]![1]).not.toHaveProperty('parentRootActionId')
  // 同一 root 下的第二阶段（非审稿操作）：显式带 parent——这是设计的「一次动作共享预算」。
  // ⚠️ 审稿/修稿**不在**这一档：它们的 lineage 由主进程 `review-revision:prepare` 裁决
  // （`parentRootActionId` 按 recheck / confirmation / 恢复各算一次），工作流层再叠一个
  // 就是算第二个答案——那正是 #200 撞的错。
  await runtime.advance({ operation: 'finalized-chapter-notes', chapterNumber: 5, promptKeys: [],
    skillStages: [], output: 'structured-data' })
  expect(begin).toHaveBeenCalledTimes(2)
  expect(begin.mock.calls[1]![1]).toMatchObject({ parentRootActionId: handle.rootActionId })
})
