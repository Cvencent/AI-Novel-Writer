import { useCallback, useEffect, useMemo, useState } from 'react'
import { ipc } from '../../services/ipc-client'
import { createBatchRecoveryWorkflow, createDraftRecoveryWorkflow } from '../../services/workflows/draft-recovery-workflow'
import { createReviewRevisionRecoveryWorkflow } from '../../services/workflows/review-revision-recovery-workflow'
import { withoutDraftReconciliationArtifacts } from '../../shared/draft-reconciliation'
import type { GenerationRecoveryContext } from '../../shared/generation-owner-contract'
import type { MainGenerationRunView } from '../../services/generation/generation-runtime'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { MainGenerationRunHandle } from '../../services/generation/generation-runtime'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../shared/project-session-context'
import { openPlanningRecoveryDraft, useEditorStore } from '../../stores/editor-store'
import { formatResourceUri } from '../../shared/project-paths'
import { writeCoreContent } from '../../services/resource-protocol'
import { openArchFile } from '../panels/sidebar/sidebar-file-openers'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore, type WorkflowDefinition } from '../../stores/workflow-store'
import {
  buildRecoveryEntries, EMPTY_RECOVERY_SOURCES, hasText, planningTitle,
  type BatchEntry, type CandidateEntry, type DraftEntry, type EditorEntry, type PlanningEntry, type RecoveryEntry, type RecoverySources, type ReviewEntry,
} from './run-recovery'

const REVIEW_OPERATIONS = ['review-chapter', 'refine-draft', 'refine-from-review']

function currentSession(): ProjectSessionContext | null {
  return projectSessionContextFromProject(useProjectStore.getState().currentProject)
}

/**
 * 读取这部作品所有可恢复的中断运行。助手任务（agent-round）随聊天隐藏，不读取也不列出，磁盘记录保留。
 *
 * 列表接口只回句柄与元数据（作品写到几百章后历史 run 很多，逐个水合完整视图是几秒级的卡顿），
 * 因此这里先用列表里的 operation 缩小范围，再只对**可能是恢复候选**的运行读完整视图与恢复上下文。
 * 助手任务与已经跑完的任务从头到尾不会被水合。
 */
