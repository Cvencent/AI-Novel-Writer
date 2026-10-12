import { useCallback, useEffect, useRef, useState } from 'react'
import { CANONICAL_PROJECT_DIRECTORY } from '../../shared/project-format'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useLocaleStore } from '../../stores/locale-store'
import { ipc } from '../../services/ipc-client'
import { launchCreativeWorkflow } from '../../services/workflows/creative-workflow-launcher'
import type { ArchStepKey } from '../../services/architecture-step-selection'
import { globalEventBus } from '../../shared/event-bus'
import {
  createProjectArchTabId,
  shouldRefreshArchOnWorkflowComplete,
  shouldSyncProjectArchTab,
} from './arch-file-refresh-policy'
import { LatestRequestGate } from './latest-request-gate'
import {
  canExplicitlyRepairCharacterRoster,
  getCharacterRosterRepairPresentation,
} from './character-roster-repair-state'
import { useCharacterRosterRepair } from './use-character-roster-repair'
import {
  captureProjectSession,
  isProjectSessionCurrent,
  isProjectSessionPath,
} from '../project-session-gate'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { sameProjectSessionContext } from '../../shared/project-session-context'
import type { MainGenerationRunHandle } from '../../services/generation/generation-runtime'
import { architectureRecoveryHandle } from '../../shared/architecture-recovery-navigation'
import { DEFAULT_PLANNING_ACTION_CHAPTERS } from '../../shared/plot-outline-contract'
import type { GenerationRecoveryContext } from '../../shared/generation-owner-contract'
import { openPlanningRecoveryDraft } from '../../stores/editor-store'
import {
  hasVisiblePartialSynopsisMarker,
  isUsableSynopsisCheckpoint,
} from '../../services/workflows/commands/architecture.command'

/** 架构四节在旧外壳里的名字；新外壳的架构阶段把「角色图谱」叫作「角色名单」。 */
export const ARCH_FILES: Array<{
  key: ArchStepKey
  fileName: string
  labelZh: string
  labelEn: string
  iconName: string
  descZh: string
  descEn: string
}> = [
    { key: 'premise', fileName: 'premise.md', labelZh: '故事前提', labelEn: 'Story premise', iconName: 'target', descZh: '故事钩子 · 核心冲突链 · 主角优势 · 悬念骨架', descEn: 'Story hook · core conflict · protagonist edge · suspense structure' },
    { key: 'characters', fileName: 'characters.md', labelZh: '角色图谱', labelEn: 'Character map', iconName: 'users', descZh: '角色弧光 · 关系网络 · 矛盾交织', descEn: 'Character arcs · relationships · interlocking tensions' },
    { key: 'worldbuilding', fileName: 'worldbuilding.md', labelZh: '世界观', labelEn: 'Worldbuilding', iconName: 'globe', descZh: '核心规则 · 社会结构 · 深层危机', descEn: 'Core rules · social structure · underlying crisis' },
    { key: 'synopsis', fileName: 'synopsis.md', labelZh: '情节大纲', labelEn: 'Plot outline', iconName: 'map', descZh: '结构推进 · 转折节奏 · 伏笔闭环', descEn: 'Story progression · turning points · setup and payoff' },
  ]

/**
 * 故事架构总览的数据与操作：四节状态、未完成候选、大纲续写与续批、角色名单修复、打开单节文档与架构生成。
 * 旧外壳的 WorldBuildingEditor 与新外壳的架构阶段共用这一份。
 */
