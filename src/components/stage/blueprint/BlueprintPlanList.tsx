import { NotebookPen, Sparkle } from 'lucide-react'
import type { ChapterBlueprint } from '../../../services/workflows/directory-workflow'
import type { ChapterRow } from '../../../stores/navigation/stage-progress'
import { useLocaleStore } from '../../../stores/locale-store'
import { CHAPTER_PHASE_TEXT, CHAPTER_RUNNING_TEXT } from '../stage-text'

interface BlueprintPlanListProps {
  blueprints: readonly ChapterBlueprint[]
  rows: ReadonlyMap<number, ChapterRow>
  selectedIdx: number
  nextWriteChapter: number | null
  onSelect: (index: number) => void
}

/** 章节规划列表：章号、标题、有作者指导与要点的标记、正文进度。 */
export default function BlueprintPlanList({ blueprints, rows, selectedIdx, nextWriteChapter, onSelect }: BlueprintPlanListProps) {
  const text = useLocaleStore(s => s.text)
  return (
    <aside className="stage-bp-plan" aria-label={text('章节规划', 'Chapter plan')}>
      <div className="stage-bp-plan-top">{text(`${blueprints.length} 章`, `${blueprints.length} chapters`)}</div>
      <ol className="stage-bp-plan-list">
        {blueprints.map((blueprint, index) => {
          const row = rows.get(blueprint.chapterNumber)
          const status = row?.running ? 'running' : row?.phase ?? 'todo'
          return (
            <li key={blueprint.chapterNumber}>
              <button
                type="button"
                className="stage-bp-plan-item"
                aria-current={index === selectedIdx ? 'true' : undefined}
                onClick={() => onSelect(index)}
              >
                <span className="stage-bp-plan-no">{blueprint.chapterNumber}</span>
                <span className="stage-bp-plan-name">{blueprint.title || text('未命名', 'Untitled')}</span>
                <span className="stage-bp-plan-marks">
                  {blueprint.userGuidance && <NotebookPen size={13} role="img" aria-label={text('有作者指导', 'Has author guidance')} />}
                  {blueprint.notes && <Sparkle size={13} role="img" aria-label={text('有章节要点', 'Has chapter notes')} />}
                </span>
                <span className="stage-bp-plan-status" data-status={status} data-next={blueprint.chapterNumber === nextWriteChapter || undefined}>
                  {text(...(row?.running ? CHAPTER_RUNNING_TEXT : CHAPTER_PHASE_TEXT[row?.phase ?? 'todo']))}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </aside>
  )
}
