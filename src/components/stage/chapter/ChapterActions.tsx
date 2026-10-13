import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BadgeCheck, MoreHorizontal, Search, Sparkles } from 'lucide-react'
import type { ReviewCycleProjection } from '../../../shared/review-cycle'
import type { HumanConfirmedReviewSnapshot } from '../../../shared/human-confirmed-review'
import { chapterLabel } from '../../../shared/chapter-label'
import { countDraftUnits } from '../../../shared/draft-units'
import { isGenerationModel, preferredGenerationModelId } from '../../../services/workflows/chapter-write-launch'
import { useEditorStore, type EditorTab } from '../../../stores/editor-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { navigate } from '../../../stores/navigation/navigation-intents'
import { openChapterPlan } from '../../../stores/navigation/stage-navigation'
import { deriveChapters } from '../../../stores/navigation/stage-progress'
import { useDraftStore } from '../../../stores/draft-store'
import { useProjectStore } from '../../../stores/project-store'
import { includedCount, useReviewChecklist } from '../../editor/review-checklist'
import { reviewDimensions, type useDraftActions } from '../../editor/use-draft-actions'
import { deleteDraftVersion } from '../../panels/sidebar/draft-deletion'
import { deleteFinalizedChapter } from '../../panels/sidebar/finalized-chapter-deletion'
import { captureProjectSession } from '../../project-session-gate'
import { Button } from '../../ui/Button'
import { Check } from '../../ui/Check'
import { DangerConfirm } from '../../ui/DangerConfirm'
import { Menu, type MenuGroupSpec } from '../../ui/Menu'
import { Notice } from '../../ui/Notice'
import { toast } from '../../ui/Toast'
import { InkDialog } from '../InkDialog'
import { useStageView } from '../use-stage-work'
import { openDraftInChapterView, swapChapterTab } from './chapter-tab-routing'
import type { ChapterStage } from './chapter-lifecycle'
import MergeView from './MergeView'
import PostProcessSteps from './PostProcessSteps'
import ReviewSheet from './ReviewSheet'
import SplitAction from './SplitAction'

type DraftActions = ReturnType<typeof useDraftActions>

interface LatestReview {
  report: string
  reviewId: number
  snapshot: HumanConfirmedReviewSnapshot | null
  cycle: ReviewCycleProjection | null
  reloadCycle: () => Promise<ReviewCycleProjection | null>
}

type Ask = 'refine' | 'finalize' | 'delete' | null

/**
 * 章节动作条与它带出的侧页、对话框。主按钮随这一章所处的一步变化：AI 审稿（拆分按钮含检查维度）、按 N 项意见修稿、
 * 完成合并、定稿；直接修稿、删除这一稿、复制本章正文在「更多」里。审稿清单的状态也在这里，
 * 侧页的勾选数与主按钮的「按 N 项意见修稿」是同一份。挂载方以审稿报告的会话键作 key，报告变了清单随之重置。
 */
