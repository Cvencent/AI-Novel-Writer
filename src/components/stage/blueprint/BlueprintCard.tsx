import { useId, useState, type KeyboardEvent } from 'react'
import { MoreHorizontal, X } from 'lucide-react'
import type { ChapterBlueprint } from '../../../services/workflows/directory-workflow'
import { chapterRoleOptions, chapterRoleSelectValue } from '../../../shared/chapter-role'
import { BLUEPRINT_CLOSING_SHOT_TYPES, blueprintLabelKind, joinBlueprintLabels, splitBlueprintLabels } from '../../../shared/blueprint-semantic-contract'
import { sqliteTime } from '../../../shared/sqlite-time'
import type { ChapterRow } from '../../../stores/navigation/stage-progress'
import { useLocaleStore } from '../../../stores/locale-store'
import type { EditableChapterBlueprintField } from '../../editor/chapter-card-draft-ledger'
import { Button } from '../../ui/Button'
import { Menu } from '../../ui/Menu'
import { isComposing } from '../shortcut-keys'
import { CHAPTER_PHASE_TEXT, CHAPTER_RUNNING_TEXT } from '../stage-text'
import SceneCardEditor from './SceneCardEditor'

interface BlueprintCardProps {
  blueprint: ChapterBlueprint
  row: ChapterRow | undefined
  saving: boolean
  onField: <K extends EditableChapterBlueprintField>(key: K, value: ChapterBlueprint[K]) => void
  onSave: () => void
  onDelete: () => void
}