async function loadGenerationSources(session: ProjectSessionContext): Promise<{ sources: Omit<RecoverySources, 'candidates'>; partial: boolean; unreadableHandles: MainGenerationRunHandle[] }> {
  const [summaries, progress] = await Promise.all([
    ipc.invokeWithProjectSession(session, 'generation:list'),
    ipc.invokeWithProjectSession(session, 'generation:list-batches'),
  ])
  // 先把明显不是恢复候选的排掉：助手任务不在运行侧页显示，其它不在待恢复集合里的也不用读。
  // 运行侧页的恢复区只显示这几类运行留下的可恢复内容：
  //   generate-plot-outline / chapter-blueprint-directory → 规划恢复稿
  //   chapter-draft → 单章候选与未落盘正文
  //   审修与选区建议 → 各自的恢复面板
  // 其它 operation（角色名单生成、世界观生成、核心种子等）不产生恢复条目，
  // 以前也会为它们逐个读一次恢复上下文，纯属白花时间。
  const RECOVERABLE_OPERATIONS = new Set([
    'generate-plot-outline', 'chapter-blueprint-directory', 'chapter-draft',
    ...REVIEW_OPERATIONS, 'editor-inline',
  ])
  // 主进程已用运行纪要便宜地判定「可能仍有可恢复内容」（recoverableHint）。
  // hint=false 的老运行（续写已消费完/来源失效）直接跳过深读取——老项目几百条
  // 历史运行里绝大多数属于这一类，深扫描集合因此压到个位数。
  const candidates = summaries.filter(view =>
    !view.operation || (RECOVERABLE_OPERATIONS.has(view.operation) && view.recoverableHint !== false))
  // 单个旧运行的深读取可能失败（损坏的候选、旧版本的记录形态……）。
  // 一条坏记录不该让整个恢复区反复报「部分任务暂时无法读取」——失败的运行
  // 收进 unreadable，由界面聚成一行，作者可一键按 runId 永久忽略。
  // 历史运行可能有几百条：全量并发深读取会把主进程和渲染层同时打满，
  // 作者切页时整个界面都加载不出来。这里限制并发、分批推进，让出主线程。
  const DEEP_READ_CONCURRENCY = 6
  type DeepRead = { index: number; view: MainGenerationRunView; recovery: GenerationRecoveryContext }
  const settledContexts: PromiseSettledResult<DeepRead>[] = []
  for (let start = 0; start < candidates.length; start += DEEP_READ_CONCURRENCY) {
    const batch = candidates.slice(start, start + DEEP_READ_CONCURRENCY)
    const settled = await Promise.allSettled(batch.map(async (summary, offset) => ({ index: start + offset,
      view: await ipc.invokeWithProjectSession(session, 'generation:read', summary.handle),
      recovery: await ipc.invokeWithProjectSession(session, 'generation:read-context', { handle: summary.handle }),
    })))
    settledContexts.push(...settled)
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  const contexts = settledContexts.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
  const unreadableHandles = settledContexts.flatMap((result, index) => result.status === 'rejected' ? [candidates[index]!.handle] : [])
  // 作者点过「移除卡片」的运行：产物与运行记录都还在，但不再派生恢复卡片。
  // 只看这次读到的标记，不额外查库；标记随 read-context 一起回来。
  const live = contexts.filter(item => item.recovery.recoveryDismissed !== true)
  const reviews = await Promise.allSettled(live.filter(item => REVIEW_OPERATIONS.includes(item.recovery.operation))
    .map(async ({ view }) => ({ view, recovery: await ipc.invokeWithProjectSession(session, 'review-revision:read-recovery', { handle: view.handle }) })))
  const editors = await Promise.allSettled(live.filter(item => item.recovery.operation === 'editor-inline')
    .map(({ view }) => ipc.invokeWithProjectSession(session, 'editor-inline:read-recovery', { handle: view.handle })))
  const ours = (projectId: string) => projectId === session.projectId
  return {
    unreadableHandles,
    partial: [...reviews, ...editors].some(result => result.status === 'rejected'),
    sources: {
      planning: live.flatMap(item => (item.recovery.plotOutlineRecovery || item.recovery.blueprintRecovery)
        && item.recovery.planningContinuation?.state !== 'complete' && ours(item.recovery.handle.projectId) ? [item.recovery] : []),
      reviews: reviews.flatMap(result => result.status === 'fulfilled' && ours(result.value.view.handle.projectId) ? [result.value] : []),
      editors: editors.flatMap(result => result.status === 'fulfilled' && ours(result.value.view.handle.projectId) ? [result.value] : []),
      drafts: live.filter(item => item.recovery.operation === 'chapter-draft' && !item.recovery.batchId && ours(item.view.handle.projectId)
        && (item.recovery.composition || item.recovery.draftShortOutline?.completedOutput || item.recovery.draftShortOutline?.retry?.kind === 'available'
          || withoutDraftReconciliationArtifacts([...item.view.artifacts, ...(item.view.candidates ?? [])], item.recovery).some(hasText)
          || item.view.unsavedTails?.some(hasText))),
      batches: progress.filter(item => item.nextChapterNumber !== null && ours(item.rootHandle.projectId)),
    },
  }
}

/** 读到的数据连同读取时的会话一起保存；换了会话，旧数据就不再显示也不能被操作。 */
interface Loaded<T> {
  session: ProjectSessionContext | null
  value: T
}

export interface RunRecovery {
  entries: RecoveryEntry[]
  /** 旧恢复候选表的读取或操作失败。 */
  candidateError: string
  /** 中断运行的读取或操作失败。 */
  generationError: string
  busy: boolean
  picked: (entry: DraftEntry) => readonly string[]
  togglePick: (entry: DraftEntry, artifactId: string, checked: boolean) => void
  /** 复制一段生成文字；失败写进 generationError。 */
  copy: (text: string) => void
  copyCandidate: (entry: CandidateEntry) => void
  continueCandidate: (entry: CandidateEntry) => void
  discardCandidate: (entry: CandidateEntry) => void
  openPlanning: (entry: PlanningEntry) => void
  continueEditor: (entry: EditorEntry) => void
  applyEditor: (entry: EditorEntry) => void
  resumeReview: (entry: ReviewEntry) => void
  resumeBatch: (entry: BatchEntry) => void
  resumeDraft: (entry: DraftEntry) => void
  /** 从右侧列表移除一张恢复卡片；不改动已经保存的正式内容。 */
  dismiss: (entry: RecoveryEntry) => void
  /** 一键放弃全部恢复卡片（持久）；正式内容不动。 */
  dismissAll: () => Promise<void>
  /** 深读取失败的旧任务数量（>0 时恢复区给出可忽略提示）。 */
  unreadableCount: number
  /** 永久忽略全部无法读取的旧任务（按 runId 写恢复忽略标记）。 */
  dismissUnreadable: () => Promise<void>
}

/**
 * 运行侧页的恢复区：数据与动作。每个动作开始前确认仍是读取时的那次项目会话，
 * 换了作品或重开过就什么也不做，不把旧会话的恢复写进新会话。
 */
export function useRunRecovery(): RunRecovery {
  const locale = useLocaleStore(s => s.locale)
  const project = useProjectStore(s => s.currentProject)
  const session = useMemo(() => projectSessionContextFromProject(project), [project])
  const endedRuns = useWorkflowStore(s => s.history.length)
  const [candidateList, setCandidates] = useState<Loaded<RecoverySources['candidates']>>({ session: null, value: [] })
  const [candidateError, setCandidateError] = useState('')
  const [generationList, setGeneration] = useState<Loaded<Omit<RecoverySources, 'candidates'>>>({ session: null, value: EMPTY_RECOVERY_SOURCES })
  const [generationError, setGenerationError] = useState('')
  const [snapshotTick, setSnapshotTick] = useState(0)
  const [selection, setSelection] = useState<Record<string, string[]>>({})
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())

  useEffect(() => {
    if (!session) {
      const clear = window.setTimeout(() => setCandidateError(''), 0)
      return () => window.clearTimeout(clear)
    }
    let active = true
    void ipc.invokeWithProjectSession(session, 'db:recovery-candidate-list', session.projectPath).then(list => {
      if (!active || !sameProjectSessionContext(session, currentSession())) return
      setCandidates({ session, value: list })
      setCandidateError('')
    }).catch(error => {
      if (!active) return
      setCandidates({ session, value: [] })
      setCandidateError(error instanceof Error ? error.message : String(error))
    })
    return () => { active = false }
  }, [session])

  useEffect(() => {
    if (!session) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const detach = ipc.on('generation:snapshot', snapshot => {
      if (snapshot.projectId !== session.projectId || snapshot.epoch !== session.leaseId || snapshot.status === 'running') return
      clearTimeout(timer)
      timer = setTimeout(() => setSnapshotTick(value => value + 1), 100)
    })
    return () => { detach(); clearTimeout(timer) }
  }, [session])

  useEffect(() => {
    if (!session) return
    let active = true
    void loadGenerationSources(session).then(({ sources, partial, unreadableHandles }) => {
      if (!active) return
      setGeneration({ session, value: sources })
      setUnreadable({ session, value: unreadableHandles })
      // 深读取失败的旧任务聚成一行可忽略的提示；只有审修/编辑恢复载荷读取失败仍按原样提示。
      setGenerationError(unreadableHandles.length > 0
        ? (locale === 'en-US'
          ? `${unreadableHandles.length} old task(s) could not be read. You can ignore them.`
          : `${unreadableHandles.length} 个旧任务暂时无法读取，可一键忽略。`)
        : partial ? (locale === 'en-US' ? 'Some tasks could not be loaded; the other candidates remain available.' : '部分任务暂时无法读取，其他候选仍可恢复。') : '')
    }).catch(reason => { if (active) setGenerationError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { active = false }
  }, [session, endedRuns, locale, snapshotTick])

  const [unreadable, setUnreadable] = useState<Loaded<readonly MainGenerationRunHandle[]>>({ session: null, value: [] })

  const entries = useMemo(() => {
    if (!session) return []
    const ofSession = <T,>(loaded: Loaded<T>, empty: T) => sameProjectSessionContext(loaded.session, session) ? loaded.value : empty
    return buildRecoveryEntries({ ...ofSession(generationList, EMPTY_RECOVERY_SOURCES), candidates: ofSession(candidateList, []) }, locale)
  }, [session, generationList, candidateList, locale])

  const stillCurrent = useCallback(() => session !== null && sameProjectSessionContext(session, currentSession()), [session])

  const showGenerationFailure = useCallback((reason: unknown) => {
    if (stillCurrent()) setGenerationError(reason instanceof Error ? reason.message : String(reason))
  }, [stillCurrent])

  /**
   * 持久放弃一张恢复卡片。正式内容、检查点与运行记录都保留；只是让运行侧页
   * 不再从这条记录派生卡片。
   *
   * 过去的「移除卡片」只写进会话内的 dismissed 集合，切页或重开作品后同一张
   * 卡片又从 generation_runs 里长回来——这正是作者反复反馈的现象。现在与
   * 「一键清除全部卡片」走同一条持久路径：
   *   候选表 → recovery-candidate-resolve('discarded')
   *   生成运行 → generation:dismiss-recovery（写 $runEffects.recoveryDismissed）
   */
  const persistDismiss = useCallback(async (current: ProjectSessionContext, entry: RecoveryEntry): Promise<void> => {
    setDismissed(previous => new Set(previous).add(`${entry.kind}:${entry.key}`))
    if (entry.kind === 'candidate') {
      await ipc.invokeWithProjectSession(current, 'db:recovery-candidate-resolve', entry.candidate.candidateId, 'discarded', current.projectPath)
      return
    }
    if (entry.kind === 'planning' || entry.kind === 'draft' || entry.kind === 'review' || entry.kind === 'editor') {
      const handle = entry.kind === 'planning' ? entry.recovery.handle
        : entry.kind === 'draft' || entry.kind === 'review' ? entry.view.handle
        : entry.recovery.view.handle
      await ipc.invokeWithProjectSession(current, 'generation:dismiss-recovery', handle)
    }
    // 批量进度没有 dismiss 通道；保留（它代表真实的批次续写状态）。
  }, [])

  /** 一键放弃全部恢复卡片：逐张持久放弃；正式内容不动。 */
  const dismissAll = useCallback(async () => {
    if (!session || !stillCurrent() || busy) return
    setBusy(true)
    try {
      const currentEntries = entries.filter(entry => !dismissed.has(`${entry.kind}:${entry.key}`))
      for (const entry of currentEntries) {
        try { await persistDismiss(session, entry) } catch { /* 单个失败不阻断其余；下一次打开仍可见。 */ }
      }
      setSnapshotTick(value => value + 1)
    } finally { setBusy(false) }
  }, [session, stillCurrent, busy, entries, dismissed, persistDismiss])
  /** 移除单张卡片：与一键清除走同一条持久路径，重开作品后不再出现。 */
  const dismiss = useCallback((entry: RecoveryEntry) => {
    if (!session || !stillCurrent()) {
      setGenerationError(locale === 'en-US' ? 'The project session changed; reopen the book.' : '项目会话已切换，请重新打开作品。')
      return
    }
    void persistDismiss(session, entry)
      .then(() => setGenerationError(''))
      .catch(error => showGenerationFailure(error))
  }, [session, stillCurrent, persistDismiss, locale, showGenerationFailure])

  /** 深读取失败的旧任务：按 runId 永久忽略，恢复区不再反复提示。 */
  const dismissUnreadable = useCallback(async () => {
    if (!session || busy || !unreadable.session || !sameProjectSessionContext(unreadable.session, session)) return
    setBusy(true)
    try {
      for (const handle of unreadable.value) {
        await ipc.invokeWithProjectSession(session, 'generation:dismiss-recovery', handle).catch(() => undefined)
      }
      setUnreadable({ session, value: [] })
      setGenerationError('')
      setSnapshotTick(value => value + 1)
    } catch (cause) {
      showGenerationFailure(cause)
    } finally {
      setBusy(false)
    }
  }, [session, busy, unreadable, showGenerationFailure])


  const act = useCallback(async (operation: (session: ProjectSessionContext) => Promise<void>) => {
    if (busy || !session || !stillCurrent()) return
    setBusy(true)
    try { await operation(session); setGenerationError('') } catch (reason) { setGenerationError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }, [busy, session, stillCurrent])

  /** startWorkflow 要等整个工作流结束才返回；只等定义建好，不让恢复区在运行期间一直忙。 */
  const startRecovery = useCallback((create: (session: ProjectSessionContext) => Promise<WorkflowDefinition>) =>
    void act(async current => {
      const definition = await create(current)
      if (stillCurrent()) useWorkflowStore.getState().startWorkflow(definition).catch(showGenerationFailure)
    }), [act, stillCurrent, showGenerationFailure])

  const dropCandidate = (candidateId: string) => {
    setCandidates(loaded => ({ ...loaded, value: loaded.value.filter(item => item.candidateId !== candidateId) }))
    setCandidateError('')
  }

  const failCandidate = useCallback((error: unknown) => {
    if (!stillCurrent()) return
    const message = error instanceof Error ? error.message : error ? String(error) : ''
    setCandidateError(message || (locale === 'en-US' ? 'Recovery candidate action failed' : '恢复候选操作失败'))
  }, [locale, stillCurrent])

  return {
    entries: entries.filter(entry => !dismissed.has(`${entry.kind}:${entry.key}`)),
    dismiss,
    dismissAll,
    unreadableCount: session && unreadable.session && sameProjectSessionContext(unreadable.session, session) ? unreadable.value.length : 0,
    dismissUnreadable,
    candidateError,
    generationError,
    busy,
    picked: entry => selection[entry.key] ?? [],
    togglePick: (entry, artifactId, checked) => setSelection(previous => {
      const current = previous[entry.key] ?? []
      return { ...previous, [entry.key]: checked ? [...current, artifactId] : current.filter(id => id !== artifactId) }
    }),
    copy: text => {
      if (stillCurrent()) navigator.clipboard.writeText(text).catch(showGenerationFailure)
    },
    copyCandidate: entry => {
      if (!stillCurrent()) return
      navigator.clipboard.writeText(entry.text).then(() => setCandidateError(''),
        error => setCandidateError(error instanceof Error ? error.message : String(error)))
    },
    continueCandidate: entry => {
      if (!session || !stillCurrent() || !entry.canContinue) return
      void ipc.invokeWithProjectSession(session, 'db:recovery-candidate-update', entry.candidate.candidateId, entry.candidate.visibleText, session.projectPath)
        .then(result => {
          if (!stillCurrent()) return
          if (!result.success || !result.candidate) return failCandidate(result.error)
          const candidate = result.candidate
          useEditorStore.getState().openFile({
            id: `recovery:${candidate.candidateId}`,
            name: locale === 'en-US'
              ? `Recovery candidate · Chapter ${candidate.chapterNumber} ${candidate.chapterTitle}`
              : `恢复候选 · 第${candidate.chapterNumber}章 ${candidate.chapterTitle}`,
            type: 'chapter',
            filePath: `ai-novel://recovery/${candidate.candidateId}`,
            content: candidate.visibleText,
            savedContent: candidate.visibleText,
            dirty: false,
            projectKey: session.projectPath,
            projectSessionLease: session.leaseId,
          })
          dropCandidate(entry.key)
        }, failCandidate)
    },
    discardCandidate: entry => {
      if (!session || !stillCurrent()) return
      void ipc.invokeWithProjectSession(session, 'db:recovery-candidate-resolve', entry.candidate.candidateId, 'discarded', session.projectPath)
        .then(result => {
          if (!stillCurrent()) return
          if (!result.success) return failCandidate(result.error)
          dropCandidate(entry.key)
        }, failCandidate)
    },
    openPlanning: entry => void act(async current => {
      const fresh = await ipc.invokeWithProjectSession(current, 'generation:read-context', { handle: entry.recovery.handle })
      if (!stillCurrent()) return
      openPlanningRecoveryDraft(fresh, current.projectPath, planningTitle(fresh, locale))
    }),
    /** 完成的选区建议：按原选区替换回原文档（正文稿或架构 core 字段），并打开对应标签。 */
    applyEditor: entry => {
      if (!session || !stillCurrent()) { setGenerationError(locale === 'en-US' ? 'The project session changed; reopen the book.' : '项目会话已切换，请重新打开作品。'); return }
      const text = entry.suggestions.at(-1)?.text?.trim()
      if (!text) { showGenerationFailure(locale === 'en-US' ? 'No completed suggestion to apply.' : '没有可应用的完成结果。'); return }
      void act(async current => {
        const recovery = await ipc.invokeWithProjectSession(current, 'editor-inline:read-recovery', { handle: entry.recovery.view.handle })
        if (!stillCurrent()) return
        if (recovery.sourceStatus !== 'current') { showGenerationFailure(locale === 'en-US' ? 'Sources changed; the result can only be copied.' : '来源已变化，结果只能复制。'); return }
        const { documentText, from, to } = recovery.context
        if (documentText.slice(from, to) !== entry.selectedText) { showGenerationFailure(locale === 'en-US' ? 'The original selection changed; apply from the editor instead.' : '原选区已变化，请在编辑器内应用。'); return }
        const next = documentText.slice(0, from) + text + documentText.slice(to)
        const scope = recovery.context.scope ?? 'chapter-draft'
        if (scope === 'chapter-draft') {
          // 正文稿：写入草稿库（以合并稿身份直接覆盖原文选区）
          const tabs = useEditorStore.getState().tabs
          // 用 open 恢复编辑器上下文：把结果放回预览的既有路径是编辑器组件；这里直接改 tab 内容并标记 dirty
          const target = tabs.find(candidate => candidate.projectKey === current.projectPath && (candidate.content ?? '').includes(entry.selectedText))
          if (target) {
            useEditorStore.getState().openFile({ ...target, content: next, savedContent: target.savedContent, dirty: true })
            useEditorStore.setState(state => ({ tabs: state.tabs.map(t => t.id === target.id ? { ...t, content: next, dirty: true } : t) }))
            void ipc.invokeWithProjectSession(current, 'editor-inline:cancel', { handle: entry.recovery.view.handle }).catch(() => {})
            return
          }
          showGenerationFailure(locale === 'en-US' ? 'Open the chapter editor first, then apply from there.' : '请先打开该章正文，再从编辑器应用。')
          return
        }
        // 架构 core 字段：直接按整篇写回（writeCoreContent 对 arc 拒绝，届时提示复制）
        const uri = formatResourceUri({ kind: 'core', key: scope as 'premise' | 'worldbuilding' | 'characters' | 'synopsis' })
        const ok = await writeCoreContent(uri, next, current)
        if (!stillCurrent()) return
        if (!ok) { showGenerationFailure(locale === 'en-US' ? 'This document does not support direct overwrite; copy instead.' : '该文档不支持直接覆盖写回，请复制使用。'); return }
        void ipc.invokeWithProjectSession(current, 'editor-inline:cancel', { handle: entry.recovery.view.handle }).catch(() => {})
        void openArchFile(formatResourceUri({ kind: 'core', key: scope as 'premise' | 'worldbuilding' | 'characters' | 'synopsis' }), locale === 'en-US' ? 'Architecture' : '架构文档').catch(() => {})
      })
    },    continueEditor: entry => void act(async current => {
      await ipc.invokeWithProjectSession(current, 'editor-inline:execute', { handle: entry.recovery.view.handle })
      if (stillCurrent()) setSnapshotTick(value => value + 1)
    }),
    resumeReview: entry => startRecovery(current => createReviewRevisionRecoveryWorkflow(current, entry.view.handle)),
    resumeBatch: entry => startRecovery(current => createBatchRecoveryWorkflow(current, entry.batchId)),
    resumeDraft: entry => {
      const picked = selection[entry.key] ?? []
      startRecovery(current => createDraftRecoveryWorkflow(current, entry.view.handle, picked.length ? [...picked] : undefined))
    },
  }
}






