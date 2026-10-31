import { useCallback, useEffect, useState } from 'react'
import { useProjectStore } from '../../stores/project-store'
import { readPostProcessStatus, type PostProcessStatus } from '../../services/workflows/workflow-utils'
import { globalEventBus } from '../../shared/event-bus'
import { sameProjectSessionContext } from '../../shared/project-session-context'
import { captureProjectSession, isProjectSessionCurrent } from '../project-session-gate'

export type StepPresentation = 'success' | 'pending' | 'failed'

/** 这条运行被中断了：创建后从未推进过任何账目（updated=created）、没跑完，
 *  且已过去足够久——后处理是进程内工作流，重启后不可能还在跑，而它也不会自己恢复。
 *  把这种形态从「处理中」里救出来标成失败，作者才有「重试」入口（issue #8）。 */
export function isRunInterrupted(run: Pick<PostProcessStatus, 'createdAt' | 'updatedAt' | 'allCriticalPassed'>, now = Date.now()): boolean {
  if (run.allCriticalPassed) return false
  if (run.updatedAt !== run.createdAt) return false
  const created = new Date(run.createdAt).getTime()
  if (!Number.isFinite(created)) return false
  return now - created > INTERRUPTED_RUN_GRACE_MS
}

const INTERRUPTED_RUN_GRACE_MS = 2 * 60_000

/**
 * A fresh post-process run persists every step before it attempts any of them.
 * The database default is `ok = false`, so distinguish that pending shape from
 * a failed attempt by requiring durable failure evidence. A stale never-advanced
 * run (app killed mid-run) is reported as interrupted instead of spinning on
 * 「处理中」forever.
 */
export function getStepPresentation(step: PostProcessStatus['steps'][string], runInterrupted = false): StepPresentation {
  if (step.ok) return 'success'

  const hasFailureEvidence = Number(step.attemptCount) > 0
    || Boolean(step.error?.trim())
    || Boolean(step.lastAttemptAt?.trim())
    || Boolean(step.completedAt?.trim())

  return hasFailureEvidence || runInterrupted ? 'failed' : 'pending'
}

/**
 * 读一个后处理 scope 的最新一次运行，定稿完成或任一工作流结束时重读。
 * 定稿视图的后处理步骤用它。
 */
export function usePostProcessStatus(scope: string) {
  const [status, setStatus] = useState<PostProcessStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const project = useProjectStore(s => s.currentProject)

  const loadStatus = useCallback(async () => {
    const projectSession = captureProjectSession(project)
    if (!projectSession) return
    const s = await readPostProcessStatus(projectSession.projectPath, scope, projectSession)
    if (!isProjectSessionCurrent(projectSession)) return
    setStatus(s)
    setLoading(false)
  }, [project, scope])

  useEffect(() => {
    let mounted = true
    const init = async () => {
      const projectSession = captureProjectSession(project)
      if (!projectSession) return
      setLoading(true)
      const s = await readPostProcessStatus(projectSession.projectPath, scope, projectSession)
      if (mounted && isProjectSessionCurrent(projectSession)) {
        setStatus(s)
        setLoading(false)
      }
    }
    init()
    return () => { mounted = false }
  }, [project, scope])

  useEffect(() => {
    const matchesCurrentProject = (eventSession: Parameters<typeof sameProjectSessionContext>[0]) => {
      const projectSession = captureProjectSession(project)
      return !!projectSession && sameProjectSessionContext(projectSession, eventSession)
    }
    const unsub1 = globalEventBus.on('FINALIZE_COMPLETE', ({ projectSession }) => {
      if (matchesCurrentProject(projectSession)) void loadStatus()
    })
    const unsub2 = globalEventBus.on('WORKFLOW_COMPLETE', ({ projectSession }) => {
      if (matchesCurrentProject(projectSession)) void loadStatus()
    })
    return () => { unsub1(); unsub2() }
  }, [loadStatus, project])

  const steps = status
    ? Object.entries(status.steps).map(([key, step]) => ({ key, step, presentation: getStepPresentation(step, isRunInterrupted(status)) }))
    : []
  return { status, loading, steps, runInterrupted: status ? isRunInterrupted(status) : false }
}
