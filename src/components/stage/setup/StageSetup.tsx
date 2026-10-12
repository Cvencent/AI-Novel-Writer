import { useId, useState, type ReactNode } from 'react'
import { ArrowRight, ChevronUp, LoaderCircle, RotateCcw, Sparkles } from 'lucide-react'
import type { NovelConfig } from '../../../shared/ipc-channels'
import { countDraftUnits } from '../../../shared/draft-units'
import {
  DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD,
  MAX_NARRATIVE_THREAD_DORMANT_THRESHOLD,
  MIN_NARRATIVE_THREAD_DORMANT_THRESHOLD,
  resolveNarrativeThreadDormantThreshold,
} from '../../../shared/narrative-thread'
import { resolveWritingLanguage, type WritingLanguage } from '../../../shared/writing-language'
import { sameProjectPathKey } from '../../../shared/project-session-context'
import type { GeneratableField } from '../../../services/workflows/commands/generate-field.command'
import { useLocaleStore } from '../../../stores/locale-store'
import { navigate } from '../../../stores/navigation/navigation-intents'
import { missingSetup, type SetupField } from '../../../stores/navigation/stage-progress'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { configFieldsToExpand, startConfigGeneration } from '../../dialogs/config-generation'
import { AUDIENCE_EN, GENRE_EN } from '../../editor/novel-config-labels'
import { NOVEL_GENRES, novelConfigSessionKey, useNovelConfigForm } from '../../editor/use-novel-config-form'
import { captureProjectSession } from '../../project-session-gate'
import { Button } from '../../ui/Button'
import { InkDialog } from '../InkDialog'
import ModelMissingNotice from '../ModelMissingNotice'
import { commandLabel } from '../shortcut-keys'
import { useModelMissing } from '../use-model-missing'
import { MORE_FIELDS, ONE_MISSING_HINT, POV_OPTIONS, REQUIRED_NAMES, STRUCTURE_OPTIONS, type MoreField } from './setup-fields'

type Form = ReturnType<typeof useNovelConfigForm>
type Text = (zh: string, en: string) => string
type PanelId = MoreField['id'] | 'advanced'

/** 设定页：一段核心大纲加类型、篇幅、目标读者三项必填即可往下走；其余设定收在「更多设定」与「高级」里。 */
export default function StageSetup({ projectKey }: { projectKey: string }) {
  const currentProject = useProjectStore(s => s.currentProject)
  return <SetupSession key={novelConfigSessionKey(currentProject, projectKey)} projectKey={projectKey} />
}

/** 数字框允许暂时为空，失焦时回退到默认值。 */
function NumberInput({ id, value, fallback, min, label, onChange }: {
  id?: string
  value: number | ''
  fallback: number
  min: number
  label: string
  onChange: (value: number | '') => void
}) {
  return (
    <input
      id={id}
      className="stage-setup-num-input"
      type="number"
      inputMode="numeric"
      min={min}
      aria-label={label}
      value={value}
      onChange={event => onChange(event.target.value === '' ? '' : Number.parseInt(event.target.value, 10))}
      onBlur={() => { if (!(Number(value) >= min)) onChange(fallback) }}
    />
  )
}

function AiButton({ field, label, form, disabled }: { field: GeneratableField; label: string; form: Form; disabled: boolean }) {
  const text = useLocaleStore(s => s.text)
  const busy = form.generatingField === field
  return (
    <Button
      variant="text"
      size="sm"
      className="stage-setup-ai"
      disabled={disabled || form.generatingField !== null}
      aria-label={text(`AI 生成「${label}」`, `Generate “${label}” with AI`)}
      onClick={() => void form.generateField(field)}
    >
      {busy ? <LoaderCircle size={13} className="stage-update-spin" aria-hidden="true" /> : <Sparkles size={13} aria-hidden="true" />}
      {busy ? text('生成中…', 'Generating…') : text('AI 生成', 'Generate')}
    </Button>
  )
}