export default function ChapterActions({ sheetSlot, tab, stage, chapterNumber, title, draft, review, focus }: {
  sheetSlot: HTMLDivElement | null
  tab: EditorTab
  stage: ChapterStage
  chapterNumber: number
  title: string
  draft: DraftActions
  review: LatestReview | null
  focus: boolean
}) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const models = useLLMStore(s => s.models)
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  const { chapters } = useStageView()
  const filePath = tab.filePath!
  const projectKey = tab.projectKey!
  const meta = draft.meta!
  const checklist = useReviewChecklist({
    reportText: review?.report ?? '',
    draftPath: filePath,
    chapterNumber,
    chapterDir: `ai-novel://draft/ch${chapterNumber}`,
    reviewId: review?.reviewId,
    projectKey,
    initialSnapshot: review?.snapshot ?? null,
    cycle: review?.cycle ?? null,
    reloadCycle: review?.reloadCycle ?? (async () => null),
  })
  const dims = reviewDimensions(text)
  const [checkedDims, setCheckedDims] = useState<Record<string, boolean>>(() => Object.fromEntries(dims.map(dim => [dim.key, true])))
  const [reviseModelId, setReviseModelId] = useState<string | null>(null)
  const [sheetPref, setSheetPref] = useState<boolean | null>(null)
  const [ask, setAsk] = useState<Ask>(null)
  const [refinePrompt, setRefinePrompt] = useState('')
  const [mergeLater, setMergeLater] = useState(false)

  const sheetOpen = Boolean(review) && !focus && (sheetPref ?? stage === 'reviewed')
  const included = includedCount(checklist.items)
  const busy = draft.isChapterBusy
  const generationModels = models.filter(isGenerationModel)
  const selectedReviseModel = reviseModelId ?? preferredGenerationModelId(models, defaultModelId)
  const pending = draft.pendingRevisions[0]
  const versionLabel = text(`草稿 v${meta.version}`, `Draft v${meta.version}`)

  // 有待合并的修稿时直接摆出合并视图；作者选了稍后再合并就留在正文，直到再点「打开修稿合并」。
  // 每份修稿只自动打开一次：正文有未保存修改时打开会被拒绝并提示，不能每次渲染都再提示。
  const { mergeData, openPendingRevision } = draft
  const autoOpened = useRef<number | null>(null)
  useEffect(() => {
    if (stage !== 'merge' || !pending || mergeData || mergeLater || autoOpened.current === pending.id) return
    autoOpened.current = pending.id
    void openPendingRevision(pending)
  }, [stage, pending, mergeData, mergeLater, openPendingRevision])

  const startReview = () => void draft.review(dims.filter(dim => checkedDims[dim.key]).map(dim => dim.promptLabel).join('、') || undefined)

  /** 按勾选的意见修稿：清单改过或还没确认就先确认成新快照，再按它启动修稿；失败原因写在侧页里。 */
  const revise = async () => {
    if (!selectedReviseModel) {
      checklist.setChecklistError(text('没有可用于文本生成的模型。请在设置中添加或启用一项生成模型。', 'No model can generate text. Add or enable a generation model in Settings.'))
      setSheetPref(true)
      return
    }
    const confirmed = checklist.editingChecklist || !checklist.confirmed ? await checklist.confirmChecklist() : checklist.confirmed
    if (!confirmed) {
      setSheetPref(true)
      return
    }
    const error = await checklist.startConfirmedRevision(selectedReviseModel, confirmed)
    if (error) {
      checklist.setChecklistError(error)
      setSheetPref(true)
    } else {
      setSheetPref(false)
    }
  }

  const copyBody = () => {
    const body = useEditorStore.getState().tabs.find(candidate => candidate.id === tab.id)?.content ?? ''
    void navigator.clipboard.writeText(body)
      .then(() => toast.success(text('已复制本章正文', 'Chapter text copied')))
      .catch(() => toast.error(text('无法复制正文', 'Could not copy the chapter text')))
  }

  /** 删掉这一稿后，标签留在原位换成这一章现在的那一稿；一稿都不剩就回到待写。 */
  const deleteThisDraft = async () => {
    const project = useProjectStore.getState().currentProject
    const displayName = `${chapterLabel(chapterNumber, text)} v${meta.version}`
    if (!await deleteDraftVersion({ draft: meta, displayName, projectKey, project })) return
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session) return
    const [row] = deriveChapters({
      blueprints: [{ chapterNumber, title }],
      drafts: { [chapterNumber]: useDraftStore.getState().draftsByChapter[chapterNumber] ?? [] },
      runningChapters: new Set(),
    })
    const next = row?.draft
    await swapChapterTab(tab.id, next
      ? () => openDraftInChapterView(next, title, session)
      : () => { openChapterPlan(chapterNumber, title, session); return true })
  }

  const deleteManuscript = async () => {
    await deleteFinalizedChapter({
      project: useProjectStore.getState().currentProject,
      projectPath: projectKey,
      draftId: meta.id,
      chapterNumber,
      displayName: chapterLabel(chapterNumber, text),
      tabFilePath: filePath,
      surface: 'manuscript',
    })
    if (!useEditorStore.getState().tabs.some(candidate => candidate.id === tab.id)) navigate({ kind: 'chapter', chapterNumber })
  }

  const editable = stage === 'draft' || stage === 'reviewed' || stage === 'merge' || stage === 'revised'
  const moreGroups: MenuGroupSpec[] = [
    { id: 'chapter', items: [
      ...(editable ? [{ id: 'refine', label: text('直接修稿…', 'Revise directly…'), disabled: busy, onSelect: () => { setRefinePrompt(''); setAsk('refine') } }] : []),
      ...(editable && stage !== 'revised' ? [{ id: 'finalize', label: text('定稿…', 'Finalize…'), disabled: busy || !draft.canFinalize, onSelect: () => setAsk('finalize') }] : []),
      ...(review && !sheetOpen && !focus ? [{ id: 'report', label: text('审稿报告', 'Review report'), onSelect: () => setSheetPref(true) }] : []),
      { id: 'history', label: text('版本历史', 'Version history'), onSelect: () => navigate({ kind: 'resource', page: 'history' }) },
      { id: 'copy', label: text('复制本章正文', 'Copy chapter text'), onSelect: copyBody },
    ] },
    { id: 'danger', tone: 'danger', items: stage === 'final'
      ? [{ id: 'delete', label: text('删除正文…', 'Delete manuscript…'), disabled: busy, onSelect: () => void deleteManuscript() }]
      : [{ id: 'delete', label: text('删除这一稿…', 'Delete this draft…'), disabled: busy, onSelect: () => setAsk('delete') }] },
  ]
  const more = <Menu label={text('更多操作', 'More actions')} icon={<MoreHorizontal size={16} aria-hidden />} groups={moreGroups} />
  const reviewAgain = <Button variant="secondary" disabled={busy} onClick={startReview}>{text('重新审稿', 'Review again')}</Button>
  const nextRow = chapters.find(row => row.number > chapterNumber)

  const recheck = checklist.cycle?.revisionStatus === 'merge-committed' ? checklist.cycle : null
  const resolved = recheck?.findings.filter(finding => finding.status === 'resolved').length ?? 0
  const revisedHint = recheck?.recheckDisposition === 'completed'
    ? text(`复验完成：${resolved} / ${recheck.findings.length} 项意见已解决`, `Recheck done: ${resolved} of ${recheck.findings.length} notes resolved`)
    : recheck?.recheckDisposition === 'required'
      ? text('合并后复验还没完成，可在审稿报告里重试', 'The post-merge recheck is incomplete; retry it in the review report')
      : text('修稿已合并，可以定稿', 'The revision is merged and ready to finalize')

  const bar = (() => {
    switch (stage) {
      case 'draft':
        return (
          <>
            <SplitAction label={text('AI 审稿', 'AI review')} icon={<Search size={15} aria-hidden />} disabled={busy} onRun={startReview} optionsLabel={text('检查维度', 'Review focus')}>
              <p className="pi-popover-title">{text('重点检查维度', 'Review focus')}</p>
              {dims.map(dim => (
                <Check key={dim.key} checked={Boolean(checkedDims[dim.key])} onChange={checked => setCheckedDims(current => ({ ...current, [dim.key]: checked }))} label={<span className="stage-ch-dim">{dim.label}<small>{dim.desc}</small></span>} />
              ))}
              <p className="stage-ch-options-foot">{text('只用于这一次审稿', 'Applies to this review only')}</p>
            </SplitAction>
            {more}
            <span className="stage-ch-hint">{text('可以直接改正文，⌘S 保存', 'Edit the text directly; ⌘S saves')}</span>
          </>
        )
      case 'reviewed':
        return (
          <>
            <SplitAction
              label={text(`按 ${included} 项意见修稿`, `Revise with ${included} ${included === 1 ? 'note' : 'notes'}`)}
              icon={<Sparkles size={15} aria-hidden />}
              disabled={busy || included === 0 || checklist.confirming || checklist.processing}
              onRun={() => void revise()}
              optionsLabel={text('修稿选项', 'Revision options')}
            >
              <label className="pi-field">
                <span>{text('本次修稿模型', 'Model for this revision')} <em>{text('只用于这一次', 'This run only')}</em></span>
                <select className="pi-input" value={selectedReviseModel ?? ''} disabled={generationModels.length === 0} onChange={event => setReviseModelId(event.target.value || null)}>
                  <option value="" disabled>{text('请选择可用生成模型', 'Select a generation model')}</option>
                  {generationModels.map(model => <option key={model.id} value={model.id}>{model.name || model.modelName}{model.id === defaultModelId ? text('（默认）', ' (default)') : ''}</option>)}
                </select>
              </label>
              <p className="stage-ch-options-foot">{text('只把勾选的意见和总体指导交给修稿，原始审稿不会成为模型指令。', 'Only checked notes and your guidance go to the revision; the raw review is not a model instruction.')}</p>
            </SplitAction>
            {reviewAgain}
            {more}
            <span className="stage-ch-hint">{included === 0 ? text('至少勾选一项意见', 'Check at least one note') : text('修稿结果会以差异给你确认，不会直接覆盖', 'You confirm the revision as a diff; nothing is overwritten')}</span>
          </>
        )
      case 'merge':
        return (
          <>
            <Button variant="primary" disabled={busy} onClick={() => { setMergeLater(false); if (pending) void openPendingRevision(pending) }}>
              {text('打开修稿合并', 'Open revision merge')}
            </Button>
            {more}
            <span className="stage-ch-hint">{text(`有 ${draft.pendingRevisions.length} 份修稿待合并`, `${draft.pendingRevisions.length} revision(s) waiting to merge`)}</span>
          </>
        )
      case 'revised':
        return (
          <>
            <Button variant="primary" disabled={busy || !draft.canFinalize || Boolean(draft.finalizationConflict) || draft.finalizationPending} onClick={() => setAsk('finalize')}>
              <BadgeCheck size={15} aria-hidden />{text('定稿', 'Finalize')}
            </Button>
            {reviewAgain}
            {more}
            <span className="stage-ch-hint" data-tone={recheck?.recheckDisposition === 'completed' ? 'ok' : undefined}>{revisedHint}</span>
          </>
        )
      case 'final':
        return (
          <>
            {nextRow && (
              <Button variant="primary" onClick={() => navigate({ kind: 'chapter', chapterNumber: nextRow.number })}>
                {nextRow.phase === 'todo' ? text(`写第 ${nextRow.number} 章`, `Write chapter ${nextRow.number}`) : text(`打开第 ${nextRow.number} 章`, `Open chapter ${nextRow.number}`)}
              </Button>
            )}
            {more}
            <span className="stage-ch-hint">{text('已定稿，只读', 'Finalized; read-only')}</span>
          </>
        )
      case 'archived':
        return (
          <>
            <Button variant="secondary" onClick={() => navigate({ kind: 'chapter', chapterNumber })}>{text('回到当前稿', 'Back to the current draft')}</Button>
            {more}
            <span className="stage-ch-hint">{text('已归档，只读', 'Archived; read-only')}</span>
          </>
        )
      default:
        return null
    }
  })()

  const units = countDraftUnits(tab.content ?? '').toLocaleString(locale)

  return (
    <>
      {!(stage === 'merge' && draft.mergeData) && <div className="stage-ch-actions">{bar}</div>}
      {draft.finalizationConflict && (
        <Notice tone="warn" title={text('已保留后续编辑', 'Later edits kept')}>
          {text('定稿完成事件没有覆盖这次编辑；请先处理本地后续修改与已定稿版本的差异。', 'Finalization did not overwrite this edit. Resolve the difference between your later local changes and the finalized version first.')}
        </Notice>
      )}
      {stage === 'final' && (
        <PostProcessSteps
          chapterNumber={chapterNumber}
          publication={tab.finalizationPublication}
          busy={busy}
          onRetryStep={stepKey => void draft.repairFinalize(stepKey)}
          onRetryFailed={() => void draft.repairFinalize()}
          onRetryPublication={() => void draft.retryManuscriptPublication()}
        />
      )}
      {draft.mergeData && (
        <MergeView
          data={draft.mergeData}
          versionLabel={versionLabel}
          recheck={pending?.type === 'review-fix'}
          onComplete={draft.completeMerge}
          onLater={() => { setMergeLater(true); draft.closeMerge() }}
        />
      )}
      {sheetOpen && review && sheetSlot && createPortal(
        <ReviewSheet
          checklist={checklist}
          reportText={review.report}
          subtitle={text(`基于草稿 v${meta.version}`, `Based on draft v${meta.version}`)}
          onClose={() => setSheetPref(false)}
        />,
        sheetSlot,
      )}
      <InkDialog
        open={ask === 'refine'}
        onOpenChange={open => { if (!open) setAsk(null) }}
        title={text('直接修稿', 'Revise directly')}
        description={text('不经审稿，AI 对全文做基础润色、优化用词，增强画面与表现力；结果以差异给你逐段确认。', 'Without a review, AI polishes the whole chapter and strengthens imagery; you confirm the result paragraph by paragraph.')}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setAsk(null)}>{text('取消', 'Cancel')}</Button>
            <Button variant="primary" onClick={() => { setAsk(null); void draft.refine(refinePrompt) }}>{text('开始修稿', 'Start revision')}</Button>
          </>
        )}
      >
        <label className="pi-field">
          <span>{text('附加修稿要求', 'Additional guidance')} <em>{text('可选', 'Optional')}</em></span>
          <textarea
            className="pi-input stage-ch-textarea"
            rows={4}
            value={refinePrompt}
            placeholder={text('例如：加强打斗场面的画面感；对白太书面化，改为口语化。', 'For example: make the action more vivid; make the dialogue less formal.')}
            onChange={event => setRefinePrompt(event.target.value)}
          />
        </label>
      </InkDialog>
      <InkDialog
        open={ask === 'finalize'}
        onOpenChange={open => { if (!open) setAsk(null) }}
        title={text(`定稿第 ${chapterNumber} 章？`, `Finalize chapter ${chapterNumber}?`)}
        description={text('定稿是这部作品里的一次提交。提交后本章只读，后面的章节都以它为准。', 'Finalizing commits this chapter to the book. It becomes read-only and later chapters build on it.')}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setAsk(null)}>{text('再看看', 'Not yet')}</Button>
            <Button variant="primary" disabled={busy || !draft.canFinalize} onClick={() => { setAsk(null); void draft.finalize() }}>{text('确认定稿', 'Finalize')}</Button>
          </>
        )}
      >
        <ul className="stage-ch-commit">
          <li><b>{text('写入正文。', 'Writes the manuscript.')}</b>{text(`这 ${units} 字成为第 ${chapterNumber} 章正文，同时保存为正文文件。`, `These ${units} words become chapter ${chapterNumber} and are saved as the manuscript file.`)}</li>
          <li><b>{text('自动做定稿后处理。', 'Runs post-finalization steps.')}</b>{text('完成后在本章页面显示每一步的结果，失败的步骤可以单独重试。', 'Each step’s result appears on this chapter; a failed step can be retried on its own.')}</li>
          <li><b>{text('之后不能直接修改。', 'No direct edits afterwards.')}</b>{text('要再改，从版本历史回退为新草稿。', 'To change it again, roll back to a new draft from version history.')}</li>
        </ul>
        {tab.dirty && <Notice tone="info" title={text('还没保存的修改会一并定稿', 'Unsaved edits are included')}>{text('定稿以你现在看到的正文为准。', 'Finalization uses the text exactly as you see it now.')}</Notice>}
      </InkDialog>
      <DangerConfirm
        open={ask === 'delete'}
        onOpenChange={open => { if (!open) setAsk(null) }}
        title={text(`删除${chapterLabel(chapterNumber, text)} v${meta.version}？`, `Delete ${chapterLabel(chapterNumber, text)} v${meta.version}?`)}
        consequence={text('这一稿的正文以及它的审稿、修稿记录都会被删除。', 'This draft’s text and its review and revision records are deleted.')}
        recoverability={text('删除后无法恢复；本章其他版本不受影响。', 'This cannot be undone. Other versions of this chapter are kept.')}
        confirmLabel={text('删除这一稿', 'Delete this draft')}
        cancelLabel={text('取消', 'Cancel')}
        onConfirm={() => void deleteThisDraft()}
      />
    </>
  )
}
