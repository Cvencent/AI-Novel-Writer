import { useCallback, useEffect, useState } from 'react'
import { Sparkles, Trash2 } from 'lucide-react'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { ipc } from '../../../services/ipc-client'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'
import { launchCreativeWorkflow, type CreativeIntent } from '../../../services/workflows/creative-workflow-launcher'
import type { StageReviewFindingRecord, StageReviewRunRecord, StageReviewTarget } from '../../../shared/stage-review-types'
import { Button } from '../../ui/Button'
import { pluralEn } from '../../../shared/plural-en'

const CATEGORY_LABELS: Record<string, [string, string]> = {
  plot_logic: ['情节逻辑', 'Plot logic'],
  reveal_pacing: ['揭示节奏', 'Reveal pacing'],
  duplication: ['前后重复', 'Duplication'],
  foreshadowing: ['伏笔', 'Foreshadowing'],
  foreshadowing_and_cost: ['伏笔与代价', 'Foreshadowing & cost'],
  core_outline_consistency: ['核心大纲一致性', 'Core-outline consistency'],
  arc_consistency: ['粗纲方向一致性', 'Arc consistency'],
  worldbuilding_consistency: ['世界观一致性', 'Worldbuilding consistency'],
  character_consistency: ['人物一致性', 'Character consistency'],
  pacing: ['节奏', 'Pacing'],
  prose_quality: ['写法', 'Prose quality'],
  field_completeness: ['字段完整', 'Field completeness'],
  outline_consistency: ['与细纲一致', 'Outline consistency'],
  cost_and_foreshadowing_continuity: ['代价与伏笔连贯', 'Cost & foreshadowing continuity'],
  hook_repetition: ['钩子雷同', 'Hook repetition'],
}

function categoryLabel(text: (zh: string, en: string) => string, category: string): string {
  const label = CATEGORY_LABELS[category]
  return label ? text(label[0], label[1]) : category
}

/**
 * 通用 AI 检查面板：粗纲 / 细纲 / 蓝图共用。
 *
 * 面板自己负责「启动检查 → 读取最近一次结果 → 接受 / 忽略 / 全部接受 / 删除」，
 * 但**不**决定怎么写回原文——写回由宿主通过 applyFinding 提供，因为三层的数据形态不同：
 * 粗纲写 arc_outlines.summary，细纲写 project_core.synopsis，蓝图写 blueprints 字段。
 */
