import { useEffect, useMemo, useRef } from 'react'
import { checkArchStatus } from '../../services/architecture-service'
import { ipc } from '../../services/ipc-client'
import { globalEventBus } from '../../shared/event-bus'
import { sameProjectPathKey, sameProjectSessionContext } from '../../shared/project-session-context'
import { useDraftStore } from '../../stores/draft-store'
import { useEditorStore } from '../../stores/editor-store'
import { useLocaleStore } from '../../stores/locale-store'
import {
  deriveChapters, deriveStages, landingStage, locate, missingSetup, runningChapters,
  type ChapterRow, type StageLocation, type StageStatus,
} from '../../stores/navigation/stage-progress'
import { useStageStore } from '../../stores/navigation/stage-store'
import { navigate } from '../../stores/navigation/navigation-intents'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { captureProjectSession, isProjectSessionCurrent } from '../project-session-gate'
import { toast } from '../ui/Toast'

let refreshSequence = 0

/** 读一次流程脊需要而 project-store、draft-store 里没有的数据：架构四节是否已生成、蓝图章号与标题；草稿顺带刷新。 */
export async function refreshStageWork(text: (zh: string, en: string) => string): Promise<void> {
  const session = captureProjectSession(useProjectStore.getState().currentProject)
  const request = ++refreshSequence
  if (!session) {
    useStageStore.setState({ work: null })
    return
  }
  try {
    const [architecture, blueprints] = await Promise.all([
      checkArchStatus(session),
      ipc.invokeWithProjectSession(session, 'db:blueprint-get-all', session.projectPath),
      useDraftStore.getState().loadAllDrafts(session.projectPath, session),
    ])
    if (request !== refreshSequence || !isProjectSessionCurrent(session)) return
    useStageStore.setState({ work: {
      projectKey: session.projectPath,
      architecture,
      blueprints: blueprints.map(({ chapterNumber, title }) => ({ chapterNumber, title })),
    } })
  } catch (error) {
    if (request === refreshSequence && isProjectSessionCurrent(session)) {
      toast.error(text(`项目资源刷新失败：${String(error)}`, `Could not refresh project resources: ${String(error)}`))
    }
  }
}

/** 与项目树相同的刷新时机：换项目、架构或资源变化、工作流步骤推进；连续触发合并成一次。 */
export function useStageWorkRefresh(): void {
  const projectPath = useProjectStore(s => s.currentProject?.path)
  const epoch = useProjectStore(s => s.projectSessionEpoch)
  const workflowKey = useWorkflowStore(s => s.activeRuns
    .map(run => `${run.id}:${run.status}|${run.steps.map(step => step.status).join(',')}`).join(';'))
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const schedule = useRef(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      void refreshStageWork(useLocaleStore.getState().text)
    }, 80)
  })

  useEffect(() => {
    void refreshStageWork(useLocaleStore.getState().text)
  }, [projectPath, epoch])

  useEffect(() => {
    if (projectPath) schedule.current()
  }, [workflowKey, projectPath])

  useEffect(() => {
    const onChange = ({ projectSession }: { projectSession: Parameters<typeof isProjectSessionCurrent>[0] }) => {
      if (isProjectSessionCurrent(projectSession)) schedule.current()
    }
    const offArch = globalEventBus.on('ARCH_FILE_UPDATED', onChange)
    const offResource = globalEventBus.on('REFRESH_RESOURCE', onChange)
    return () => {
      offArch()
      offResource()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])
}

export interface StageView {
  stages: StageStatus[]
  chapters: ChapterRow[]
  location: StageLocation | null
  /** 流程脊数据已按当前项目载入。 */
  ready: boolean
}

export function useStageView(): StageView {
  const project = useProjectStore(s => s.currentProject)
  const work = useStageStore(s => s.work)
  const draftsByChapter = useDraftStore(s => s.draftsByChapter)
  const draftSession = useDraftStore(s => s.dataProjectSession)
  const activeRuns = useWorkflowStore(s => s.activeRuns)
  const activeTab = useEditorStore(s => s.tabs.find(tab => tab.id === s.activeTabId))
  const session = captureProjectSession(project)

  const ready = Boolean(project && work?.projectKey === project.path)
  const drafts = session && sameProjectSessionContext(draftSession, session) ? draftsByChapter : null
  const running = useMemo(() => runningChapters(project
    ? activeRuns.filter(run => sameProjectPathKey(run.projectPath, project.path))
    : []), [activeRuns, project])

  const stages = useMemo(() => project && ready && work
    ? deriveStages({ config: project.novelConfig, architecture: work.architecture, blueprints: work.blueprints, drafts: drafts ?? {}, runningChapters: running })
    : [], [project, ready, work, drafts, running])
  const chapters = useMemo(() => ready && work
    ? deriveChapters({ blueprints: work.blueprints, drafts: drafts ?? {}, runningChapters: running })
    : [], [ready, work, drafts, running])
  const location = project && activeTab?.projectKey === project.path ? locate(activeTab) : null
  return { stages, chapters, location, ready }
}

/**
 * 打开作品时把内容区放到下一步：设定没填完就停在设定，否则等流程脊数据到了再落到第一个未完成的阶段。
 * 这部作品已有打开的标签时保持原样（例如从旧外壳切过来）。
 */
export function useLandingPage(view: StageView): void {
  const project = useProjectStore(s => s.currentProject)
  const landed = useRef<string | null>(null)
  useEffect(() => {
    const key = project?.path
    if (!project || !key || landed.current === key) return
    if (useEditorStore.getState().tabs.some(tab => tab.projectKey === key)) {
      landed.current = key
      return
    }
    if (missingSetup(project.novelConfig).length > 0) {
      landed.current = key
      navigate({ kind: 'stage', stage: 'setup' })
      return
    }
    if (!view.ready) return
    landed.current = key
    navigate({ kind: 'stage', stage: landingStage(view.stages) })
  }, [project, view.ready, view.stages])
}
