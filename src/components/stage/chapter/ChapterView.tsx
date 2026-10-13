import { useEffect, useState } from 'react'
import { countDraftUnits } from '../../../shared/draft-units'
import { formatResourceUri } from '../../../shared/project-paths'
import type { EditorTab } from '../../../stores/editor-store'
import { readDraftBody } from '../../../stores/draft-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useStageStore } from '../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../stores/project-store'
import type { ReviewEntry } from '../../../services/draft-index'
import CodeMirrorEditor from '../../editor/CodeMirrorEditor'
import { useReviewCycle } from '../../editor/review-checklist'
import { useDraftActions } from '../../editor/use-draft-actions'
import { captureProjectSession, isProjectSessionCurrent, isProjectSessionPath } from '../../project-session-gate'
import ChapterActions from './ChapterActions'
import ChapterHead from './ChapterHead'
import { useChapterBlueprint } from './use-chapter-blueprint'
import ChapterPlan from './ChapterPlan'
import { chapterStage, STAGE_STEP } from './chapter-lifecycle'
import VersionSwitcher from './VersionSwitcher'

/** 这一稿最新的审稿报告原文；审稿记录变化时重读。 */
function useLatestReview(reviews: readonly ReviewEntry[], projectKey: string) {
  const latest = reviews.at(-1) ?? null
  const [report, setReport] = useState<{ id: number; content: string } | null>(null)
  useEffect(() => {
    if (!latest) return
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionPath(session, projectKey)) return
    let cancelled = false
    // 读不出原文时按空报告处理：动作条照常出现，侧页里没有可勾选的意见，作者可以重新审稿。
    void readDraftBody(formatResourceUri({ kind: 'review', id: latest.id }), projectKey, session).catch(() => '').then(content => {
      if (!cancelled && isProjectSessionCurrent(session)) setReport({ id: latest.id, content })
    })
    return () => { cancelled = true }
  }, [latest, projectKey])
  return latest && report?.id === latest.id ? report : null
}

/**
 * 正文单章视图：章节头、生命周期、章节动作条、版本切换器与纸面正文。待写章显示本章蓝图与写作此章。
 * 审稿报告是视图里的侧页，修稿合并在纸面上逐段选择，定稿后显示后处理四步；全程不需要离开这个标签。
 */
export default function ChapterView({ tab }: { tab: EditorTab }) {
  const project = useProjectStore(s => s.currentProject)
  const session = captureProjectSession(project)
  const sessionKey = session && tab.projectKey && isProjectSessionPath(session, tab.projectKey)
    ? `${session.projectId}:${session.leaseId}`
    : `inactive:${tab.projectKey}`
  if (!tab.projectKey || tab.chapterNumber === undefined && !tab.filePath) return null
  if (!tab.filePath) return <ChapterPlan key={sessionKey} tab={tab} chapterNumber={tab.chapterNumber!} projectKey={tab.projectKey} />
  return <DraftChapter key={sessionKey} tab={tab} filePath={tab.filePath} projectKey={tab.projectKey} />
}

