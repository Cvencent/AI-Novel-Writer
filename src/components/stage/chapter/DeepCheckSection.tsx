import { useCallback, useEffect, useState } from 'react'
import { ScrollText, Trash2 } from 'lucide-react'
import { ipc } from '../../../services/ipc-client'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { globalEventBus } from '../../../shared/event-bus'
import type { StageReviewFindingRecord, StageReviewRunRecord } from '../../../shared/stage-review-types'
import { Button } from '../../ui/Button'

/**
 * 正文深度检查的发现（issue #245 现场）。
 *
 * 定稿审稿会带着「深度检查」一起跑（`#229`：模型判据的家在定稿审稿）。那些维度产出的是
 * **正文层**发现——物证链、跨章重复、期限、日期一类——它们没有可机械写回的「替换文本」，
 * 只能由作者读完后自己改。所以这里**只读**：列出发现、可逐条复制、可忽略；不提供「接受」，
 * 因为接受意味着写回原文，而这些发现给不出替换文本（`StageReviewPanel` 对这类行的接受
 * 按钮本来就禁用，这里直接用更贴切的形态）。
 *
 * 为什么需要它：原先 findings 只写进 `WorkflowStep.logs`，而那个字段**全仓无人渲染**，
 * 于是深度检查跑 1 分 49 秒、13 次模型调用全部成功，作者却一个字都看不见，只能靠切页碰运气。
 */
export default function DeepCheckSection({ chapterNumber }: { chapterNumber: number }) {
  const text = useLocaleStore(s => s.text)
  const target = 'chapter' as const
  const [run, setRun] = useState<StageReviewRunRecord | null>(null)
  const [error, setError] = useState('')

  const loadLatest = useCallback(async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionCurrent(session)) return
    const latest = await ipc.invokeWithProjectSession(session, 'db:stage-review-latest', target, session.projectPath).catch(() => null)
    // 只看这一章的记录：`stage_review_*` 的 target 只区分「层」，同一层里多章的检查会互相覆盖显示。
    const forChapter = latest && Array.isArray(latest.findings)
      ? (latest as StageReviewRunRecord).findings.some(finding => finding.targetIndex === chapterNumber) ? latest as StageReviewRunRecord : null
      : null
    setRun(latest ? forChapter : null)
  }, [chapterNumber])

  useEffect(() => { void Promise.resolve().then(loadLatest).catch(() => {}) }, [loadLatest])

  /**
   * 工作流结束时重读。
   *
   * 这是「不必切页就能看到」的关键：`use-draft-actions` 的 `WORKFLOW_COMPLETE` 只重读
   * 审稿记录与待合并修稿，深度检查的落地面是另一张表，没人通知就会一直显示旧内容。
   *
   * ⚠️ 监听 `WORKFLOW_SETTLED` 而不是 `WORKFLOW_COMPLETE`（issue #245 现场）：
   * 深度检查失败时工作流只发 SETTLED、不发 COMPLETE，只听 COMPLETE 会让
   * 「失败」和「还没跑」在界面上长得一模一样——作者以为没问题。
   */
  useEffect(() => globalEventBus.on('WORKFLOW_SETTLED', () => { void loadLatest() }), [loadLatest])

  const ignore = useCallback(async (finding: StageReviewFindingRecord) => {
    if (!run) return
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionCurrent(session)) return
    const result = await ipc.invokeWithProjectSession(session, 'db:stage-review-resolve', run.runId, finding.findingId, 'ignored', session.projectPath)
      .catch((cause: unknown) => ({ success: false, error: cause instanceof Error ? cause.message : String(cause) }))
    if (!result?.success) { setError(text('处理失败：', 'Could not update: ') + String(result?.error ?? '')); return }
    setRun(previous => previous && { ...previous, findings: previous.findings.map(item => item.findingId === finding.findingId ? { ...item, status: 'ignored' } : item) })
  }, [run, text])

  const copy = useCallback((finding: StageReviewFindingRecord) => {
    // 没有写回通道，作者要的下一步就是把这处发现抄去改稿。
    void navigator.clipboard?.writeText(finding.problemText).catch(() => {})
  }, [])

  const remove = useCallback(async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionCurrent(session)) return
    const result = await ipc.invokeWithProjectSession(session, 'db:stage-review-remove', target, session.projectPath)
      .catch((cause: unknown) => ({ success: false, error: cause instanceof Error ? cause.message : String(cause) }))
    if (!result?.success) { setError(text('清掉记录失败：', 'Could not clear: ') + String(result?.error ?? '')); return }
    setRun(null)
  }, [text])

  const open = (run?.findings ?? []).filter(finding => finding.status === 'open' && finding.targetIndex === chapterNumber)
  if (open.length === 0) return null

  return (
    <section className="arch-arc-review-panel" data-target="chapter" aria-label={text('深度检查发现', 'Deep-check findings')}>
      <div className="arch-arc-review-head">
        <strong>
          <ScrollText size={14} aria-hidden />{' '}
          {text('深度检查', 'Deep checks')}
          <span className="arch-arc-review-count">{text(`${open.length} 条待处理`, `${open.length} open`)}</span>
        </strong>
        <span className="arch-arc-review-head-actions">
          <Button variant="text" size="sm" onClick={() => { void remove() }} title={text('清掉本章的深度检查记录', 'Clear this chapter’s deep-check record')}>
            <Trash2 size={14} aria-hidden />{text('清掉记录', 'Clear')}
          </Button>
        </span>
      </div>
      <p className="arch-arc-review-empty">
        {text('这些是随审稿一起跑的正文层核对。它们没有可直接写回的替换文本——读完复制后自己改，或直接忽略。',
          'These ran with the review and are prose-level findings. They carry no text to write back: read, copy, and edit as you see fit, or ignore them.')}
      </p>
      {error && <p className="arch-arc-review-error" role="alert">{error}</p>}
      <ul className="arch-arc-review-list">
        {open.map(finding => (
          <li key={finding.findingId} className="arch-arc-review-item" data-severity={finding.severity} data-status={finding.status}>
            <p className="arch-arc-review-problem">{finding.problemText}</p>
            <div className="arch-arc-review-actions">
              <Button variant="secondary" size="sm" onClick={() => copy(finding)}>{text('复制', 'Copy')}</Button>
              <Button variant="text" size="sm" onClick={() => { void ignore(finding) }}>{text('忽略', 'Ignore')}</Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
