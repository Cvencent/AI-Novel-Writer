import { useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { sameProjectPathKey } from '../../shared/project-session-context'
import { useLocaleStore } from '../../stores/locale-store'
import { navigate } from '../../stores/navigation/navigation-intents'
import { useStageStore } from '../../stores/navigation/stage-store'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { runProgress } from '../../stores/navigation/stage-progress'
import { ProgressRing } from './ProgressRing'

const DONE_VISIBLE_MS = 1800

export default function RunCapsule() {
  const text = useLocaleStore(s => s.text)
  const projectPath = useProjectStore(s => s.currentProject?.path)
  const allRuns = useWorkflowStore(s => s.activeRuns)
  const sheetOpen = useStageStore(s => s.sheet?.kind === 'run')
  const runs = projectPath ? allRuns.filter(run => sameProjectPathKey(run.projectPath, projectPath)) : []
  const [finished, setFinished] = useState(false)
  const hadRuns = useRef(false)

  useEffect(() => {
    if (runs.length > 0) {
      hadRuns.current = true
      return
    }
    if (!hadRuns.current) return
    hadRuns.current = false
    const latest = useWorkflowStore.getState().history[0]
    if (latest?.status !== 'completed') return
    const show = setTimeout(() => setFinished(true), 0)
    const hide = setTimeout(() => setFinished(false), DONE_VISIBLE_MS)
    return () => {
      clearTimeout(show)
      clearTimeout(hide)
    }
  }, [runs.length])

  const toggle = (runId?: string) => {
    if (sheetOpen) useStageStore.setState({ sheet: null })
    else navigate({ kind: 'run', facet: 'output', runId })
  }

  if (runs.length === 0) {
    if (!finished) return null
    return (
      <button type="button" className="stage-capsule" data-tone="ok" aria-expanded={sheetOpen} onClick={() => toggle()}>
        <Check size={14} aria-hidden="true" />
        {text('运行已完成', 'Run complete')}
      </button>
    )
  }

  const waiting = runs.filter(run => run.status === 'waiting').length
  if (runs.length > 1) {
    return (
      <button type="button" className="stage-capsule" aria-expanded={sheetOpen} onClick={() => toggle()}>
        <ProgressRing size={18} stroke={2.5} ratio={runs.reduce((sum, run) => sum + runProgress(run), 0) / runs.length} />
        {waiting > 0
          ? text(`${runs.length} 项运行中 · ${waiting} 项等你确认`, `${runs.length} running · ${waiting} need you`)
          : text(`${runs.length} 项运行中`, `${runs.length} running`)}
      </button>
    )
  }

  const [run] = runs
  const step = run.steps[run.currentStepIndex]
  const percent = Math.round(runProgress(run) * 100)
  return (
    <button type="button" className="stage-capsule" data-tone={waiting ? 'warn' : undefined} aria-expanded={sheetOpen} onClick={() => toggle(run.id)}>
      <ProgressRing size={18} stroke={2.5} ratio={percent / 100} />
      <span className="stage-capsule-label">{waiting ? text(`${run.title} · 等你确认`, `${run.title} · needs you`) : step && !run.title.includes(step.name) ? `${run.title} · ${step.name}` : run.title}</span>
      <b className="stage-capsule-value">{percent}%</b>
    </button>
  )
}
