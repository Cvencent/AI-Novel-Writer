import { useEffect, useId, useState } from 'react'
import { ChevronRight, PenLine } from 'lucide-react'
import type { ConsistencyPreflightResult } from '../../../services/consistency-preflight'
import { ipc } from '../../../services/ipc-client'
import {
  chapterDefaultWordsTarget,
  chapterWriteFormFromPrefill,
  generationModelError,
  isGenerationModel,
  launchChapterWrite,
} from '../../../services/workflows/chapter-write-launch'
import { preferredFunctionModelId } from '../../../shared/function-models'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import type { ChapterWritePrefill } from '../../../stores/layout-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useStageStore } from '../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../stores/project-store'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'
import { navigate } from '../../../stores/navigation/navigation-intents'
import { useAnchoredLayer } from '../../ui/use-anchored-layer'
import { Button } from '../../ui/Button'
import SplitAction from './SplitAction'
import WritePreflight from './WritePreflight'

interface WriteChapterPopoverProps {
  chapterNumber: number
  /** 这一章的蓝图，按旧蓝图页「写作此章」的同一组字段（出场人物以顿号连接）。 */
  blueprint: ChapterWritePrefill
  /** 主按钮文字：蓝图页是「写第 N 章」，单章视图是「写作此章」。 */
  label: string
  /** 弹层与按钮哪边对齐：蓝图页按钮在右侧，弹层向左展开（end）；单章视图按钮在左侧，向右展开（start）。 */
  align?: 'start' | 'end'
}

/**
 * 写作此章：拆分主按钮加一个小弹层。主按钮直接按蓝图开始写；箭头打开弹层，只能改本次模型、作者微操指导和收在「更多」里的检索关键词。
 * 其余参数都取自蓝图，经 launchChapterWrite 启动。一致性预检有提醒、或前置条件不满足时，弹层自己打开说明原因。
 */
