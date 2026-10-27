import { useCallback, useEffect, useState } from 'react'
import { Plus, Sparkles, Trash2 } from 'lucide-react'
import { createScenePlanWorkflow } from '../../../services/workflows/writing-intelligence-workflow'
import { ipc } from '../../../services/ipc-client'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'
import { navigate } from '../../../stores/navigation/navigation-intents'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { globalEventBus } from '../../../shared/event-bus'
import { sameProjectSessionContext } from '../../../shared/project-session-context'
import type { SceneCard } from '../../../shared/writing-intelligence'
import { normalizeChapterWordsTarget } from '../../../services/workflows/chapter-creation-parameters'
import { Button } from '../../ui/Button'
import { toast } from '../../ui/Toast'

export default function SceneCardEditor({ chapterNumber, characters, disabled }: {
  chapterNumber: number
  characters: readonly string[]
  disabled?: boolean
}) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const project = useProjectStore(s => s.currentProject)
  const [scenes, setScenes] = useState<SceneCard[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    await Promise.resolve()
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session) { setScenes([]); setLoading(false); return }
    try {
      const loaded = await ipc.invokeWithProjectSession(session, 'db:writing-intelligence-scenes-get', chapterNumber, session.projectPath)
      if (isProjectSessionCurrent(session)) setScenes(loaded)
    } catch {
      if (isProjectSessionCurrent(session)) setScenes([])
    } finally {
      if (isProjectSessionCurrent(session)) setLoading(false)
    }
  }, [chapterNumber])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- Hydrate scene cards from project-scoped IPC.
  useEffect(() => { void load() }, [load])
  useEffect(() => globalEventBus.on('WORKFLOW_COMPLETE', ({ projectSession }) => {
    const current = captureProjectSession(useProjectStore.getState().currentProject)
    if (current && sameProjectSessionContext(projectSession, current)) void load()
  }), [load])

  const update = (id: string, patch: Partial<SceneCard>) => setScenes(current => current.map(scene => scene.id === id ? { ...scene, ...patch } : scene))
  const add = () => setScenes(current => [...current, {
    id: `scene-${Date.now()}`, title: text('新场景', 'New scene'), goal: '', conflict: '', turn: '', outcome: '',
    characters: [...characters].slice(0, 2), targetWords: null, notes: '',
  }])
  const remove = (id: string) => setScenes(current => current.filter(scene => scene.id !== id))

  const save = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || disabled || saving) return
    setSaving(true)
    try {
      const saved = await ipc.invokeWithProjectSession(session, 'db:writing-intelligence-scenes-save', chapterNumber, scenes, session.projectPath)
      if (!isProjectSessionCurrent(session)) return
      setScenes(saved)
      toast.success(text('场景卡已保存', 'Scene cards saved'))
    } catch (error) {
      if (isProjectSessionCurrent(session)) toast.error(text(`场景卡保存失败：${String(error)}`, `Could not save scene cards: ${String(error)}`))
    } finally {
      if (isProjectSessionCurrent(session)) setSaving(false)
    }
  }

  const generate = () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || disabled) return
    const workflow = createScenePlanWorkflow({
      projectPath: session.projectPath, projectSession: session, chapterNumber,
      targetWords: normalizeChapterWordsTarget(project?.novelConfig.wordsPerChapter), locale,
    })
    void useWorkflowStore.getState().startWorkflow(workflow)
    navigate({ kind: 'run', facet: 'tasks' })
  }
  return (
    <details className="stage-bp-scenes" open={scenes.length > 0 || undefined}>
      <summary>{text('场景卡', 'Scene cards')}<small>{text('目标 → 阻力 → 转折 → 结果', 'Goal → resistance → turn → outcome')}</small></summary>
      <div className="stage-bp-scene-actions">
        <Button variant="secondary" size="sm" disabled={disabled || saving} onClick={generate}><Sparkles size={13} aria-hidden />{text('AI 拆场景', 'AI scene cards')}</Button>
        <Button variant="text" size="sm" disabled={disabled || saving} onClick={add}><Plus size={13} aria-hidden />{text('添加', 'Add')}</Button>
        <Button variant="secondary" size="sm" disabled={disabled || saving || loading} onClick={() => void save()}>{saving ? text('保存中…', 'Saving…') : text('保存场景卡', 'Save scene cards')}</Button>
      </div>
      {loading && <p className="stage-ch-hint">{text('正在读取场景卡…', 'Loading scene cards…')}</p>}
      {!loading && scenes.length === 0 && <p className="stage-ch-hint">{text('还没有场景卡。可以手动添加，或让 AI 按蓝图拆分。', 'No scene cards yet. Add them manually or let AI split the blueprint.')}</p>}
      <ol className="stage-bp-scene-list">
        {scenes.map((scene, index) => (
          <li key={scene.id} className="stage-bp-scene-card">
            <div className="stage-bp-scene-head">
              <span>{index + 1}</span>
              <input className="pi-input" value={scene.title} disabled={disabled} aria-label={text('场景标题', 'Scene title')} onChange={event => update(scene.id, { title: event.target.value })} />
              <Button variant="icon" size="sm" disabled={disabled} aria-label={text('删除场景', 'Delete scene')} onClick={() => remove(scene.id)}><Trash2 size={13} aria-hidden /></Button>
            </div>
            <div className="stage-bp-scene-grid">
              {([
                ['goal', text('目标', 'Goal')], ['conflict', text('阻力', 'Conflict')], ['turn', text('转折', 'Turn')], ['outcome', text('结果', 'Outcome')],
              ] as const).map(([field, label]) => (
                <label key={field} className="pi-field"><span>{label}</span><textarea rows={2} className="pi-input stage-ch-textarea" value={scene[field]} disabled={disabled} onChange={event => update(scene.id, { [field]: event.target.value })} /></label>
              ))}
            </div>
            <div className="stage-bp-scene-foot">
              <label className="pi-field"><span>{text('目标字数', 'Target words')}</span><input type="number" min={0} className="pi-input" value={scene.targetWords ?? ''} disabled={disabled} onChange={event => update(scene.id, { targetWords: event.target.value === '' ? null : Math.max(0, Number(event.target.value)) })} /></label>
              <label className="pi-field"><span>{text('备注', 'Notes')}</span><input className="pi-input" value={scene.notes} disabled={disabled} onChange={event => update(scene.id, { notes: event.target.value })} /></label>
            </div>
          </li>
        ))}
      </ol>
    </details>
  )
}