function RequiredLabel({ htmlFor, id, name, missing }: { htmlFor?: string; id?: string; name: string; missing: boolean }) {
  const text = useLocaleStore(s => s.text)
  return (
    <label className="stage-setup-label" htmlFor={htmlFor} id={id} data-missing={missing || undefined}>
      {name}
      {missing && <span className="stage-setup-required-mark">{text(' · 必填', ' · required')}</span>}
    </label>
  )
}

function chipValue(field: MoreField, config: NovelConfig, text: Text): string {
  if (field.kind === 'pov') {
    const option = POV_OPTIONS.find(([value]) => value === (config.narrativePOV || 'third_limited'))
    return option ? text(...option[1]) : ''
  }
  if (field.kind === 'structure') {
    const option = STRUCTURE_OPTIONS.find(([value]) => value === (config.plotStructure || 'three_act'))
    return option ? text(...option[1]) : ''
  }
  if (field.kind === 'line') return config.subGenre?.trim() ?? ''
  return ''
}

function isFilled(field: MoreField, config: NovelConfig): boolean {
  if (field.kind === 'pov' || field.kind === 'structure') return true
  return Boolean((config[field.id] ?? '').trim())
}

function MorePanel({ field, config, form, aiDisabled, onCollapse }: {
  field: MoreField
  config: NovelConfig
  form: Form
  aiDisabled: boolean
  onCollapse: () => void
}) {
  const text = useLocaleStore(s => s.text)
  const controlId = useId()
  const name = text(...field.name)
  let control: ReactNode
  if (field.kind === 'pov') {
    control = (
      <select id={controlId} className="stage-select" value={config.narrativePOV || 'third_limited'}
        onChange={event => form.update('narrativePOV', event.target.value as NovelConfig['narrativePOV'])}>
        {POV_OPTIONS.map(([value, label]) => <option key={value} value={value}>{text(...label)}</option>)}
      </select>
    )
  } else if (field.kind === 'structure') {
    control = (
      <select id={controlId} className="stage-select" value={config.plotStructure || 'three_act'}
        onChange={event => form.update('plotStructure', event.target.value as NovelConfig['plotStructure'])}>
        {STRUCTURE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{text(...label)}</option>)}
      </select>
    )
  } else if (field.kind === 'line') {
    control = (
      <input id={controlId} className="pi-input" value={config.subGenre ?? ''} placeholder={text(...field.placeholder)}
        onChange={event => form.update('subGenre', event.target.value)} />
    )
  } else {
    control = (
      <textarea id={controlId} className="stage-setup-textarea" value={config[field.id] ?? ''} placeholder={text(...field.placeholder)}
        onChange={event => form.update(field.id, event.target.value)} />
    )
  }
  return (
    <section className="stage-setup-panel" aria-label={name}>
      <div className="stage-setup-panel-head">
        <div>
          <label className="stage-setup-panel-title" htmlFor={controlId}>{name}</label>
          {field.kind === 'text' && <p className="stage-setup-panel-desc">{text(...field.desc)}</p>}
        </div>
        {field.kind === 'text' && field.aiField && <AiButton field={field.aiField} label={name} form={form} disabled={aiDisabled} />}
        <Button variant="icon" size="sm" aria-label={text(`收起「${name}」`, `Collapse “${name}”`)} onClick={onCollapse}>
          <ChevronUp size={15} aria-hidden="true" />
        </Button>
      </div>
      {control}
    </section>
  )
}