export default function WriteChapterPopover({ chapterNumber, blueprint, label, align = 'end' }: WriteChapterPopoverProps) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const models = useLLMStore(s => s.models)
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  const functionModels = useLLMStore(s => s.functionModels)
  const writeRequest = useStageStore(s => s.writeRequest)
  const layer = useAnchoredLayer(align)
  const { open, show, close } = layer
  const [modelId, setModelId] = useState<string | null>(null)
  const [guidance, setGuidance] = useState<string | null>(null)
  const [knowledgeHint, setKnowledgeHint] = useState('')
  const [preflight, setPreflight] = useState<ConsistencyPreflightResult | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  // 守卫阻断时要修的是哪一章（issue #55）：主按钮据此变成「去修复定稿」，
  // 否则弹层里一个按钮都没有，作者只能照脚注反复点同一个必然被拒绝的按钮。
  const [repairChapter, setRepairChapter] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [starting, setStarting] = useState(false)
  const modelFieldId = useId()
  const guidanceFieldId = useId()
  const hintFieldId = useId()

  const generationModels = models.filter(isGenerationModel)
  const selectedModelId = modelId ?? preferredFunctionModelId(models, functionModels, 'draft_generation', defaultModelId)
  const modelError = generationModelError(models, selectedModelId, text)
  const userGuidance = guidance ?? blueprint.userGuidance

  useEffect(() => {
    if (writeRequest?.chapterNumber !== chapterNumber) return
    useStageStore.setState({ writeRequest: null })
    show()
  }, [writeRequest, chapterNumber, show])

  // 与旧对话框一样，打开时列出已保存的一致性安排，作者可以在这里撤销。
  useEffect(() => {
    if (!open) return
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session) return
    void ipc.invokeWithProjectSession(session, 'db:consistency-exemption-list', session.projectPath).then(exemptions => {
      if (isProjectSessionCurrent(session) && exemptions.some(item => !item.revoked)) {
        setPreflight(current => current ?? { findings: [], exemptions, acknowledgements: [], castNames: [] })
      }
    }).catch(() => undefined)
  }, [open])

  /** expected 是发起时的那次打开：保存安排后接着开写时，作品已换就不写，蓝图与章号属于原来那部。 */
  const start = async (ignoreFindingsOnce: boolean, expected?: ProjectSessionContext) => {
    const project = useProjectStore.getState().currentProject
    const session = captureProjectSession(project)
    if (!session || busy || (expected && !isProjectSessionCurrent(expected))) return
    setBusy(true)
    setStarting(true)
    try {
      const wordsPerChapter = project?.novelConfig.wordsPerChapter
      const form = chapterWriteFormFromPrefill({ ...blueprint, userGuidance, chapterNumber }, chapterDefaultWordsTarget(wordsPerChapter))
      const outcome = await launchChapterWrite({
        session,
        form: { ...form, knowledgeHint },
        generationModelId: selectedModelId,
        wordsPerChapter,
        ignoreFindingsOnce,
        locale,
      })
      switch (outcome.kind) {
        case 'stale':
          return
        case 'started':
          // 这些选项只用于本次写作；写完后再打开弹层，回到蓝图里的指导与默认模型。
          setModelId(null)
          setGuidance(null)
          setKnowledgeHint('')
          setPreflight(null)
          setMessage(null)
          setRepairChapter(null)
          close(false)
          return
        case 'preflight':
          setMessage(null)
          setRepairChapter(null)
          setPreflight(outcome.preflight)
          show()
          return
        default: {
          // authority-error 与 blocked 都走这里，但只有 blocked 可能带「该修哪一章」。
          const blocked = outcome.kind === 'blocked' ? outcome : null
          setMessage(outcome.message)
          setRepairChapter(blocked?.action === 'repair-finalize' ? blocked.chapterNumber ?? null : null)
          show()
          return
        }
      }
    } finally {
      setBusy(false)
      setStarting(false)
    }
  }

  /** 保存或撤销一致性安排：进行中按钮不可再点，失败时在弹层里写明原因。成功时返回发起时的会话。 */
  const changeArrangement = async (failure: string, call: (session: ProjectSessionContext) => Promise<{ success: boolean; error?: string }>) => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || busy) return null
    setBusy(true)
    setMessage(null)
    try {
      const result = await call(session)
      if (!result.success) throw new Error(result.error || failure)
      return session
    } catch (error) {
      if (isProjectSessionCurrent(session)) setMessage(error instanceof Error ? error.message : String(error))
      return null
    } finally {
      setBusy(false)
    }
  }

  const saveArrangement = async (stableFactKey: string, reason: string) => {
    const saved = await changeArrangement(text('保存一致性安排失败', 'Could not save the consistency arrangement.'),
      session => ipc.invokeWithProjectSession(session, 'db:consistency-exemption-save', stableFactKey, reason, session.projectPath))
    if (saved) await start(false, saved)
  }

  const revokeArrangement = async (stableFactKey: string) => {
    const revoked = await changeArrangement(text('撤销一致性安排失败', 'Could not revoke the consistency arrangement.'),
      session => ipc.invokeWithProjectSession(session, 'db:consistency-exemption-revoke', stableFactKey, session.projectPath))
    if (!revoked) return
    setPreflight(current => current ? {
      ...current,
      exemptions: current.exemptions.map(item => item.stableFactKey === stableFactKey ? { ...item, revoked: true } : item),
    } : null)
  }

  /**
   * 「我已知，稍后处理」（issue #79）：与「保存安排」分开，不落 `consistency_exemptions`。
   * stable_fact_key 跨章稳定，所以 ack 一次就永久静音——这正是作者此前缺的第三个口径。
   * ack 后接着开写（与 saveArrangement 同一路径），作者不必再多点一次。
   */
  const acknowledgeFinding = async (stableFactKey: string) => {
    const done = await changeArrangement(text('标记稍后处理失败', 'Could not note it for later.'),
      session => ipc.invokeWithProjectSession(session, 'db:consistency-ack-save', stableFactKey, session.projectPath))
    if (done) await start(false, done)
  }

  const unacknowledgeFinding = async (stableFactKey: string) => {
    const done = await changeArrangement(text('恢复该提醒失败', 'Could not show this reminder again.'),
      session => ipc.invokeWithProjectSession(session, 'db:consistency-ack-revoke', stableFactKey, session.projectPath))
    if (!done) return
    setPreflight(current => current ? {
      ...current,
      acknowledgements: current.acknowledgements.filter(item => item.stableFactKey !== stableFactKey),
    } : null)
  }

  const showPreflight = preflight && (preflight.findings.length > 0 || preflight.exemptions.some(item => !item.revoked))
  // 预检提醒已经展示过一次后，主按钮再点就是「带提醒开写」：预检只是证据提示，
  // 不该让作者在同一个按钮上反复弹层（弹层页脚明明写着「点『写第 N 章』开始」）。
  const preflightSeen = !!preflight && preflight.findings.length > 0

  return (
    <SplitAction
      layer={layer}
      label={label}
      icon={<PenLine size={15} aria-hidden />}
      disabled={busy}
      busy={starting}
      onRun={() => void start(preflightSeen)}
      optionsLabel={text('本次写作选项', 'Options for this run')}
      popoverClassName="stage-write-pop"
    >
      <div className="pi-field">
        <label htmlFor={modelFieldId}>{text('本次模型', 'Model for this run')} <em>{text('只用于这一次', 'This run only')}</em></label>
        <select
          id={modelFieldId}
          className="pi-input"
          value={selectedModelId ?? ''}
          disabled={generationModels.length === 0}
          onChange={event => { setModelId(event.target.value || null); setMessage(null) }}
        >
          <option value="" disabled>{text('请选择可用生成模型', 'Select a generation model')}</option>
          {generationModels.map(model => (
            <option key={model.id} value={model.id}>
              {model.name || model.modelName}{model.id === defaultModelId ? text('（默认）', ' (default)') : ''}
            </option>
          ))}
        </select>
        {modelError && <p className="stage-write-error" role="alert">{modelError}</p>}
      </div>
      <div className="pi-field">
        <label htmlFor={guidanceFieldId}>{text('作者微操指导', 'Author guidance')} <em>{text('可选', 'Optional')}</em></label>
        <textarea
          id={guidanceFieldId}
          className="pi-input stage-write-textarea"
          rows={3}
          value={userGuidance}
          placeholder={text('比如：开头只写声音；结尾停在回头之前。', 'For example: open on sound only; end just before they turn around.')}
          onChange={event => setGuidance(event.target.value)}
        />
      </div>
      <details className="stage-write-more">
        <summary>
          <ChevronRight size={14} aria-hidden />
          {text('更多', 'More')}
          <small>{text('知识库检索关键词', 'Knowledge search terms')}</small>
        </summary>
        <div className="pi-field">
          <label htmlFor={hintFieldId}>{text('知识库检索关键词', 'Knowledge search terms')} <em>{text('可选', 'Optional')}</em></label>
          <input
            id={hintFieldId}
            className="pi-input"
            value={knowledgeHint}
            placeholder={text('如：剑法传承、草原地貌', 'e.g. sword inheritance, grassland terrain')}
            onChange={event => setKnowledgeHint(event.target.value)}
          />
        </div>
      </details>
      {showPreflight && (
        <WritePreflight
          preflight={preflight}
          busy={busy}
          onIgnoreOnce={() => void start(true)}
          onRerun={() => void start(false)}
          onSave={(key, reason) => void saveArrangement(key, reason)}
          onRevoke={key => void revokeArrangement(key)}
          onAcknowledge={key => void acknowledgeFinding(key)}
          onUnacknowledge={key => void unacknowledgeFinding(key)}
        />
      )}
      {message && <p className="stage-write-error" role="alert">{message}</p>}
      {repairChapter !== null && (
        <div className="stage-write-actions">
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={() => {
              // 去那一章的单章视图：定稿后处理面板与「修复定稿 / 重试失败步骤」都在那里
              // （ChapterActions → PostProcessSteps）。这里只导航，不替作者决定要不要修。
              close(false)
              navigate({ kind: 'chapter', chapterNumber: repairChapter })
            }}
          >
            {text(`去修复第 ${repairChapter} 章的定稿后处理`, `Fix Chapter ${repairChapter} finalization`)}
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => close(false)}>
            {text('留在蓝图', 'Stay on blueprints')}
          </Button>
        </div>
      )}
      <p className="stage-write-foot">{repairChapter !== null
        // 脚注不能承诺一个必然被拒绝的动作（issue #55）：正文让作者去修后处理，
        // 这里却写「点它开始」——按脚注做就会回到同一个阻断，被读成「点了没反应」。
        ? text(`这一步要先补完第 ${repairChapter} 章的定稿后处理才能继续写；补完后再点「${label}」。`, `Finish Chapter ${repairChapter} finalization post-processing before drafting; then choose “${label}” again.`)
        : preflightSeen
          ? text(`这些选项只用于本次写作。再点「${label}」将带提醒开始写；也可以在下方保存安排。`, `These options apply to this run only. Click “${label}” again to start with reminders, or save an arrangement below.`)
          : text(`这些选项只用于本次写作，点「${label}」开始。`, `These options apply to this run only. Choose “${label}” to start.`)}</p>
    </SplitAction>
  )
}