export default function StageReviewPanel({
  projectKey,
  target,
  launchIntent,
  canReview,
  reviewBusy,
  onReviewBusyChange,
  applyFinding,
  footer,
}: {
  projectKey: string
  target: StageReviewTarget
  /** 启动检查的工作流意图，由宿主按层构造（粗纲选段 / 细纲与蓝图选章范围）。 */
  launchIntent: CreativeIntent
  canReview: boolean
  reviewBusy: boolean
  onReviewBusyChange: (busy: boolean) => void
  /** 接受一条建议：宿主负责写回原文并重读内容。返回 false 表示写回失败，卡片保持未处理。 */
  applyFinding: (finding: StageReviewFindingRecord) => Promise<boolean>
  /** 提供范围选择控件等宿主私有 UI。 */
  footer?: React.ReactNode
}) {
  const text = useLocaleStore(s => s.text)
  const [run, setRun] = useState<StageReviewRunRecord | null>(null)
  const [error, setError] = useState('')
  const [applying, setApplying] = useState<string | null>(null)

  const loadLatest = useCallback(async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionCurrent(session)) return
    const latest = await ipc.invokeWithProjectSession(session, 'db:stage-review-latest', target, projectKey).catch(() => null)
    if (latest && typeof latest === 'object' && 'findings' in latest) setRun(latest as StageReviewRunRecord)
  }, [projectKey, target])

  useEffect(() => { void Promise.resolve().then(loadLatest).catch(() => {}) }, [loadLatest])

  const start = useCallback(async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionCurrent(session)) { setError(text('项目已切换，请重新打开这本书。', 'The project changed. Reopen the book.')); return }
    onReviewBusyChange(true)
    setError('')
    try {
      await launchCreativeWorkflow(launchIntent, session)
      await loadLatest()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      onReviewBusyChange(false)
    }
  }, [launchIntent, loadLatest, onReviewBusyChange, text])

  const resolve = useCallback(async (findingId: string, status: 'accepted' | 'ignored') => {
    if (!run) return
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionCurrent(session)) return
    await ipc.invokeWithProjectSession(session, 'db:stage-review-resolve', run.runId, findingId, status, projectKey).catch(() => null)
    setRun(previous => previous && { ...previous, findings: previous.findings.map(f => f.findingId === findingId ? { ...f, status } : f) })
  }, [projectKey, run])

  const accept = useCallback(async (finding: StageReviewFindingRecord) => {
    if (!finding.expectedText.trim()) { await resolve(finding.findingId, 'ignored'); return }
    setApplying(finding.findingId)
    setError('')
    try {
      const ok = await applyFinding(finding)
      if (ok) await resolve(finding.findingId, 'accepted')
      else setError(text('写回原文失败，建议保持不变。', 'Could not write the change back; the suggestion is unchanged.'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setApplying(null)
    }
  }, [applyFinding, resolve, text])

  const acceptAll = useCallback(async () => {
    if (!run) return
    const open = run.findings.filter(f => f.status === 'open' && f.expectedText.trim())
    setApplying('all')
    setError('')
    try {
      for (const finding of open) await applyFinding(finding)
      const session = captureProjectSession(useProjectStore.getState().currentProject)
      if (session && isProjectSessionCurrent(session)) {
        await ipc.invokeWithProjectSession(session, 'db:stage-review-accept-all', run.runId, projectKey).catch(() => null)
      }
      await loadLatest()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setApplying(null)
    }
  }, [applyFinding, loadLatest, projectKey, run])

  const remove = useCallback(async () => {
    if (!run) return
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionCurrent(session)) return
    await ipc.invokeWithProjectSession(session, 'db:stage-review-remove', run.runId, projectKey).catch(() => null)
    setRun(null)
  }, [projectKey, run])

  const findings = run?.findings ?? []
  const openCount = findings.filter(f => f.status === 'open').length

  return (
    <div className="arch-arc-review-panel" data-target={target}>
      <div className="arch-arc-review-head">
        <strong>
          {text('AI 检查', 'AI review')}
          {findings.length > 0 && <span className="arch-arc-review-count">
            {text(`${findings.length} 条建议 · 待处理 ${openCount}`, `${findings.length} ${pluralEn(findings.length, 'suggestion')} · ${openCount} open`)}
          </span>}
        </strong>
        <span className="arch-arc-review-head-actions">
          <Button variant="secondary" size="sm" disabled={reviewBusy || !canReview} onClick={() => { void start() }} title={text('把所选内容交给 AI 检查', 'Send the selection to AI for review')}>
            <Sparkles size={14} aria-hidden />{reviewBusy ? text('检查中…', 'Reviewing…') : text('开始检查', 'Review')}
          </Button>
          {findings.length > 0 && (
            <>
              <Button variant="secondary" size="sm" disabled={openCount === 0 || applying !== null} onClick={() => { void acceptAll() }}>
                {applying === 'all' ? text('应用中…', 'Applying…') : text('全部接受', 'Accept all')}
              </Button>
              <Button variant="text" size="sm" disabled={applying !== null} onClick={() => { void remove() }} title={text('删除这次检查结果', 'Delete this review')}>
                <Trash2 size={14} aria-hidden />{text('删除', 'Delete')}
              </Button>
            </>
          )}
        </span>
      </div>
      {footer && <div className="arch-arc-review-scope">{footer}</div>}
      {error && <p className="arch-arc-review-error" role="alert">{error}</p>}
      {findings.length === 0
        ? <p className="arch-arc-review-empty">{reviewBusy ? text('正在检查…', 'Reviewing…') : text('还没有检查结果。选好范围后点「开始检查」。', 'No review results yet. Pick a range and run the review.')}</p>
        : (
          <ul className="arch-arc-review-list">
            {findings.map(finding => (
              <li key={finding.findingId} className="arch-arc-review-item" data-severity={finding.severity} data-status={finding.status}>
                <div className="arch-arc-review-meta">
                  <span className="arch-arc-review-seg">{text('第 ' + finding.targetIndex + ' 章/段', 'Target ' + finding.targetIndex)}</span>
                  <span className="arch-arc-review-cat">{categoryLabel(text, finding.category)}</span>
                  {finding.severity === 'error' && <span className="arch-arc-review-sev">{text('严重', 'Error')}</span>}
                </div>
                <p className="arch-arc-review-problem">{finding.problemText}</p>
                {finding.expectedText && <pre className="arch-arc-review-expected">{finding.expectedText}</pre>}
                <div className="arch-arc-review-actions">
                  {finding.status === 'open' ? (
                    <>
                      <Button variant="primary" size="sm" disabled={applying !== null} onClick={() => { void accept(finding) }}>
                        {applying === finding.findingId ? text('应用中…', 'Applying…') : text('接受', 'Accept')}
                      </Button>
                      <Button variant="text" size="sm" disabled={applying !== null} onClick={() => { void resolve(finding.findingId, 'ignored') }}>
                        {text('忽略', 'Ignore')}
                      </Button>
                    </>
                  ) : (
                    <span className="arch-arc-review-status">
                      {finding.status === 'accepted' ? text('已接受', 'Accepted') : text('已忽略', 'Ignored')}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}