function AdvancedPanel({ config, form, onCollapse }: { config: NovelConfig; form: Form; onCollapse: () => void }) {
  const text = useLocaleStore(s => s.text)
  const inputId = useId()
  const threshold = resolveNarrativeThreadDormantThreshold(config.narrativeThreadDormantChapterThreshold)
  return (
    <section className="stage-setup-panel" aria-label={text('高级', 'Advanced')}>
      <div className="stage-setup-panel-head">
        <div>
          <p className="stage-setup-panel-title">{text('高级', 'Advanced')}</p>
          <p className="stage-setup-panel-desc">{text('只影响这部作品。', 'Applies to this book only.')}</p>
        </div>
        <Button variant="icon" size="sm" aria-label={text('收起「高级」', 'Collapse “Advanced”')} onClick={onCollapse}>
          <ChevronUp size={15} aria-hidden="true" />
        </Button>
      </div>
      <div className="stage-setup-adv-row">
        <div>
          <label className="stage-setup-label" htmlFor={inputId}>{text('伏笔沉寂提醒（章）', 'Dormant thread reminder (chapters)')}</label>
          <p className="stage-setup-panel-desc">{text(
            `一条伏笔连续这么多章没有推进，剧情页会提醒你。默认 ${DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD} 章。`,
            `The plot page flags a thread that has not moved for this many chapters. Default ${DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD}.`,
          )}</p>
        </div>
        <div className="stage-setup-adv-ctl">
          <input
            id={inputId}
            className="stage-setup-num-input"
            type="number"
            min={MIN_NARRATIVE_THREAD_DORMANT_THRESHOLD}
            max={MAX_NARRATIVE_THREAD_DORMANT_THRESHOLD}
            value={threshold}
            onChange={event => form.update('narrativeThreadDormantChapterThreshold', resolveNarrativeThreadDormantThreshold(Number(event.target.value)))}
          />
          <Button variant="text" size="sm" disabled={threshold === DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD}
            onClick={() => form.update('narrativeThreadDormantChapterThreshold', DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD)}>
            <RotateCcw size={13} aria-hidden="true" />{text('恢复默认', 'Restore default')}
          </Button>
        </div>
      </div>
    </section>
  )
}