/** 单章蓝图：标题、定位、出场人物、主角小目标、冲突与转折、悬念钩子、作者微操指导、章节要点。章号是稳定标识，只读。 */
export default function BlueprintCard({ blueprint, row, saving, onField, onSave, onDelete }: BlueprintCardProps) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  // 正在输入的人名只属于当前这一章；换章时清空，不重建整张卡片（几百章换章要快）。
  const [draft, setDraft] = useState({ chapter: blueprint.chapterNumber, name: '' })
  const person = draft.chapter === blueprint.chapterNumber ? draft.name : ''
  const setPerson = (name: string) => setDraft({ chapter: blueprint.chapterNumber, name })
  const ids = { purpose: useId(), conflict: useId(), hook: useId(), guide: useId(), notes: useId(), person: useId() }
  const number = blueprint.chapterNumber

  const addPeople = () => {
    const names = [...new Set(person.split(/[,，、\s]+/u).map(name => name.trim()))].filter(name => name && !blueprint.characters.includes(name))
    setPerson('')
    if (names.length > 0) onField('characters', [...blueprint.characters, ...names])
  }

  const onPersonKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing({ isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode })) return
    if (event.key === 'Enter' || event.key === ',' || event.key === '，' || event.key === '、') {
      event.preventDefault()
      addPeople()
    } else if (event.key === 'Backspace' && !person && blueprint.characters.length > 0) {
      onField('characters', blueprint.characters.slice(0, -1))
    }
  }

  const status = row?.running ? CHAPTER_RUNNING_TEXT : CHAPTER_PHASE_TEXT[row?.phase ?? 'todo']
  const conflict = splitBlueprintLabels(blueprint.keyEvents)
  const conflictProse = conflict.prose
  const conflictLabels = conflict.labels
  // 标注可改可删（issue #91）：原来是纯只读 chip，作者既改不掉旧标注、也没法让新标注生效
  // （他只能写在正文里，而 `joinBlueprintLabels` 会把旧的拼在后面、下游 `.at(-1)` 恒读旧值）。
  const replaceLabel = (index: number, raw: string) => {
    const next = [...conflictLabels]
    const text = raw.trim()
    // 清空 = 删除这一条。
    if (!text) next.splice(index, 1)
    else next[index] = text
    onField('keyEvents', joinBlueprintLabels(conflictProse, next))
  }
  /** 取某一类标注的当前值（下拉的 current value）；没有则空串。 */
  const labelValueOfKind = (kind: '时点' | '收束') => {
    for (const label of conflictLabels) {
      if (blueprintLabelKind(label) !== kind) continue
      const value = label.replace(/^【\s*[^：:]+\s*[:：]\s*/u, '').replace(/】$/u, '').trim()
      if (value) return value
    }
    return ''
  }
  /** 改某一类标注的值（下拉）：没有同类就追加一条。 */
  const setLabelOfKind = (kind: '时点' | '收束', value: string) => {
    const next = conflictLabels.filter(label => blueprintLabelKind(label) !== kind)
    if (value) next.push(`【${kind}：${value}】`)
    onField('keyEvents', joinBlueprintLabels(conflictProse, next))
  }

  return (
    <section className="stage-bp-card" aria-label={text(`第 ${number} 章蓝图`, `Chapter ${number} blueprint`)}>
      <div className="stage-bp-card-inner">
        <div className="stage-bp-card-bar">
          <span className="stage-bp-card-status">{text('正文', 'Manuscript')} · {text(...status)}</span>
          <span className="stage-bp-card-gap" />
          <Button variant="secondary" size="sm" disabled={saving} aria-busy={saving || undefined} onClick={onSave}>
            {saving ? text('保存中…', 'Saving…') : text('保存此章', 'Save chapter')}
          </Button>
          <Menu
            label={text(`第 ${number} 章更多操作`, `More for chapter ${number}`)}
            icon={<MoreHorizontal size={16} aria-hidden />}
            align="end"
            groups={[{ id: 'danger', tone: 'danger', label: text('危险', 'Danger'), items: [
              { id: 'delete', label: text('删除此章…', 'Delete chapter…'), onSelect: onDelete },
            ] }]}
          />
        </div>

        <div className="stage-bp-title-row">
          <span className="stage-bp-title-no" title={text('章节号是现有内容的稳定标识，不能修改', 'The chapter number is a stable identifier and cannot be changed.')}>{number}</span>
          <input
            className="stage-bp-title"
            aria-label={text('章节标题', 'Chapter title')}
            value={blueprint.title}
            placeholder={text('给这一章起个名字', 'Name this chapter')}
            onChange={event => onField('title', event.target.value)}
          />
          <label className="stage-bp-role">
            <span className="stage-bp-sr">{text('章节定位', 'Chapter role')}</span>
            <select value={chapterRoleSelectValue(blueprint.role)} onChange={event => onField('role', event.target.value)}>
              {chapterRoleOptions(blueprint.role).map(({ value, labels }) => (
                <option key={value} value={value}>{labels ? text(labels.zhCN, labels.enUS) : value}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="stage-bp-field">
          <label htmlFor={ids.person}>{text('出场人物', 'Characters')}</label>
          <div className="stage-bp-people">
            {/* 旧数据里可能有重名：按位置区分，移除只去掉点的那一个。 */}
            {blueprint.characters.map((name, index) => (
              <span key={`${index}:${name}`} className="stage-bp-person">
                {name}
                <Button
                  variant="icon"
                  size="sm"
                  aria-label={text(`移除 ${name}`, `Remove ${name}`)}
                  onClick={() => onField('characters', blueprint.characters.filter((_, at) => at !== index))}
                >
                  <X size={12} aria-hidden />
                </Button>
              </span>
            ))}
            <input
              id={ids.person}
              className="stage-bp-person-input"
              value={person}
              placeholder={text('添加人物，回车确认', 'Add a name, press Enter')}
              onChange={event => setPerson(event.target.value)}
              onKeyDown={onPersonKey}
              onBlur={addPeople}
            />
          </div>
        </div>

        <div className="stage-bp-field">
          <label htmlFor={ids.purpose}>{text('主角小目标', 'Protagonist goal')} <em>{text('本章最想解决的事', 'The main thing to resolve in this chapter')}</em></label>
          <textarea id={ids.purpose} className="stage-bp-ctl" rows={2} value={blueprint.purpose} onChange={event => onField('purpose', event.target.value)} />
        </div>

        <div className="stage-bp-pair">
          <div className="stage-bp-field">
            <label htmlFor={ids.conflict}>
              {text('冲突与转折', 'Conflict and turn')}
              {/* 收束/装置标注是给下游读的（#28/#32），不属于作者要改的叙事内容：
                  单独只读展示，编辑框里只留正文，保存时再拼回去（issue #65）。 */}
              {conflictLabels.length > 0 && (
                <span className="stage-bp-labels" aria-label={text('机器读的标注（可编辑）', 'Machine-read labels (editable)')}>
                  {conflictLabels.map((label, index) => (
                    <span key={`${label}-${index}`} className="stage-bp-label">
                      {/* 可编辑而不是只读（issue #91）：预检让作者「按正文实际落幅改标注」，
                          但只读 chip 让这句话做不到——他改不了旧标注，写在正文里新标注又压不过旧的。 */}
                      <input
                        className="stage-bp-label-input"
                        value={label}
                        aria-label={text(`标注 ${index + 1}`, `Label ${index + 1}`)}
                        onChange={event => replaceLabel(index, event.target.value)}
                      />
                      <button
                        type="button"
                        className="stage-bp-label-remove"
                        aria-label={text(`删除标注 ${label}`, `Remove label ${label}`)}
                        title={text('删除这条标注', 'Remove this label')}
                        onClick={() => replaceLabel(index, '')}
                      >×</button>
                    </span>
                  ))}
                </span>
              )}
            </label>
            <textarea
              id={ids.conflict}
              className="stage-bp-ctl"
              rows={3}
              value={conflictProse}
              onChange={event => onField('keyEvents', joinBlueprintLabels(event.target.value, conflictLabels))}
            />
            {/* 收束用合同里的 6 种类型做下拉（issue #91 建议 1）：减少手打错值导致下游读不到。 */}
            <label className="stage-bp-label-select">
              {text('收束方式', 'Closing shot')}
              <select
                value={labelValueOfKind('收束')}
                onChange={event => setLabelOfKind('收束', event.target.value)}
              >
                <option value="">{text('（未标注）', '(unlabelled)')}</option>
                {BLUEPRINT_CLOSING_SHOT_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
              </select>
            </label>
          </div>
          <div className="stage-bp-field">
            <label htmlFor={ids.hook}>{text('悬念钩子', 'Suspense hook')}</label>
            <textarea id={ids.hook} className="stage-bp-ctl" rows={3} value={blueprint.suspenseHook} onChange={event => onField('suspenseHook', event.target.value)} />
          </div>
        </div>

        <div className="stage-bp-field">
        <SceneCardEditor chapterNumber={number} characters={blueprint.characters} disabled={saving} />

          <label htmlFor={ids.guide}>{text('作者微操指导', 'Author guidance')} <em>{text('写作此章时一并交给 AI，优先于蓝图', 'Sent with this chapter when writing; it takes priority over the blueprint')}</em></label>
          <textarea
            id={ids.guide}
            className="stage-bp-ctl"
            rows={2}
            value={blueprint.userGuidance}
            placeholder={text('不填则完全按蓝图写。', 'Leave blank to follow the blueprint exactly.')}
            onChange={event => onField('userGuidance', event.target.value)}
          />
        </div>

        <div className="stage-bp-field">
          <label htmlFor={ids.notes}>
            {text('章节要点', 'Chapter notes')}{' '}
            <em>{blueprint.notesUpdatedAt
              ? text(`定稿后自动生成 · ${sqliteTime(blueprint.notesUpdatedAt).toLocaleDateString(locale)}`, `Generated after finalization · ${sqliteTime(blueprint.notesUpdatedAt).toLocaleDateString(locale)}`)
              : text('定稿后自动生成，也可以先手写给 AI 参考', 'Generated after finalization; you can also write them first for reference')}</em>
          </label>
          <textarea id={ids.notes} className="stage-bp-ctl" rows={3} value={blueprint.notes || ''} onChange={event => onField('notes', event.target.value)} />
        </div>
      </div>
    </section>
  )
}