export function useArchitectureOverview(projectKey: string) {
  const currentProject = useProjectStore(s => s.currentProject)
  const text = useLocaleStore(s => s.text)
  const projectMatches = currentProject?.path === projectKey
  const latestArchitectureTerminalRunId = useWorkflowStore(state => (
    state.history.find(run => run.type === 'architecture_generation' && run.projectPath === projectKey)?.id ?? null
  ))
  const [archStatus, setArchStatus] = useState<Record<string, boolean>>({})
  const [planningRecovery, setPlanningRecovery] = useState<GenerationRecoveryContext | null>(null)
  const [wordCounts, setWordCounts] = useState<Record<string, number>>({})
  const [synopsisIncomplete, setSynopsisIncomplete] = useState(false)
  const [synopsisRecoveryFailed, setSynopsisRecoveryFailed] = useState(false)
  const [synopsisCoveredTo, setSynopsisCoveredTo] = useState<number>(0)
  const [synopsisTotalChapters, setSynopsisTotalChapters] = useState<number>(0)
  const [synopsisBusy, setSynopsisBusy] = useState(false)
  const [synopsisCandidate, setSynopsisCandidate] = useState('')
  const [showSynopsisCandidate, setShowSynopsisCandidate] = useState(false)
  const [synopsisHandle, setSynopsisHandle] = useState<MainGenerationRunHandle | null>(null)
  const [worldHandle, setWorldHandle] = useState<MainGenerationRunHandle | null>(null)
  const [worldBuildingCandidate, setWorldBuildingCandidate] = useState('')
  const [worldBuildingBusy, setWorldBuildingBusy] = useState(false)
  const [showWorldBuildingCandidate, setShowWorldBuildingCandidate] = useState(false)
  const [pendingSynopsisRange, setPendingSynopsisRange] = useState<{ from: number; to: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [showArchDialog, setShowArchDialog] = useState(false)
  const lastCompletedArchitectureRunRef = useRef<string | null>(null)
  const archStatusRequestGate = useRef(new LatestRequestGate())
  const {
    snapshot: rosterSnapshot,
    repairError: rosterRepairError,
    isRepairing: extracting,
    refresh: loadCharacterRosterStatus,
    migrate: handleRepairCharacterRoster,
  } = useCharacterRosterRepair({ projectKey, enabled: projectMatches })

  /** 加载各架构文件状态（通过 Service 层获取，不直接调 IPC） */
  const loadStatus = useCallback(async () => {
    await Promise.resolve()
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) {
      archStatusRequestGate.current.begin()
      setArchStatus({})
      setWordCounts({})
      setSynopsisIncomplete(false)
      setSynopsisRecoveryFailed(false)
      setSynopsisCoveredTo(0)
      setSynopsisTotalChapters(0)
      setSynopsisCandidate('')
      setSynopsisHandle(null)
      setWorldHandle(null)
      setShowSynopsisCandidate(false)
      setWorldBuildingCandidate('')
      setShowWorldBuildingCandidate(false)
      setLoading(false)
      return
    }
    const projectPath = projectSession.projectPath
    const requestId = archStatusRequestGate.current.begin()
    setLoading(true)
    const core = await ipc.invokeWithProjectSession(
      projectSession,
      'db:project-core-get',
      projectPath,
    )
    // 情节大纲状态：中断可断点续写；或部分覆盖可分批续写（covered_to < total）
    let interrupted = false
    let recoveryFailed = false
    let coveredTo = 0
    let recoveredWorldBuildingCandidate = ''
    let recoveredSynopsisCandidate = ''
    let confirmedWorldHandle: MainGenerationRunHandle | null = null
    let confirmedSynopsisHandle: MainGenerationRunHandle | null = null
    let recoveredPlanning: GenerationRecoveryContext | null = null
    const dbSynopsis = core?.synopsis || ''
    const totalChapters = Number(core?.totalChapters ?? currentProject?.novelConfig?.totalChapters) || 0
    const writingLanguage = (core?.writingLanguage ?? currentProject?.novelConfig?.writingLanguage) === 'en-US'
      ? 'en-US'
      : 'zh-CN'
    const visiblyPartial = hasVisiblePartialSynopsisMarker(dbSynopsis)
    try {
      const partialResult = await ipc.invokeWithProjectSession(
        projectSession,
        'fs:read-json',
        `${projectPath}/${CANONICAL_PROJECT_DIRECTORY}/partial_arch.json`,
        projectPath,
      )
      const partial = partialResult?.success === true
        ? (partialResult as { data?: Record<string, unknown> }).data
        : undefined
      recoveredWorldBuildingCandidate = partial?.world_building_incomplete === true && typeof partial.world_building_partial_result === 'string'
        ? partial.world_building_partial_result : ''
      recoveredSynopsisCandidate = partial?.synopsis_incomplete === true && typeof partial.synopsis_result === 'string'
        ? partial.synopsis_result : ''
      // A failed main read must not hide the independently readable legacy candidate.
      for (const kind of ['worldbuilding', 'synopsis'] as const) {
        const handle = architectureRecoveryHandle(partial, kind, projectSession.projectId)
        if (!handle) continue
        try {
          if (kind === 'synopsis') {
            const context = await ipc.invokeWithProjectSession(projectSession, 'generation:read-context', { handle }).catch(() => null)
            if (context?.plotOutlineRecovery) {
              recoveredPlanning = context
              recoveredSynopsisCandidate = context.plotOutlineRecovery.draft
              confirmedSynopsisHandle = handle
              continue
            }
          }
          const composition = await ipc.invokeWithProjectSession(projectSession, 'generation:read-visible-composition', handle)
          if (composition?.algorithm !== 'visible-append-v1' || !composition.text) continue
          if (kind === 'worldbuilding') {
            recoveredWorldBuildingCandidate = composition.text
            confirmedWorldHandle = handle
          } else {
            recoveredSynopsisCandidate = composition.text
            confirmedSynopsisHandle = handle
          }
        } catch { /* Preserve the readable mirror; it does not authorize continuation. */ }
      }
      const checkpointUsable = isUsableSynopsisCheckpoint(
        partial,
        dbSynopsis,
        writingLanguage,
        totalChapters,
      )
      interrupted = Boolean(confirmedSynopsisHandle)
      recoveryFailed = visiblyPartial && !checkpointUsable
      coveredTo = checkpointUsable && Number(partial?.synopsis_covered_to) > 0
        ? Number(partial?.synopsis_covered_to)
        : 0
    } catch {
      interrupted = false
      recoveryFailed = visiblyPartial
      coveredTo = 0
      recoveredWorldBuildingCandidate = ''
    }
    const status: Record<string, boolean> = {
      premise: (core?.premise?.length ?? 0) > 50,
      characters: rosterSnapshot?.status === 'ready',
      worldbuilding: (core?.worldbuilding?.length ?? 0) > 50,
      synopsis: (core?.synopsis?.length ?? 0) > 50,
    }
    const counts: Record<string, number> = {
      premise: status.premise ? (core?.premise?.length ?? 0) : 0,
      characters: status.characters ? (rosterSnapshot?.renderedMarkdown.length ?? 0) : 0,
      worldbuilding: status.worldbuilding ? (core?.worldbuilding?.length ?? 0) : 0,
      synopsis: status.synopsis ? (core?.synopsis?.length ?? 0) : 0,
    }
    if (
      !archStatusRequestGate.current.isLatest(requestId)
      || !isProjectSessionCurrent(projectSession)
    ) return
    setArchStatus(status)
    setWordCounts(counts)
    setSynopsisIncomplete(interrupted)
    setSynopsisRecoveryFailed(recoveryFailed && Boolean(status.synopsis))
    setSynopsisCoveredTo(coveredTo)
    setSynopsisTotalChapters(totalChapters)
    setSynopsisCandidate(recoveredSynopsisCandidate)
    setSynopsisHandle(confirmedSynopsisHandle)
    setPlanningRecovery(recoveredPlanning)
    setWorldHandle(confirmedWorldHandle)
    if (!recoveredSynopsisCandidate) setShowSynopsisCandidate(false)
    setWorldBuildingCandidate(recoveredWorldBuildingCandidate)
    if (!recoveredWorldBuildingCandidate) setShowWorldBuildingCandidate(false)
    setLoading(false)
    // ✅ 只依赖 path 字符串，避免 novelConfig 等变化导致 loadStatus 重建
  }, [currentProject, projectKey, projectMatches, rosterSnapshot])

  useEffect(() => {
    const timer = setTimeout(() => { void loadStatus() }, 0)
    return () => clearTimeout(timer)
  }, [latestArchitectureTerminalRunId, loadStatus])

  // 监听 EventBus 事件，刷新后处理状态面板
  useEffect(() => {
    const eventMatchesProjectRun = (payload: {
      projectSession: ProjectSessionContext
      runId: string
    }) =>
      (() => {
        const projectSession = captureProjectSession(currentProject)
        return !!projectSession
          && isProjectSessionCurrent(projectSession)
          && sameProjectSessionContext(projectSession, payload.projectSession)
      })()
      && payload.runId.length > 0
    // 每步架构文件写完后实时刷新状态
    const unsub3 = globalEventBus.on('ARCH_FILE_UPDATED', (payload) => {
      if (!eventMatchesProjectRun(payload)) return
      loadStatus()
      loadCharacterRosterStatus()
    })
    // 整个工作流完成后也刷新一次
    const unsub4 = globalEventBus.on('WORKFLOW_COMPLETE', (payload) => {
      const projectSession = captureProjectSession(currentProject)
      if (!projectSession || !isProjectSessionCurrent(projectSession)) return
      if (!shouldRefreshArchOnWorkflowComplete(
        payload,
        projectSession,
        lastCompletedArchitectureRunRef.current,
      )) return
      lastCompletedArchitectureRunRef.current = payload.runId
      loadStatus()
      loadCharacterRosterStatus()
    })
    return () => { unsub3(); unsub4() }
  }, [currentProject, loadCharacterRosterStatus, loadStatus, projectKey])

  /** 打开单个架构文件（arch-file 类型；若 tab 已存在则刷新磁盘内容） */
  const openArchFile = async (f: typeof ARCH_FILES[number]) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    const filePath = `ai-novel://core/${f.key}`
    const tabId = createProjectArchTabId(projectKey, filePath)
    let content = ''
    try {
      if (f.key === 'characters') {
        const roster = await loadCharacterRosterStatus()
        if (!roster) return
        content = roster.status === 'ready'
          ? roster.renderedMarkdown
          : roster.legacyMarkdown ?? ''
      } else {
        const core = (await ipc.invokeWithProjectSession(
          projectSession,
          'db:project-core-get',
          projectSession.projectPath,
        )) as Record<string, unknown> | null
        content = (core?.[f.key] as string) || ''
      }
    } catch {
      return
    }
    if (!isProjectSessionCurrent(projectSession)) return

    const { useEditorStore } = await import('../../stores/editor-store')
    if (!isProjectSessionCurrent(projectSession)) return
    const store = useEditorStore.getState()
    const existingTab = store.tabs.find(t => t.id === tabId)
    if (existingTab) {
      store.setActiveTab(tabId)
      if (shouldSyncProjectArchTab(existingTab, projectKey)) {
        store.syncTabContent(tabId, content)
        store.markTabSaved(tabId, content)
      }
    } else {
      store.openFile({
        id: tabId,
        name: text(f.labelZh, f.labelEn),
        type: 'arch-file',
        filePath,
        content,
        savedContent: content,
        projectKey,
      })
    }
  }

  /** 确认后启动架构工作流 */
  const handleConfirm = async (
    selectedSteps: ArchStepKey[],
    stepGuidance: Record<string, string>,
    synopsisRange?: { from: number; to: number },
    targetUnits?: number,
  ) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) throw new Error(text('项目会话已切换，未启动架构生成', 'The project session changed, so architecture generation was not started.'))
    if (!isProjectSessionCurrent(projectSession)) throw new Error(text('项目会话已切换，未启动架构生成', 'The project session changed, so architecture generation was not started.'))
    await launchCreativeWorkflow({
      workflow: 'generate_architecture',
      selectedSteps,
      stepGuidance,
      synopsisRange,
      targetUnits,
    }, projectSession)
  }

  /** 从上次输出长度中断的检查点继续生成情节大纲（断点续写当前批） */
  const handleResumeSynopsis = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    if (!isProjectSessionCurrent(projectSession) || synopsisBusy || !synopsisHandle || loading) return
    setSynopsisBusy(true)
    try {
      await launchCreativeWorkflow({
        workflow: 'generate_architecture',
        selectedSteps: ['synopsis'],
        resumeSynopsis: true,
        expectedRecoveryHandle: synopsisHandle,
      }, projectSession)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const { toast } = await import('../ui/Toast')
      toast.error(text(`续写启动失败：${detail}`, `Failed to start the continuation: ${detail}`))
    } finally {
      setSynopsisBusy(false)
    }
  }

  /** 从本项目保存的未完成候选继续生成世界观。 */
  const handleResumeWorldBuilding = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    if (!isProjectSessionCurrent(projectSession) || worldBuildingBusy || !worldBuildingCandidate || !worldHandle || loading) return
    setWorldBuildingBusy(true)
    try {
      await launchCreativeWorkflow({
        workflow: 'generate_architecture',
        selectedSteps: ['worldbuilding'],
        resumeWorldBuilding: true,
        expectedRecoveryHandle: worldHandle,
      }, projectSession)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const { toast } = await import('../ui/Toast')
      toast.error(text(`续写启动失败：${detail}`, `Failed to start the continuation: ${detail}`))
    } finally {
      setWorldBuildingBusy(false)
    }
  }

  const copyCandidate = async (candidate: string) => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches
      || !projectSession
      || !isProjectSessionPath(projectSession, projectKey)
      || !isProjectSessionCurrent(projectSession)
      || !candidate
    ) return
    try {
      await navigator.clipboard.writeText(candidate)
      const { toast } = await import('../ui/Toast')
      toast.success(text('未完成候选已复制', 'Incomplete candidate copied.'))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const { toast } = await import('../ui/Toast')
      toast.error(text(`复制失败：${detail}`, `Copy failed: ${detail}`))
    }
  }

  /** 续批入口：打开生成弹窗并预填下一批范围（从 coveredTo+1 起，默认带本批上限，
   * 上限可在弹窗内调整）。避免一次请求剩余全部章节再次触发超长输出。 */
  const handleContinueOutlineBatch = async () => {
    const projectSession = captureProjectSession(currentProject)
    if (!projectMatches || !projectSession || !isProjectSessionPath(projectSession, projectKey)) return
    if (!isProjectSessionCurrent(projectSession)) return
    const from = synopsisCoveredTo + 1
    if (from > synopsisTotalChapters || synopsisTotalChapters <= 0) return
    setPendingSynopsisRange({
      from,
      to: Math.min(synopsisTotalChapters, from + DEFAULT_PLANNING_ACTION_CHAPTERS - 1),
    })
    setShowArchDialog(true)
  }

  /** 打开普通「AI 生成架构」入口（不携带续批预填）。 */
  const openGenerateDialog = () => {
    setPendingSynopsisRange(null)
    setShowArchDialog(true)
  }

  /** 情节大纲有可编辑的恢复稿时打开它。 */
  const openRecoveryDraft = () => {
    if (!planningRecovery) return
    const session = captureProjectSession(currentProject)
    if (session && isProjectSessionCurrent(session)) openPlanningRecoveryDraft(planningRecovery, projectKey, text('大纲恢复稿', 'Outline recovery draft'))
  }

  const rosterPresentation = getCharacterRosterRepairPresentation(
    rosterSnapshot,
    text,
    rosterRepairError,
  )

  return {
    projectMatches,
    loading,
    archStatus,
    wordCounts,
    planningRecovery,
    synopsis: {
      incomplete: synopsisIncomplete,
      recoveryFailed: synopsisRecoveryFailed,
      coveredTo: synopsisCoveredTo,
      totalChapters: synopsisTotalChapters,
      busy: synopsisBusy,
      candidate: synopsisCandidate,
      candidateShown: showSynopsisCandidate,
      setCandidateShown: setShowSynopsisCandidate,
      handle: synopsisHandle,
    },
    worldBuilding: {
      busy: worldBuildingBusy,
      candidate: worldBuildingCandidate,
      candidateShown: showWorldBuildingCandidate,
      setCandidateShown: setShowWorldBuildingCandidate,
      handle: worldHandle,
    },
    roster: {
      presentation: rosterPresentation,
      canRepair: canExplicitlyRepairCharacterRoster(rosterPresentation),
      repairing: extracting,
      repair: handleRepairCharacterRoster,
      refresh: loadCharacterRosterStatus,
    },
    generateDialog: {
      open: showArchDialog,
      close: () => setShowArchDialog(false),
      synopsisRange: pendingSynopsisRange,
    },
    loadStatus,
    openArchFile,
    handleConfirm,
    handleResumeSynopsis,
    handleResumeWorldBuilding,
    copyCandidate,
    handleContinueOutlineBatch,
    openGenerateDialog,
    openRecoveryDraft,
  }
}

export type ArchitectureOverview = ReturnType<typeof useArchitectureOverview>