function DraftChapter({ tab, filePath, projectKey }: { tab: EditorTab; filePath: string; projectKey: string }) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const focus = useStageStore(s => s.focus)
  const request = useStageStore(s => s.chapterRequest)
  const draft = useDraftActions({ tabId: tab.id, filePath, content: tab.content ?? '', projectKey })
  const chapterNumber = draft.meta?.chapterNumber ?? tab.chapterNumber
  const blueprint = useChapterBlueprint(chapterNumber, projectKey)
  const latest = useLatestReview(draft.reviews, projectKey)
  const review = useReviewCycle({ reportText: latest?.content ?? '', reviewId: latest?.id, projectKey,
    refreshKey: `${draft.status}:${draft.pendingRevisions.map(revision => revision.id).join(',')}` })
  const [charCount, setCharCount] = useState(() => countDraftUnits(tab.content ?? ''))
  const [sheetSlot, setSheetSlot] = useState<HTMLDivElement | null>(null)

  // 最新审稿读出来之前不摆动作条：清单状态按审稿报告重置，先摆再换会让刚开始的合并或勾选丢掉。
  const reviewReady = draft.reviews.length === 0 || latest !== null
  const stage = draft.meta ? chapterStage({
    status: draft.status,
    pendingRevisions: draft.pendingRevisions.length,
    latestReview: draft.reviews.length > 0 ? { cycleStatus: review.cycle?.revisionStatus ?? null } : null,
  }) : null

  // 审稿或修稿刚在别处生成：重读这一稿的数据。新审稿换掉动作条的会话键，侧页按「已审稿」默认展开；待合并修稿直接摆出合并视图。
  const { reload } = draft
  useEffect(() => {
    if (!request || request.filePath !== filePath) return
    useStageStore.setState({ chapterRequest: null })
    reload()
  }, [request, filePath, reload])

  const title = blueprint?.title || draft.meta?.chapterTitle || ''
  const units = charCount.toLocaleString(locale)
  const versionLabel = !draft.meta ? text('读取中…', 'Loading…')
    : stage === 'final' ? text(`定稿 · ${units} 字`, `Final · ${units} words`)
      : stage === 'archived' ? text(`已归档 v${draft.meta.version} · ${units} 字`, `Archived v${draft.meta.version} · ${units} words`)
        : stage === 'revised' ? text(`修稿已合并 v${draft.meta.version} · ${units} 字`, `Revised v${draft.meta.version} · ${units} words`)
          : text(`草稿 v${draft.meta.version} · ${units} 字`, `Draft v${draft.meta.version} · ${units} words`)
  const editable = !draft.isReadonly && !draft.isChapterBusy

  return (
    <div className="stage-ch" data-focus={focus || undefined}>
      <div className="stage-ch-scroll">
        <article className="stage-ch-page" aria-busy={!draft.loaded}>
          {chapterNumber !== undefined && (
            <ChapterHead
              chapterNumber={chapterNumber}
              role={blueprint?.role}
              title={title}
              step={stage === 'archived' || stage === null ? null : STAGE_STEP[stage]}
              focus={focus}
              version={draft.meta
                ? <VersionSwitcher tab={tab} current={draft.meta} label={versionLabel} title={title} onSave={() => draft.save(draft.currentBodyRef.current, true)} />
                : <span className="stage-ch-version" role="status">{versionLabel}</span>}
            />
          )}
          {draft.meta && stage && chapterNumber !== undefined && reviewReady && (
            <ChapterActions
              key={review.sessionKey}
              sheetSlot={sheetSlot}
              tab={tab}
              stage={stage}
              chapterNumber={chapterNumber}
              title={title}
              draft={draft}
              review={latest ? { report: latest.content, reviewId: latest.id, snapshot: review.snapshot, cycle: review.cycle, reloadCycle: review.reloadCycle } : null}
              focus={focus}
            />
          )}
          {!draft.mergeData && (
            <div className="stage-ch-prose" data-readonly={!editable || undefined}>
              <CodeMirrorEditor
                mode="prose"
                fitContent
                content={tab.content ?? ''}
                filePath={filePath}
                editable={editable}
                hideStatusBar
                onCharCountChange={setCharCount}
                onChange={draft.onBodyChange}
                onSave={body => draft.save(body)}
              />
            </div>
          )}
        </article>
      </div>
      <div ref={setSheetSlot} className="stage-ch-sheet-slot" />
      {focus && (
        <footer className="stage-ch-focusbar" aria-label={text('写作状态', 'Writing status')}>
          <span>{text(`${units} 字`, `${units} words`)}</span>
          <span>{tab.dirty ? text('有未保存的修改', 'Unsaved changes') : text('已保存', 'Saved')}</span>
        </footer>
      )}
    </div>
  )
}
