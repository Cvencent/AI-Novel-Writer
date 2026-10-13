import { useEffect } from 'react'
import { blueprintWritePrefill } from '../../../services/workflows/chapter-write-launch'
import type { EditorTab } from '../../../stores/editor-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { navigate } from '../../../stores/navigation/navigation-intents'
import { useStageStore } from '../../../stores/navigation/stage-store'
import { openBuiltinEditor } from '../../../stores/open-builtin-editor'
import { useProjectStore } from '../../../stores/project-store'
import { captureProjectSession } from '../../project-session-gate'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'
import { useIncompleteDeletions } from '../../panels/sidebar/use-incomplete-deletions'
import { useStageView } from '../use-stage-work'
import WriteChapterPopover from '../write/WriteChapterPopover'
import { openDraftInChapterView, swapChapterTab } from './chapter-tab-routing'
import ChapterHead from './ChapterHead'
import { useChapterBlueprint } from './use-chapter-blueprint'

/**
 * 待写章的单章视图：本章蓝图只读展示，主按钮「写作此章」按蓝图写，箭头弹层只改本次模型与指导。
 * 这一章有了稿（写完了，或在别处写好）就在这个标签的位置换成那一稿。
 */
export default function ChapterPlan({ tab, chapterNumber, projectKey }: { tab: EditorTab; chapterNumber: number; projectKey: string }) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const focus = useStageStore(s => s.focus)
  const wordsPerChapter = useProjectStore(s => s.currentProject?.novelConfig.wordsPerChapter)
  const blueprint = useChapterBlueprint(chapterNumber, projectKey)
  const { chapters } = useStageView()
  const row = chapters.find(candidate => candidate.number === chapterNumber)
  const draft = row?.draft ?? null
  const deletions = useIncompleteDeletions(projectKey)
  const unfinished = deletions.operations.filter(operation => operation.chapterNumber === chapterNumber)

  useEffect(() => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!draft || !session) return
    void swapChapterTab(tab.id, () => openDraftInChapterView(draft, row?.title ?? '', session))
  }, [draft, row?.title, tab.id])

  const editBlueprint = () => openBuiltinEditor('chapter-card-editor', text('章节蓝图', 'Chapter blueprint'), 'chapter-card', undefined, chapterNumber)
  const target = wordsPerChapter && wordsPerChapter > 0 ? wordsPerChapter.toLocaleString(locale) : null

  return (
    <div className="stage-ch" data-focus={focus || undefined}>
      <div className="stage-ch-scroll">
        <article className="stage-ch-page">
          <ChapterHead
            chapterNumber={chapterNumber}
            role={blueprint?.role}
            title={blueprint?.title ?? row?.title ?? ''}
            step={0}
            focus={focus}
            version={(
              <span className="stage-ch-version stage-ch-version-chip">
                {target ? text(`尚无草稿 · 目标 ${target} 字`, `No draft yet · target ${target} words`) : text('尚无草稿', 'No draft yet')}
              </span>
            )}
          />
          {blueprint && (
            <div className="stage-ch-actions">
              <WriteChapterPopover chapterNumber={chapterNumber} blueprint={blueprintWritePrefill(blueprint)} label={text('写作此章', 'Write this chapter')} align="start" />
              <span className="stage-ch-hint">
                {row?.running
                  ? text('这一章正在写，完成后会在这里换成草稿', 'This chapter is being written; the draft replaces this page when it is done')
                  : text('按本章蓝图写作，不再重复填写参数', 'Writes from this chapter’s blueprint; nothing to fill in again')}
              </span>
            </div>
          )}
          <div className="stage-ch-notices">
            {unfinished.map(operation => {
              const manual = operation.legacyKnowledgeAuthorization === 'required'
              return (
                <Notice
                  key={operation.operationId}
                  tone="warn"
                  title={manual ? text('删除正文后待人工核对知识投影', 'The deleted manuscript needs a manual knowledge check') : text('删除正文后的清理没有完成', 'Cleanup after deleting the manuscript is unfinished')}
                  actions={(
                    <Button variant="secondary" size="sm" onClick={() => void (manual ? deletions.confirmLegacyDeletion(operation) : deletions.retryDeletion(operation))}>
                      {manual ? text('确认人工核对并继续', 'Confirm and continue') : text('重试清理', 'Retry cleanup')}
                    </Button>
                  )}
                >
                  {[operation.manuscriptStatus === 'failed' ? operation.manuscriptError : '', operation.knowledgeStatus === 'failed' ? operation.knowledgeError : ''].filter(Boolean).join('；') || null}
                </Notice>
              )
            })}
            {row?.running && (
              <Notice
                tone="info"
                title={text('正在写这一章', 'Writing this chapter')}
                actions={<Button variant="secondary" size="sm" onClick={() => navigate({ kind: 'run', facet: 'output' })}>{text('查看运行', 'Open run')}</Button>}
              />
            )}
            {blueprint === null && (
              <Notice
                tone="warn"
                title={text('这一章还没有蓝图', 'This chapter has no blueprint yet')}
                actions={<Button variant="secondary" size="sm" onClick={editBlueprint}>{text('去蓝图规划', 'Plan it in the blueprint')}</Button>}
              >
                {text('写作此章按蓝图写，先在蓝图里规划这一章。', 'Writing follows the blueprint, so plan this chapter there first.')}
              </Notice>
            )}
          </div>
          {blueprint && (
            <section className="stage-ch-plan" aria-label={text('本章蓝图', 'Chapter blueprint')}>
              <div className="stage-ch-plan-head">
                <h2 className="stage-ch-plan-title">{text('本章蓝图', 'Chapter blueprint')}<small>{text('只读 · 写作以此为准', 'Read-only · writing follows it')}</small></h2>
                <Button variant="text" size="sm" onClick={editBlueprint}>{text('在蓝图中编辑', 'Edit in blueprint')}</Button>
              </div>
              <dl className="stage-ch-plan-grid">
                <dt>{text('定位', 'Role')}</dt><dd>{blueprint.role || '—'}</dd>
                <dt>{text('出场角色', 'Characters')}</dt>
                <dd>{blueprint.characters.length > 0
                  ? <span className="stage-ch-chips">{blueprint.characters.map(name => <span key={name} className="stage-ch-chip">{name}</span>)}</span>
                  : '—'}</dd>
                <dt>{text('本章目的', 'Purpose')}</dt><dd>{blueprint.purpose || '—'}</dd>
                <dt>{text('关键事件', 'Key events')}</dt><dd>{blueprint.keyEvents || '—'}</dd>
                {blueprint.userGuidance && <><dt>{text('作者指导', 'Author guidance')}</dt><dd>{blueprint.userGuidance}</dd></>}
              </dl>
            </section>
          )}
          {blueprint && !row?.running && (
            <div className="stage-ch-blank">
              <b>{text('这一章还是空白', 'This chapter is still blank')}</b>
              {text('点「写作此章」，AI 会按上面的蓝图写出草稿。', 'Choose “Write this chapter” and AI drafts it from the blueprint above.')}
            </div>
          )}
        </article>
      </div>
    </div>
  )
}
