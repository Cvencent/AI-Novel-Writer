import { useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { ipc } from '../../../services/ipc-client'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { sqliteTime } from '../../../shared/sqlite-time'
import type { ChapterCommit, ChapterCommitGap } from '../../../shared/writing-intelligence'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'
import { StatGrid } from '../../ui/StatGrid'
import { toast } from '../../ui/Toast'
import { InkDialog } from '../InkDialog'

export default function ChapterCommitDialog({ open, chapterNumber, onClose }: {
  open: boolean
  chapterNumber: number
  onClose: () => void
}) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const [commit, setCommit] = useState<ChapterCommit | null>(null)
  const [gaps, setGaps] = useState<ChapterCommitGap[]>([])
  const [loading, setLoading] = useState(false)
  /**
   * 重算分类的**预演结果**（issue #173）：先给作者看「会改几条、从→到」，
   * 点「重算」才真正落库。形状与仓库层回执一致（changed + counts）。
   */
  const [recategorize, setRecategorize] = useState<{ changed: number, counts: Record<string, number> } | null>(null)
  const load = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session) return
    setLoading(true)
    try {
      const loaded = await ipc.invokeWithProjectSession(session, 'db:writing-intelligence-commit-get', chapterNumber, session.projectPath)
      if (isProjectSessionCurrent(session)) setCommit(loaded)
      // issue #125：#62 之前定稿的章会永远缺账本，产品原来不提示。这里把缺口一并读出来，
      // 只有**当前章也在缺口里**时才展示（对话框是单章的，全量缺口在作品级另讲）。
      const all = await ipc.invokeWithProjectSession(session, 'db:writing-intelligence-commit-gaps', session.projectPath)
      if (isProjectSessionCurrent(session)) setGaps(Array.isArray(all) ? all : [])
    } finally { if (isProjectSessionCurrent(session)) setLoading(false) }
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- Hydrate the committed ledger when the dialog opens.
  useEffect(() => { if (open) void load() }, [open, chapterNumber])
  const currentGap = gaps.find(gap => gap.chapterNumber === chapterNumber)
  const rebuild = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || loading) return
    setLoading(true)
    try {
      const rebuilt = await ipc.invokeWithProjectSession(session, 'db:writing-intelligence-commit-rebuild', chapterNumber, session.projectPath)
      if (isProjectSessionCurrent(session)) { setCommit(rebuilt); setGaps(prev => prev.filter(gap => gap.chapterNumber !== chapterNumber)); toast.success(text('事实账本已重建', 'Fact ledger rebuilt')) }
    } catch (error) {
      if (isProjectSessionCurrent(session)) toast.error(text(`重建失败：${String(error)}`, `Rebuild failed: ${String(error)}`))
    } finally { if (isProjectSessionCurrent(session)) setLoading(false) }
  }
  /**
   * 预演（issue #173 建议 ①「写之前给出计数与样本」）：**只读**，一个字节都不写。
   *
   * 存量章节的分类是落库那一刻算的，判据修好之后它们不会自愈（真书 561 条里 148 条不符）——
   * 但也不能静默改账本，所以先给差异。
   */
  const previewRecategorize = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || loading || !commit) return
    setLoading(true)
    try {
      const result = await ipc.invokeWithProjectSession(session, 'db:continuity-recategorize-preview',
        { draftId: commit.draftId, chapterNumber }, session.projectPath) as
        | { success: true, preview: { changed: number, counts: Record<string, number> } }
        | { success: false, error: string } | null
      if (!isProjectSessionCurrent(session)) return
      if (!result?.success) {
        toast.error(text(`检查失败：${result?.error ?? '未知错误'}`, `Check failed: ${result?.error ?? 'unknown'}`))
        return
      }
      setRecategorize(result.preview)
      toast.success(result.preview.changed === 0
        ? text('这一章的分类已经是对的', 'This chapter’s fact categories are already correct')
        : text(`会改 ${result.preview.changed} 条`, `${result.preview.changed} fact(s) would change`))
    } finally { if (isProjectSessionCurrent(session)) setLoading(false) }
  }

  /** 真正落库（作者看过差异之后才点）。 */
  const applyRecategorize = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || loading || !commit) return
    setLoading(true)
    try {
      const result = await ipc.invokeWithProjectSession(session, 'db:continuity-recategorize-chapter',
        { draftId: commit.draftId, chapterNumber }, session.projectPath) as
        | { success: true, receipt: { changed: number } }
        | { success: false, error: string } | null
      if (!isProjectSessionCurrent(session)) return
      if (!result?.success) {
        toast.error(text(`重算失败：${result?.error ?? '未知错误'}`, `Recategorize failed: ${result?.error ?? 'unknown'}`))
        return
      }
      toast.success(text(`已重算 ${result.receipt.changed} 条分类`, `Recategorized ${result.receipt.changed} fact(s)`))
      setRecategorize(null)
      await load()
    } finally { if (isProjectSessionCurrent(session)) setLoading(false) }
  }

  return (
    <InkDialog open={open} onOpenChange={value => { if (!value) onClose() }} title={text(`第 ${chapterNumber} 章事实账本`, `Chapter ${chapterNumber} fact ledger`)} description={text('只记录已经定稿并投影到数据库的事实，不根据当前编辑器正文临时推测。', 'This records only facts committed with finalized prose and projections; it does not infer from the editor buffer.')}
      footer={<><Button variant="secondary" onClick={onClose}>{text('关闭', 'Close')}</Button><Button variant="primary" disabled={loading || currentGap?.status === 'missing-summary'} onClick={() => void rebuild()}><RotateCcw size={13} aria-hidden />{loading ? text('重建中…', 'Rebuilding…') : text('从当前投影重建', 'Rebuild from projections')}</Button></>}>
      {!commit && !loading && currentGap && currentGap.status === 'missing-summary'
        ? <Notice tone="warn" title={text('这一章缺摘要快照，补不了账本', 'This chapter has no summary snapshot, so its ledger cannot be rebuilt')}>{text('账本由「定稿时的正文快照 + 摘要快照」生成。这一章只留下了前一半，直接重建会失败。需要先补跑这一章的摘要，才能补齐账本。', 'The ledger is built from the finalization snapshot plus the summary snapshot. Only the first half was kept for this chapter, so rebuilding fails. Re-run this chapter\'s summary first.')}</Notice>
        : !commit && !loading && <Notice tone="info" title={text('还没有事实账本', 'No fact ledger yet')}>{text('新定稿完成后会自动写入。旧项目如果已经有定稿，可以直接点上面的按钮从当前投影重建。', 'A new finalization records it automatically. If an older project already has a finalized chapter, rebuild it from the current projections with the button above.')}</Notice>}
      {commit && <>
        <StatGrid label={text('账本身份', 'Ledger identity')} items={[
          { id: 'facts', label: text('事实', 'Facts'), value: String(commit.facts.length) },
          { id: 'states', label: text('角色状态', 'Character states'), value: String(commit.characterStates.length) },
          { id: 'threads', label: text('伏笔', 'Foreshadowing'), value: String(commit.foreshadowing.length) },
          { id: 'quality', label: text('质量分', 'Quality'), value: commit.quality.weightedScore.toFixed(1) },
        ]} />
        <p className="stage-ch-sheet-note">{text(`提交于 ${sqliteTime(commit.createdAt).toLocaleString(locale)} · ${commit.finalizationId}`, `Committed ${sqliteTime(commit.createdAt).toLocaleString(locale)} · ${commit.finalizationId}`)}</p>
        {/*
          issue #173：存量分类是落库那一刻算的，判据修好之后不会自愈。
          这里给**先看差异、再决定**的入口 —— 不静默改账本。
        */}
        <details>
          <summary>{text('事实分类（可重算）', 'Fact categories (recomputable)')}</summary>
          <p className="stage-ch-sheet-note">{text(
            '早先定稿的章，事实分类是按当时的判据算的；判据后来修好了，这些章不会自动更新。这里可以按当前判据重算一遍，只改分类，不动事实原文与引文。',
            'Facts finalized earlier were categorized with the rules of that time. When those rules were later fixed, those chapters did not update. Recompute them here with the current rules — only the category changes, never the statement or its quote.')}</p>
          {recategorize ? (
            <ul>
              <li>{text(`会改 ${recategorize.changed} 条`, `${recategorize.changed} fact(s) would change`)}</li>
              {Object.entries(recategorize.counts).map(([pair, count]) => (
                <li key={pair}><code>{pair}</code> × {count}</li>
              ))}
            </ul>
          ) : null}
          <div className="stage-write-actions">
            <Button variant="secondary" size="sm" disabled={loading} onClick={() => void previewRecategorize()}>
              {text('先看重算结果', 'Preview the recompute')}
            </Button>
            {recategorize && recategorize.changed > 0 ? (
              <Button variant="primary" size="sm" disabled={loading} onClick={() => void applyRecategorize()}>
                {text(`重算这 ${recategorize.changed} 条`, `Recategorize these ${recategorize.changed}`)}
              </Button>
            ) : null}
          </div>
        </details>
        <details open><summary>{text('事实', 'Facts')}</summary><ul>{commit.facts.map((fact, index) => <li key={index}><b>{fact.kind}</b>{fact.statement}<q>{fact.evidence}</q></li>)}</ul></details>
        <details><summary>{text('角色状态', 'Character states')}</summary><pre>{JSON.stringify(commit.characterStates, null, 2)}</pre></details>
        <details><summary>{text('伏笔', 'Foreshadowing')}</summary><pre>{JSON.stringify(commit.foreshadowing, null, 2)}</pre></details>
      </>}
    </InkDialog>
  )
}
