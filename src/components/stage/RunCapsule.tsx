import { useEffect, useMemo, useState } from 'react'
import { Check } from 'lucide-react'
import { useLocaleStore } from '../../stores/locale-store'
import { navigate } from '../../stores/navigation/navigation-intents'
import { useStageStore } from '../../stores/navigation/stage-store'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore, projectRunCapsule, runCapsuleKey } from '../../stores/workflow-store'
import { ProgressRing } from './ProgressRing'

const DONE_VISIBLE_MS = 1800

/**
 * 顶栏运行胶囊：这部作品有运行时显示进度；没有运行时，若这部作品最近一次结束的运行是完成、且结束不到 1.8 秒，显示「运行已完成」。
 * 完成态由这次运行的结束时间推出，接着又有运行、运行失败或换了作品时自然不再显示。
 */
export default function RunCapsule() {
  const text = useLocaleStore(s => s.text)
  const projectPath = useProjectStore(s => s.currentProject?.path)
  // issue #104 ③：只订阅**参与渲染字段拼成的字符串 Key**，不再订阅整个 `activeRuns`
  // ——生成期间流式文本每 100ms 换一次 `step.result`，选整个数组会让常驻顶栏以 10Hz 重渲染。
  // Key 变了才重算投影（`getState()` 是同一份 store 的最新值）。
  const summaryKey = useWorkflowStore(s => runCapsuleKey(s.activeRuns, s.history, projectPath))
  const summary = useMemo(() => {
    const state = useWorkflowStore.getState()
    return projectRunCapsule(state.activeRuns, state.history, projectPath)
  }, [summaryKey, projectPath])
  const sheetOpen = useStageStore(s => s.sheet?.kind === 'run')

  const toggle = (runId?: string) => {
    if (sheetOpen) useStageStore.setState({ sheet: null })
    else navigate({ kind: 'run', facet: 'output', runId })
  }

  const doneUntil = summary.endedCompletedAt ? summary.endedCompletedAt + DONE_VISIBLE_MS : 0
  if (summary.count === 0) {
    return doneUntil ? <DoneCapsule key={doneUntil} until={doneUntil} expanded={sheetOpen} onToggle={() => toggle()} /> : null
  }

  const waiting = summary.waiting
  if (summary.count > 1) {
    return (
      <button type="button" className="stage-capsule" aria-expanded={sheetOpen} onClick={() => toggle()}>
        <ProgressRing size={18} stroke={2} ratio={summary.percent / 100} />
        {waiting > 0
          ? text(`${summary.count} 项运行中 · ${waiting} 项等你确认`, `${summary.count} running · ${waiting} need you`)
          : text(`${summary.count} 项运行中`, `${summary.count} running`)}
      </button>
    )
  }

  return (
    <button type="button" className="stage-capsule" data-tone={waiting ? 'warn' : undefined} aria-expanded={sheetOpen} onClick={() => toggle(summary.runId)}>
      <ProgressRing size={18} stroke={2} ratio={summary.percent / 100} />
      <span className="stage-capsule-label">{waiting
        ? text(`${summary.title} · 等你确认`, `${summary.title} · needs you`)
        : summary.stepName && !summary.title.includes(summary.stepName) ? `${summary.title} · ${summary.stepName}` : summary.title}</span>
      <b className="stage-capsule-value">{summary.percent}%</b>
    </button>
  )
}

/** 按 until 重新挂载：挂载时已过期（这条完成运行进入历史时就晚了）直接不显示，否则到点收起。 */
function DoneCapsule({ until, expanded, onToggle }: { until: number; expanded: boolean; onToggle: () => void }) {
  const text = useLocaleStore(s => s.text)
  const [visible, setVisible] = useState(() => until > Date.now())

  useEffect(() => {
    if (!visible) return
    const timer = setTimeout(() => setVisible(false), until - Date.now())
    return () => clearTimeout(timer)
  }, [until, visible])

  if (!visible) return null
  return (
    <button type="button" className="stage-capsule" data-tone="ok" aria-expanded={expanded} onClick={onToggle}>
      <Check size={14} aria-hidden="true" />
      {text('运行已完成', 'Run complete')}
    </button>
  )
}