function SetupSession({ projectKey }: { projectKey: string }) {
  const text = useLocaleStore(s => s.text)
  const form = useNovelConfigForm(projectKey)
  const modelMissing = useModelMissing()
  const filling = useWorkflowStore(s => s.activeRuns.some(run => run.type === 'config_generation' && sameProjectPathKey(run.projectPath, projectKey)))
  const [open, setOpen] = useState<ReadonlySet<PanelId>>(() => new Set())
  const [expandFields, setExpandFields] = useState<string[] | null>(null)
  const outlineId = useId()
  const hintId = useId()
  const lengthId = useId()

  const { config } = form
  if (!config) {
    return (
      <div className="stage-setup stage-setup--empty">
        <p className="stage-setup-lede">{form.projectMatches
          ? text('正在读取设定…', 'Loading setup…')
          : text('这个标签属于另一部作品，切回那部作品后再继续。', 'This tab belongs to another book. Switch back to it to continue.')}</p>
      </div>
    )
  }

  const missing = missingSetup(config)
  const isMissing = (field: SetupField) => missing.includes(field)
  const toggle = (id: PanelId) => setOpen(previous => {
    const next = new Set(previous)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const hint = missing.length === 0
    ? text('设定已齐，可以往下走', 'Setup is complete. Ready for the next step.')
    : missing.length === 1
      ? text(...ONE_MISSING_HINT[missing[0]])
      : text(`还差 ${missing.length} 项：${missing.map(field => REQUIRED_NAMES[field][0]).join('、')}`,
        `${missing.length} left: ${missing.map(field => REQUIRED_NAMES[field][1]).join(', ')}`)
  const aiDisabled = modelMissing
  const fillDisabled = modelMissing || filling || !config.coreOutline.trim()

  const startFill = () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session) return
    setExpandFields(null)
    startConfigGeneration({ idea: config.coreOutline, projectSession: session, onGenerated: form.applyGeneratedTo(session) })
  }
  const requestFill = () => {
    const fields = configFieldsToExpand(config, text)
    if (fields.length > 0) setExpandFields(fields)
    else startFill()
  }
  const goNext = async () => {
    if (form.dirty) {
      try {
        await form.save(true)
      } catch {
        return
      }
    }
    navigate({ kind: 'stage', stage: 'architecture' })
  }

  const genre = config.genre
  const audience = config.targetAudience
  return (
    <div className="stage-setup">
      <div className="stage-setup-scroll">
        <div className="stage-setup-inner">
          <header className="stage-setup-head">
            <div className="stage-setup-kicker">
              <span className="stage-setup-numeral" aria-hidden="true">i</span>
              <span className="stage-eyebrow">{text('第一步 · 设定', 'Step one · Setup')}</span>
            </div>
            <h1 className="stage-setup-title">{text('用一两句话，说说这个故事。', 'Tell this story in a sentence or two.')}</h1>
            <p className="stage-setup-lede">{text(
              '只要这一段和下面三项，就能往下走。其余设定可以交给 AI 补全，之后随时能改。',
              'This paragraph and the three fields below are all you need to move on. AI can fill in the rest, and you can change anything later.',
            )}</p>
          </header>

          {modelMissing && <ModelMissingNotice detail={text('AI 补全和单项 AI 生成都要用到它。不用 AI 也可以把设定全部手写完。', 'AI fill and per-field generation need one. You can also write every setting by hand.')} />}

          <section className="stage-setup-outline" data-missing={isMissing('coreOutline') || undefined}>
            <div className="stage-setup-outline-head">
              <RequiredLabel htmlFor={outlineId} name={text('核心大纲', 'Core outline')} missing={isMissing('coreOutline')} />
              <AiButton field="coreOutline" label={text('核心大纲', 'Core outline')} form={form} disabled={aiDisabled} />
            </div>
            <textarea
              id={outlineId}
              className="stage-setup-outline-input"
              value={config.coreOutline}
              placeholder={text('谁，在哪里，想要什么，又被什么挡住了路。', 'Who, where, what they want, and what stands in the way.')}
              onChange={event => form.update('coreOutline', event.target.value)}
            />
            <div className="stage-setup-outline-foot">
              <label className="stage-setup-language">
                {text('写作语言', 'Writing language')}
                <select value={resolveWritingLanguage(config.writingLanguage)} onChange={event => form.update('writingLanguage', event.target.value as WritingLanguage)}>
                  <option value="zh-CN">{text('简体中文', 'Simplified Chinese')}</option>
                  <option value="en-US">English</option>
                </select>
              </label>
              <span className="pi-num-ui">{text(`${countDraftUnits(config.coreOutline)} 字`, `${countDraftUnits(config.coreOutline)} words`)}</span>
            </div>
          </section>

          <div className="stage-setup-required">
            <div className="stage-setup-field">
              <RequiredLabel htmlFor={`${outlineId}-genre`} name={text('类型', 'Genre')} missing={isMissing('genre')} />
              <select id={`${outlineId}-genre`} className="stage-select" data-placeholder={!genre || undefined} value={genre}
                onChange={event => form.update('genre', event.target.value)}>
                <option value="" disabled>{text('请选择', 'Choose')}</option>
                {genre && !NOVEL_GENRES.includes(genre) && <option value={genre}>{genre}</option>}
                {NOVEL_GENRES.map(value => <option key={value} value={value}>{text(value, GENRE_EN[value] ?? value)}</option>)}
              </select>
            </div>
            <div className="stage-setup-field" role="group" aria-labelledby={lengthId}>
              <RequiredLabel id={lengthId} name={text('篇幅', 'Length')} missing={isMissing('length')} />
              <div className="stage-setup-length">
                <NumberInput value={config.totalChapters as number | ''} fallback={100} min={1} label={text('总章数', 'Total chapters')}
                  onChange={value => form.update('totalChapters', value as number)} />
                <span>{text('章 · 每章约', 'chapters, about')}</span>
                <NumberInput value={config.wordsPerChapter as number | ''} fallback={3000} min={100} label={text('每章字数', 'Words per chapter')}
                  onChange={value => form.update('wordsPerChapter', value as number)} />
                <span>{text('字', 'words each')}</span>
              </div>
            </div>
            <div className="stage-setup-field">
              <RequiredLabel htmlFor={`${outlineId}-audience`} name={text('目标读者', 'Target readers')} missing={isMissing('targetAudience')} />
              <select id={`${outlineId}-audience`} className="stage-select" data-placeholder={!audience || undefined} value={audience}
                onChange={event => form.update('targetAudience', event.target.value)}>
                <option value="" disabled>{text('请选择', 'Choose')}</option>
                {audience && !Object.hasOwn(AUDIENCE_EN, audience) && <option value={audience}>{audience}</option>}
                {Object.entries(AUDIENCE_EN).map(([value, labelEn]) => <option key={value} value={value}>{text(value, labelEn)}</option>)}
              </select>
            </div>
          </div>

          <div className="stage-setup-chips" role="group" aria-label={text('更多设定', 'More settings')}>
            <span className="stage-setup-chips-label" aria-hidden="true">{text('更多设定', 'More settings')}</span>
            {MORE_FIELDS.map(field => {
              const value = chipValue(field, config, text)
              return (
                <button key={field.id} type="button" className="stage-chip" aria-expanded={open.has(field.id)}
                  data-filled={isFilled(field, config) || undefined} onClick={() => toggle(field.id)}>
                  {text(...field.name)}{value && <span className="stage-chip-value"> · {value}</span>}
                </button>
              )
            })}
            <button type="button" className="stage-chip" data-dashed aria-expanded={open.has('advanced')} onClick={() => toggle('advanced')}>
              {text('高级', 'Advanced')}
            </button>
          </div>

          {MORE_FIELDS.filter(field => open.has(field.id)).map(field => (
            <MorePanel key={field.id} field={field} config={config} form={form} aiDisabled={aiDisabled} onCollapse={() => toggle(field.id)} />
          ))}
          {open.has('advanced') && <AdvancedPanel config={config} form={form} onCollapse={() => toggle('advanced')} />}
        </div>
      </div>

      <footer className="stage-setup-foot">
        <Button variant="secondary" disabled={fillDisabled} onClick={requestFill}>
          {filling ? <LoaderCircle size={15} className="stage-update-spin" aria-hidden="true" /> : <Sparkles size={15} className="stage-setup-spark" aria-hidden="true" />}
          {filling ? text('AI 正在补全…', 'AI is filling in…') : text('AI 补全其余设定', 'Fill the rest with AI')}
        </Button>
        <span className="stage-setup-hint" id={hintId} data-ready={missing.length === 0 || undefined} role="status">{hint}</span>
        {form.dirty && (
          <Button variant="text" disabled={form.saving} onClick={() => void form.save()}>
            {form.saving ? text('正在保存…', 'Saving…') : text('保存', 'Save')}<kbd>{commandLabel('s')}</kbd>
          </Button>
        )}
        <Button variant="primary" disabled={missing.length > 0 || form.saving} aria-describedby={hintId} onClick={() => void goNext()}>
          {text('下一步：故事架构', 'Next: story architecture')}
          <ArrowRight size={15} aria-hidden="true" />
        </Button>
      </footer>

      <InkDialog
        open={expandFields !== null}
        onOpenChange={next => { if (!next) setExpandFields(null) }}
        title={text('扩写已有的设定？', 'Expand what you have written?')}
        description={text('下面这些已经有你写的内容。AI 会保留原文，只在后面补充：', 'These already have your writing. AI keeps it and only adds to it:')}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setExpandFields(null)}>{text('取消', 'Cancel')}</Button>
            <Button variant="primary" onClick={startFill}>{text('继续扩写', 'Expand')}</Button>
          </>
        )}
      >
        <ul className="stage-setup-expand-list">
          {expandFields?.map(field => <li key={field}>{field}</li>)}
        </ul>
      </InkDialog>
    </div>
  )
}
