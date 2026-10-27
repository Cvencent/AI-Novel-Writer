import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Copy, Lock, Trash2 } from 'lucide-react'
import type { LLMCallRecord } from '../../../services/stats-service'
import { sqliteTime } from '../../../shared/sqlite-time'
import { useLocaleStore } from '../../../stores/locale-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { useProjectStore } from '../../../stores/project-store'
import { useLLMStore } from '../../../stores/llm-store'
import { ipc } from '../../../services/ipc-client'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import { globalEventBus } from '../../../shared/event-bus'
import { estimateUsageCost, type DraftQualityReview } from '../../../shared/writing-intelligence'
import { copySafeDiagnostic, useModelCalls } from '../../run/use-model-calls'
import { Button } from '../../ui/Button'
import { Check } from '../../ui/Check'
import { InlineConfirm } from '../../ui/InlineConfirm'
import { StatGrid } from '../../ui/StatGrid'
import { callPurpose, clockTime, compactNumber } from './run-format'
import { pluralEn } from '../../../shared/plural-en'

type Text = (zh: string, en: string) => string

const LEVEL_TEXT: Record<'info' | 'warn' | 'error', [string, string]> = {
  info: ['信息', 'Info'],
  warn: ['提醒', 'Warning'],
  error: ['失败', 'Error'],
}

/** 诊断分页（宽版侧页）：日志与 AI 调用记录，只用于排查问题。 */
export function RunDiagnostics() {
  const text = useLocaleStore(s => s.text)
  return (
    <div className="run-diagnostics">
      <p className="run-note">{text(`诊断信息只用于排查问题，不影响写作 · 版本 ${__APP_VERSION__}`, `Diagnostics are for troubleshooting only and do not affect writing · version ${__APP_VERSION__}`)}</p>
      <RunLog text={text} />
      <ModelCallLog text={text} />
    </div>
  )
}

function RunLog({ text }: { text: Text }) {
  const logs = useWorkflowStore(s => s.globalLogs)
  const [follow, setFollow] = useState(true)
  const [confirming, setConfirming] = useState(false)
  const clearButton = useRef<HTMLButtonElement>(null)
  const box = useRef<HTMLOListElement>(null)
  const titleId = useId()

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [logs, follow])

  return (
    <section className="run-section" aria-labelledby={titleId}>
      <header className="run-section-head">
        <h3 id={titleId} className="run-section-title">{text('日志', 'Log')}</h3>
        <Check kind="switch" checked={follow} onChange={setFollow} label={text('自动滚动', 'Auto-scroll')} />
        <Button ref={clearButton} variant="text" size="sm" disabled={logs.length === 0 || confirming} onClick={() => setConfirming(true)}>
          <Trash2 size={14} aria-hidden />{text('清空日志…', 'Clear log…')}
        </Button>
      </header>
      {confirming && (
        <InlineConfirm
          message={text(`清空后这 ${logs.length} 行日志无法找回。`, `Clearing removes the ${logs.length} log ${pluralEn(logs.length, 'line')} for good.`)}
          confirmLabel={text('清空', 'Clear')}
          cancelLabel={text('保留', 'Keep')}
          onConfirm={() => { setConfirming(false); useWorkflowStore.getState().clearLogs() }}
          onCancel={() => setConfirming(false)}
          returnFocusRef={clearButton}
        />
      )}
      {logs.length === 0
        ? <p className="run-empty-line">{text('还没有日志。', 'No log yet.')}</p>
        : (
          <ol ref={box} className="run-log" aria-label={text('日志内容', 'Log lines')}>
            {logs.map((line, index) => (
              <li key={index} className="run-log-line" data-level={line.level}>
                <span className="run-log-time">{line.time}</span>
                <span className="run-log-level">{text(...LEVEL_TEXT[line.level])}</span>
                <span className="run-log-message">{line.message}</span>
              </li>
            ))}
          </ol>
        )}
    </section>
  )
}

