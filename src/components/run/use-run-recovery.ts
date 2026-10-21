import { useCallback, useEffect, useMemo, useState } from 'react'
import { ipc } from '../../services/ipc-client'
import { createBatchRecoveryWorkflow, createDraftRecoveryWorkflow } from '../../services/workflows/draft-recovery-workflow'
import { createReviewRevisionRecoveryWorkflow } from '../../services/workflows/review-revision-recovery-workflow'
import { withoutDraftReconciliationArtifacts } from '../../shared/draft-reconciliation'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../shared/project-session-context'
import { openPlanningRecoveryDraft, useEditorStore } from '../../stores/editor-store'
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
async function loadGenerationSources(session: ProjectSessionContext): Promise<{ sources: Omit<RecoverySources, 'candidates'>; partial: boolean }> {
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
  const candidates = summaries.filter(view => !view.operation || RECOVERABLE_OPERATIONS.has(view.operation))
  const contexts = await Promise.all(candidates.map(async summary => ({ view: await ipc.invokeWithProjectSession(session, 'generation:read', summary.handle),
    recovery: await ipc.invokeWithProjectSession(session, 'generation:read-context', { handle: summary.handle }),
  })))
  const reviews = await Promise.allSettled(contexts.filter(item => REVIEW_OPERATIONS.includes(item.recovery.operation))
    .map(async ({ view }) => ({ view, recovery: await ipc.invokeWithProjectSession(session, 'review-revision:read-recovery', { handle: view.handle }) })))
  const editors = await Promise.allSettled(contexts.filter(item => item.recovery.operation === 'editor-inline')
    .map(({ view }) => ipc.invokeWithProjectSession(session, 'editor-inline:read-recovery', { handle: view.handle })))
  const ours = (projectId: string) => projectId === session.projectId
  return {
    partial: [...reviews, ...editors].some(result => result.status === 'rejected'),
    sources: {
      planning: contexts.flatMap(item => (item.recovery.plotOutlineRecovery || item.recovery.blueprintRecovery)
        && item.recovery.planningContinuation?.state !== 'complete' && ours(item.recovery.handle.projectId) ? [item.recovery] : []),
      reviews: reviews.flatMap(result => result.status === 'fulfilled' && ours(result.value.view.handle.projectId) ? [result.value] : []),
      editors: editors.flatMap(result => result.status === 'fulfilled' && ours(result.value.view.handle.projectId) ? [result.value] : []),
      drafts: contexts.filter(item => item.recovery.operation === 'chapter-draft' && !item.recovery.batchId && ours(item.view.handle.projectId)
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
  resumeReview: (entry: ReviewEntry) => void
  resumeBatch: (entry: BatchEntry) => void
  resumeDraft: (entry: DraftEntry) => void
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
    void loadGenerationSources(session).then(({ sources, partial }) => {
      if (!active) return
      setGeneration({ session, value: sources })
      setGenerationError(partial ? (locale === 'en-US' ? 'Some tasks could not be loaded; the other candidates remain available.' : '部分任务暂时无法读取，其他候选仍可恢复。') : '')
    }).catch(reason => { if (active) setGenerationError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { active = false }
  }, [session, endedRuns, locale, snapshotTick])

  const entries = useMemo(() => {
    if (!session) return []
    const ofSession = <T,>(loaded: Loaded<T>, empty: T) => sameProjectSessionContext(loaded.session, session) ? loaded.value : empty
    return buildRecoveryEntries({ ...ofSession(generationList, EMPTY_RECOVERY_SOURCES), candidates: ofSession(candidateList, []) }, locale)
  }, [session, generationList, candidateList, locale])

  const stillCurrent = useCallback(() => session !== null && sameProjectSessionContext(session, currentSession()), [session])

  const act = useCallback(async (operation: (session: ProjectSessionContext) => Promise<void>) => {
    if (busy || !session || !stillCurrent()) return
    setBusy(true)
    try { await operation(session); setGenerationError('') } catch (reason) { setGenerationError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }, [busy, session, stillCurrent])

  const showGenerationFailure = useCallback((reason: unknown) => {
    if (stillCurrent()) setGenerationError(reason instanceof Error ? reason.message : String(reason))
  }, [stillCurrent])

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
    entries,
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
    continueEditor: entry => void act(async current => {
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
