import { useCallback, useEffect, useState } from 'react'
import { Sparkles, Trash2 } from 'lucide-react'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
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
  // 面板自己跟踪运行中状态：宿主忘了回传也不会让按钮看起来没反应。
  const [busyInternal, setBusyInternal] = useState(false)
  const busy = reviewBusy || busyInternal

  const loadLatest = useCallback(async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionCurrent(session)) return
    const latest = await ipc.invokeWithProjectSession(session, 'db:stage-review-latest', target, projectKey).catch(() => null)
    if (latest && typeof latest === 'object' && 'findings' in latest) setRun(latest as StageReviewRunRecord)
  }, [projectKey, target])

  useEffect(() => { void Promise.resolve().then(loadLatest).catch(() => {}) }, [loadLatest])

  /**
   * 检查是异步工作流：launch 只代表登记成功，结果要等运行结束才落库。
   * 不等待就立刻重读，作者会看到「还没有检查结果」，以为按钮没反应。
   */
  const waitForReviewRun = useCallback(async (runId: string) => {
    for (let attempt = 0; attempt < 1800; attempt += 1) {
      const state = useWorkflowStore.getState()
      const run = state.activeRuns.find(item => item.id === runId) ?? state.history.find(item => item.id === runId)
      if (run?.status === 'completed') return
      if (run?.status === 'failed') {
        throw new Error(run.error || text('检查失败', 'The review failed.'))
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    throw new Error(text('检查超时，请到任务中心查看。', 'Timed out waiting for the review. Check the task center.'))
  }, [text])

  const start = useCallback(async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionCurrent(session)) { setError(text('项目已切换，请重新打开这本书。', 'The project changed. Reopen the book.')); return }
    setBusyInternal(true)
    onReviewBusyChange(true)
    setError('')
    try {
      const receipt = await launchCreativeWorkflow(launchIntent, session)
      await waitForReviewRun(receipt.runId)
      await loadLatest()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyInternal(false)
      onReviewBusyChange(false)
    }
  }, [launchIntent, loadLatest, onReviewBusyChange, text, waitForReviewRun])

  /**
   * 同一条建议的「整段替换文本」只该写一次。接受一条后，把同一目标、同样
   * 替换文本的其他未处理建议一并标记为已接受，否则界面会继续显示一堆
   * 其实已经被这次替换覆盖掉的建议。
   */
  const resolveSiblings = useCallback(async (finding: StageReviewFindingRecord) => {
    if (!run) return
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionCurrent(session)) return
    const siblings = run.findings.filter(other => other.findingId !== finding.findingId
      && other.status === 'open'
      && other.targetIndex === finding.targetIndex
      && other.expectedText === finding.expectedText)
    for (const sibling of siblings) {
      await ipc.invokeWithProjectSession(session, 'db:stage-review-resolve', run.runId, sibling.findingId, 'accepted', projectKey).catch(() => null)
    }
    if (siblings.length > 0) {
      const ids = new Set(siblings.map(sibling => sibling.findingId))
      setRun(previous => previous && { ...previous, findings: previous.findings.map(f => ids.has(f.findingId) ? { ...f, status: 'accepted' } : f) })
    }
  }, [projectKey, run])

  const resolve = useCallback(async (findingId: string, status: 'accepted' | 'ignored') => {
    if (!run) return
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionCurrent(session)) return
    const result = await ipc.invokeWithProjectSession(session, 'db:stage-review-resolve', run.runId, findingId, status, projectKey)
      .catch((cause: unknown) => ({ success: false, error: cause instanceof Error ? cause.message : String(cause) }))
    if (!result?.success) {
      // 状态没写进数据库的话，下次进入卡片会复活；把失败亮出来，卡片保持可重试。
      setError(text('处理建议失败：', 'Could not update the suggestion: ') + String(result?.error ?? ''))
      return
    }
    setRun(previous => previous && { ...previous, findings: previous.findings.map(f => f.findingId === findingId ? { ...f, status } : f) })
  }, [projectKey, run, text])

  const accept = useCallback(async (finding: StageReviewFindingRecord) => {
    setApplying(finding.findingId)
    setError('')
    try {
      const ok = await applyFinding(finding)
      if (ok) {
        await resolveSiblings(finding)
        await resolve(finding.findingId, 'accepted')
      }
      else setError(text('写回原文失败，建议保持不变。', 'Could not write the change back; the suggestion is unchanged.'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setApplying(null)
    }
  }, [applyFinding, resolve, resolveSiblings, text])

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
    const result = await ipc.invokeWithProjectSession(session, 'db:stage-review-remove', target, projectKey)
      .catch((cause: unknown) => ({ success: false, error: cause instanceof Error ? cause.message : String(cause) }))
    if (!result?.success) {
      // 静默吞掉失败会让人以为清掉了，切个页面记录又回来；必须把失败亮出来。
      setError(text('清掉记录失败：', 'Could not clear the review record: ') + String(result?.error ?? ''))
      return
    }
    setRun(null)
  }, [projectKey, run, target, text])

  const findings = run?.findings ?? []
  // 只展示还没处理的建议：接受或忽略之后它就该从页面上消失。
  const openFindings = findings.filter(finding => finding.status === 'open')
  const openCount = openFindings.length
  const handledCount = findings.length - openCount

  return (
    <div className="arch-arc-review-panel" data-target={target}>
      <div className="arch-arc-review-head">
        <strong>
          {text('AI 检查', 'AI review')}
          {openCount > 0 && <span className="arch-arc-review-count">
            {text(`${openCount} 条待处理`, `${openCount} open ${pluralEn(openCount, 'suggestion')}`)}
          </span>}
          {openCount === 0 && handledCount > 0 && <span className="arch-arc-review-count">
            {text(`${handledCount} 条已处理`, `${handledCount} handled`)}
          </span>}
        </strong>
        <span className="arch-arc-review-head-actions">
          <Button variant="secondary" size="sm" disabled={busy || !canReview} onClick={() => { void start() }} title={text('把所选内容交给 AI 检查', 'Send the selection to AI for review')}>
            <Sparkles size={14} aria-hidden />{reviewBusy ? text('检查中…', 'Reviewing…') : text('开始检查', 'Review')}
          </Button>
          {openCount > 0 && (
            <Button variant="secondary" size="sm" disabled={applying !== null} onClick={() => { void acceptAll() }}>
              {applying === 'all' ? text('应用中…', 'Applying…') : text('全部接受', 'Accept all')}
            </Button>
          )}
          {findings.length > 0 && (
            <Button variant="text" size="sm" disabled={applying !== null} onClick={() => { void remove() }} title={text('清掉这次检查的记录', 'Clear this review record')}>
              <Trash2 size={14} aria-hidden />{text('清掉记录', 'Clear')}
            </Button>
          )}
        </span>
      </div>
      {footer && <div className="arch-arc-review-scope">{footer}</div>}
      {error && <p className="arch-arc-review-error" role="alert">{error}</p>}
      {busy && (
        <p className="arch-arc-review-empty" role="status">
          {text('正在检查，结果会在完成后自动出现…', 'Reviewing; results appear automatically when it finishes…')}
        </p>
      )}
      {findings.length === 0 && !busy
        ? <p className="arch-arc-review-empty">{text('还没有检查结果。选好范围后点「开始检查」。', 'No review results yet. Pick a range and run the review.')}</p>
        : openFindings.length === 0 && !busy
          ? <p className="arch-arc-review-empty">{text('这次检查的建议都处理完了。', 'Every suggestion from this review has been handled.')}</p>
          : (
          <ul className="arch-arc-review-list">
            {openFindings.map(finding => (
              <li key={finding.findingId} className="arch-arc-review-item" data-severity={finding.severity} data-status={finding.status}>
                <div className="arch-arc-review-meta">
                  <span className="arch-arc-review-seg">{target === 'arc'
                    ? text('第 ' + finding.targetIndex + ' 段', 'Segment ' + finding.targetIndex)
                    : text('第 ' + finding.targetIndex + ' 章', 'Chapter ' + finding.targetIndex)}</span>
                  <span className="arch-arc-review-cat">{categoryLabel(text, finding.category)}</span>
                  {finding.severity === 'error' && <span className="arch-arc-review-sev">{text('严重', 'Error')}</span>}
                </div>
                <p className="arch-arc-review-problem">{finding.problemText}</p>
                {finding.expectedText && <pre className="arch-arc-review-expected">{finding.expectedText}</pre>}
                <div className="arch-arc-review-actions">
                  <Button variant="primary" size="sm" disabled={applying !== null || !finding.expectedText.trim()} onClick={() => { void accept(finding) }} title={finding.expectedText.trim() ? undefined : text('这条建议没有给出可写回的文本', 'This suggestion contains no text to write back')}>
                    {applying === finding.findingId ? text('应用中…', 'Applying…') : text('接受', 'Accept')}
                  </Button>
                  <Button variant="text" size="sm" disabled={applying !== null} onClick={() => { void resolve(finding.findingId, 'ignored') }}>
                    {text('忽略', 'Ignore')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}