function ModelCallLog({ text }: { text: Text }) {
  const locale = useLocaleStore(s => s.locale)
  const { stats, history, workflowFor } = useModelCalls()
  const models = useLLMStore(s => s.models)
  const project = useProjectStore(s => s.currentProject)
  const [qualityReviews, setQualityReviews] = useState<DraftQualityReview[]>([])
  const qualityRequest = useRef(0)
  const qualitySession = useMemo(() => projectSessionContextFromProject(project), [project])
  const loadQuality = useCallback((session = captureProjectSession(useProjectStore.getState().currentProject)) => {
    if (!session) return
    const revision = ++qualityRequest.current
    void ipc.invokeWithProjectSession(session, 'db:writing-intelligence-quality-list', undefined, session.projectPath)
      .then(reviews => { if (isProjectSessionCurrent(session) && revision === qualityRequest.current) setQualityReviews(reviews) })
      .catch(() => { if (isProjectSessionCurrent(session) && revision === qualityRequest.current) setQualityReviews([]) })
  }, [])

  useEffect(() => { loadQuality() }, [loadQuality, qualitySession])
  // A finished review writes a new quality row; refresh so the diagnostics tab shows it.
  useEffect(() => globalEventBus.on('WORKFLOW_COMPLETE', ({ projectSession }) => {
    const current = captureProjectSession(useProjectStore.getState().currentProject)
    if (!current || !sameProjectSessionContext(projectSession, current)) return
    loadQuality()
  }), [loadQuality])

  // Each call contributes one of three outcomes: a real cost, or a specific
  // reason it cannot be priced — no usage reported, no model price, or a failed call.
  const costed = useMemo(() => history.map(call => {
    const model = models.find(candidate => candidate.id === call.modelId)
      ?? models.find(candidate => candidate.name === call.modelName || candidate.modelName === call.modelName)
    const value = estimateUsageCost({
      promptTokens: call.promptTokens, completionTokens: call.completionTokens,
      inputPerMillion: model?.inputPricePerMillion, outputPerMillion: model?.outputPricePerMillion,
    })
    if (value !== null) return { call, value, reason: null as null }
    const reason: 'failed' | 'usage' | 'price' = !call.success && call.promptTokens === null && call.completionTokens === null
      ? 'failed'
      : (call.promptTokens === null || call.completionTokens === null ? 'usage' : 'price')
    return { call, value: null, reason }
  }), [history, models])
  const knownCosts = costed.filter(entry => entry.value !== null)
  const totalCost = knownCosts.reduce((sum, entry) => sum + (entry.value ?? 0), 0)
  const missingUsage = costed.filter(entry => entry.reason === 'usage').length
  const missingPrice = costed.filter(entry => entry.reason === 'price').length
  const failedWithoutUsage = costed.filter(entry => entry.reason === 'failed').length
  const costHint = (() => {
    const parts: string[] = []
    if (missingUsage > 0) parts.push(text(`${missingUsage} 次未上报用量`, `${missingUsage} ${pluralEn(missingUsage, 'call')} without usage`))
    if (missingPrice > 0) parts.push(text(`${missingPrice} 次模型缺价格`, `${missingPrice} ${pluralEn(missingPrice, 'call')} with no model price`))
    if (failedWithoutUsage > 0) parts.push(text(`${failedWithoutUsage} 次调用失败且无用量`, `${failedWithoutUsage} failed ${pluralEn(failedWithoutUsage, 'call')} with no usage`))
    return parts.length > 0 ? parts.join(' · ') : undefined
  })()
  const averageQuality = qualityReviews.length > 0
    ? qualityReviews.reduce((sum, review) => sum + review.weightedScore, 0) / qualityReviews.length : null
  const count = (value: number | null) => compactNumber(value, locale)
  const titleId = useId()
  return (
    <section className="run-section" aria-labelledby={titleId}>
      <header className="run-section-head">
        <h3 id={titleId} className="run-section-title">{text('AI 调用记录', 'AI calls')}</h3>
        <p className="run-section-aside"><Lock size={12} aria-hidden />{text('安全诊断不含正文和密钥', 'Safe diagnostics exclude your text and keys')}</p>
      </header>
      {stats && (
        <StatGrid label={text('调用统计', 'Call summary')} items={[
          { id: 'calls', label: text('调用次数', 'Calls'), value: count(stats.totalCalls) },
          { id: 'input', label: text('输入用量', 'Input usage'), value: count(stats.totalPromptTokens) },
          { id: 'output', label: text('输出用量', 'Output usage'), value: count(stats.totalCompletionTokens),
            hint: stats.knownUsageCalls < stats.totalCalls ? text(`${stats.totalCalls - stats.knownUsageCalls} 次未上报用量`, `${stats.totalCalls - stats.knownUsageCalls} ${pluralEn(stats.totalCalls - stats.knownUsageCalls, 'call')} without usage`) : undefined },
          { id: 'cost', label: text('估算费用', 'Estimated cost'), value: knownCosts.length > 0 ? `$${totalCost.toFixed(4)}` : '—', hint: costHint },
          { id: 'quality', label: text('平均质量分', 'Average quality'), value: averageQuality === null ? '—' : averageQuality.toFixed(1) },
          { id: 'failed', label: text('失败', 'Failed'), value: count(stats.failedCalls) },
        ]} />
      )}
      {qualityReviews.length > 0 && (
        <details className="run-quality-review">
          <summary>{text(`质量评分记录 ${qualityReviews.length} 份`, `${qualityReviews.length} quality reviews`)}</summary>
          <div className="run-table-frame">
            <table className="run-table">
              <thead><tr><th scope="col">{text('章节', 'Chapter')}</th><th scope="col">{text('草稿', 'Draft')}</th><th scope="col" data-align="end">{text('总分', 'Score')}</th><th scope="col" data-align="end">{text('阻断', 'Blocking')}</th><th scope="col">{text('时间', 'Time')}</th></tr></thead>
              <tbody>{qualityReviews.map(review => <tr key={review.draftId}><td>{text(`第 ${review.chapterNumber} 章`, `Chapter ${review.chapterNumber}`)}</td><td>#{review.draftId}</td><td data-align="end">{review.weightedScore.toFixed(1)}</td><td data-align="end">{review.blockingCount}</td><td>{new Date(review.reviewedAt).toLocaleString(locale)}</td></tr>)}</tbody>
            </table>
          </div>
        </details>
      )}
      {history.length === 0
        ? <p className="run-empty-line">{text('还没有调用记录。', 'No AI calls yet.')}</p>
        : (
          <div className="run-table-frame">
            <table className="run-table">
              <thead>
                <tr>
                  <th scope="col">{text('时间', 'Time')}</th>
                  <th scope="col">{text('用途', 'Purpose')}</th>
                  <th scope="col">{text('模型', 'Model')}</th>
                  <th scope="col" data-align="end">{text('输入', 'Input')}</th>
                  <th scope="col" data-align="end">{text('输出', 'Output')}</th>
                  <th scope="col" data-align="end">{text('耗时', 'Time taken')}</th>
                  <th scope="col">{text('状态', 'Status')}</th>
                  <th scope="col"><span className="run-visually-hidden">{text('诊断', 'Diagnostics')}</span></th>
                </tr>
              </thead>
              <tbody>
                {history.map(call => <CallRow key={call.id} call={call} text={text} onCopy={() => void copySafeDiagnostic(call, workflowFor(call), locale)} />)}
              </tbody>
            </table>
          </div>
        )}
    </section>
  )
}

function CallRow({ call, text, onCopy }: { call: LLMCallRecord; text: Text; onCopy: () => void }) {
  const locale = useLocaleStore(s => s.locale)
  const usage = (value: number | null) => value === null ? '—' : value.toLocaleString(locale)
  return (
    <tr>
      <td className="run-table-num">{clockTime(sqliteTime(call.createdAt), locale)}</td>
      <td>{callPurpose(call.purpose, text)}</td>
      <td>{call.modelName || '—'}</td>
      <td className="run-table-num" data-align="end">{usage(call.promptTokens)}</td>
      <td className="run-table-num" data-align="end">{usage(call.completionTokens)}</td>
      <td className="run-table-num" data-align="end">{text(`${(call.durationMs / 1000).toFixed(1)} 秒`, `${(call.durationMs / 1000).toFixed(1)}s`)}</td>
      <td><span className="run-badge" data-tone={call.success ? 'ok' : 'danger'}>{call.success ? text('成功', 'OK') : text('失败', 'Failed')}</span></td>
      <td data-align="end">
        <Button variant="icon" size="sm" aria-label={text('复制安全诊断', 'Copy safe diagnostics')} title={text('复制安全诊断', 'Copy safe diagnostics')} onClick={onCopy}>
          <Copy size={14} aria-hidden />
        </Button>
      </td>
    </tr>
  )
}
