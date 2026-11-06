import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { ipc } from '../../../services/ipc-client'
import { Button } from '../../ui/Button'
import { GENERATION_PROMPT_RETENTION } from '../../../shared/generation-log-retention'

/** 日志页里展示的一次模型调用（列表行）。 */
interface ModelCallSummary {
  attemptId: string
  runId: string
  purpose: string
  status: string
  modelName: string
  requestedOutputTokens: number | null
  hasPrompt: boolean
  hasOutput: boolean
  /** 完整 Prompt 已被保留策略清理（曾经有，不是本来就没有）。 */
  promptTrimmed: boolean
  /** 实际消耗 token（issue #233）：settle 时记录，旧记录没有则 null。 */
  actualTokens: number | null
  /** 请求侧 token。 */
  inputTokens: number | null
  /** 收尾原因（stop / length / null）。 */
  finishReason: string | null
  /** 失败码与传输诊断串（无失败为空）。 */
  failureDetail: string
  /** attempt 级耗时毫秒（issue #233 建议②）；旧记录没有则 null。 */
  elapsedMs: number | null
}

/** 状态列的人话映射（issue #233）：内部值直接显示会让「没记录收尾」读成术语。 */
function statusLabel(status: string, text: (zh: string, en: string) => string): string {
  if (status === 'settled') return text('完成', 'Settled')
  if (status === 'unknown') return text('没有收尾记录', 'No settle record')
  return status
}

/** 展开后的完整详情。 */
interface ModelToolCallDetail {
  name: string
  arguments: Record<string, unknown>
  result: string
}

interface ModelCallDetail extends ModelCallSummary {
  promptMessages: { role: string; content: string }[]
  output: string
  toolCalls: ModelToolCallDetail[]
}

const PAGE_SIZE = 100

/**
 * 详情来自持久化日志，字段可能缺失或类型不对（旧记录、坏行）。
 * 这里归一化成渲染需要的形状，缺字段只让对应区块不显示，不让整页崩。
 */
function normalizeDetail(raw: unknown): ModelCallDetail | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Partial<ModelCallDetail>
  const messages = Array.isArray(record.promptMessages)
    ? record.promptMessages.filter(message => message && typeof message.content === 'string')
    : []
  const tools = Array.isArray(record.toolCalls)
    ? record.toolCalls.filter(tool => tool && typeof tool.name === 'string')
    : []
  return {
    attemptId: String(record.attemptId ?? ''),
    runId: String(record.runId ?? ''),
    purpose: String(record.purpose ?? ''),
    status: String(record.status ?? 'unknown'),
    modelName: String(record.modelName ?? ''),
    requestedOutputTokens: typeof record.requestedOutputTokens === 'number' ? record.requestedOutputTokens : null,
    actualTokens: typeof record.actualTokens === 'number' ? record.actualTokens : null,
    inputTokens: typeof record.inputTokens === 'number' ? record.inputTokens : null,
    finishReason: typeof record.finishReason === 'string' && record.finishReason ? record.finishReason : null,
    failureDetail: typeof record.failureDetail === 'string' ? record.failureDetail : '',
    elapsedMs: typeof record.elapsedMs === 'number' ? record.elapsedMs : null,
    hasPrompt: messages.length > 0,
    hasOutput: typeof record.output === 'string' && record.output.length > 0,
    promptTrimmed: record.promptTrimmed === true,
    promptMessages: messages,
    output: typeof record.output === 'string' ? record.output : '',
    toolCalls: tools.map(tool => ({
      name: tool.name,
      arguments: tool.arguments && typeof tool.arguments === 'object' ? tool.arguments : {},
      result: typeof tool.result === 'string' ? tool.result : '',
    })),
  }
}

/**
 * 生成日志页：列出每次模型调用，可展开查看完整 Prompt 与返回。
 *
 * Prompt 是数据库里已有的持久化数据（generation_attempts.usage_receipt_json
 * 的 replayTask），返回文本来自 generation_artifacts。本页只读，只在本地展示。
 */
export default function StageLogs() {
  const text = useLocaleStore(s => s.text)
  const projectPath = useProjectStore(s => s.currentProject?.path)
  const sessionLease = useProjectStore(s => s.currentProject?.sessionLease)
  const [calls, setCalls] = useState<ModelCallSummary[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [detail, setDetail] = useState<ModelCallDetail | null>(null)
  /** 展开的那一行是否还在读详情：读完了仍没有详情就是「没有记录」，不能一直显示「正在读取」。 */
  const [detailLoading, setDetailLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!projectPath) return
    try {
      const list = await ipc.invoke('db:generation-log-list', PAGE_SIZE, projectPath)
      // issue #233：主进程新字段（actualTokens 等）在旧记录/测试 mock 里可能缺失——
      // 统一归一成 null，渲染层的数字方法不会撞 undefined。
      setCalls((Array.isArray(list) ? list as ModelCallSummary[] : []).map(call => ({
        ...call,
        actualTokens: typeof call?.actualTokens === 'number' ? call.actualTokens : null,
        inputTokens: typeof call?.inputTokens === 'number' ? call.inputTokens : null,
        finishReason: typeof call?.finishReason === 'string' ? call.finishReason : null,
        failureDetail: typeof call?.failureDetail === 'string' ? call.failureDetail : '',
        elapsedMs: typeof call?.elapsedMs === 'number' ? call.elapsedMs : null,
      })))
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    setLoading(false)
  }, [projectPath])

  // 挂载与切换作品时读取日志；load 内部只做远端读取后的 setState。
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load, sessionLease])

  const toggle = async (attemptId: string) => {
    if (expanded === attemptId) { setExpanded(null); setDetail(null); setDetailLoading(false); return }
    setExpanded(attemptId)
    setDetail(null)
    if (!projectPath) return
    setDetailLoading(true)
    const full = await ipc.invoke('db:generation-log-read', attemptId, projectPath).catch(() => null)
    setDetail(normalizeDetail(full))
    setDetailLoading(false)
  }

  if (!projectPath) {
    return <div className="stage-logs-empty">{text('打开一部作品后可以查看生成日志。', 'Open a book to view generation logs.')}</div>
  }

  return (
    <div className="stage-logs">
      <header className="stage-logs-head">
        <div>
          <h1 className="stage-logs-title">{text('生成日志', 'Generation logs')}</h1>
          <p className="stage-logs-lede">
            {text('每次模型调用的完整 Prompt 与返回，只在本地保存和展示。', 'Full prompts and responses for every model call, stored and shown locally only.')}
          </p>
        </div>
        <Button variant="text" size="sm" onClick={() => { setExpanded(null); setDetail(null); setDetailLoading(false); void load() }}>
          {text('刷新', 'Refresh')}
        </Button>
      </header>

      {error && <p className="stage-logs-error" role="alert">{error}</p>}
      {loading && <p className="stage-logs-empty">{text('正在读取…', 'Loading…')}</p>}
      {!loading && calls.length === 0 && (
        <p className="stage-logs-empty">{text('还没有模型调用记录。生成大纲或正文后，这里会出现每次调用的 Prompt 与返回。', 'No model calls yet. After generating outlines or drafts, each call\u2019s prompt and response appears here.')}</p>
      )}

      <ol className="stage-logs-list">
        {calls.map(call => {
          const open = expanded === call.attemptId
          return (
            <li key={call.attemptId} className="stage-logs-item" data-open={open || undefined}>
              <button type="button" className="stage-logs-row" aria-expanded={open} onClick={() => void toggle(call.attemptId)}>
                {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                <span className="stage-logs-purpose">{call.purpose || text('（无阶段）', '(no stage)')}</span>
                <span className="stage-logs-status" data-status={call.status}>{statusLabel(call.status, text)}</span>
                {call.modelName && <span className="stage-logs-model">{call.modelName}</span>}
                {/*
                  issue #233：token 列原来是「申请上限」——100 行全是 32768，等于没有信息。
                  改成「实际 / 上限」；实际值缺失（旧记录）时只显示上限并标注「申请」。
                */}
                {call.actualTokens !== null && call.requestedOutputTokens !== null
                  ? <span className="stage-logs-tokens">{call.actualTokens.toLocaleString()} / {call.requestedOutputTokens.toLocaleString()} tok</span>
                  : call.requestedOutputTokens !== null
                    ? <span className="stage-logs-tokens" title={text('实际用量未记录，这是申请的输出上限', 'Actual usage not recorded; this is the requested cap')}>{text('申请', 'Cap')} {call.requestedOutputTokens.toLocaleString()} tok</span>
                    : null}
                {call.promptTrimmed && <span className="stage-logs-row-trimmed">{text('Prompt 已清理', 'Prompt trimmed')}</span>}
              </button>
              {open && (
                <div className="stage-logs-detail">
                  {!detail && detailLoading && <p className="stage-logs-empty">{text('正在读取这次调用…', 'Loading this call…')}</p>}
                  {!detail && !detailLoading && <p className="stage-logs-empty">{text('这条调用没有可显示的记录。', 'No record available for this call.')}</p>}
                  {detail && (
                    <>
                      {/*
                        issue #233：失败原因/收尾原因/实际用量——库里一直有
                        （usage_receipt_json.result），详情页从没显示过。作者要回答
                        「为什么没出东西」时，「推理吃满预算」与「网关连不上」该做的
                        动作完全相反，必须在最上面看到。
                      */}
                      {detail.failureDetail && (
                        <p className="stage-logs-trimmed" role="alert">
                          <strong>{text('失败：', 'Failed: ')}</strong><code>{detail.failureDetail}</code>
                        </p>
                      )}
                      <p className="stage-logs-trimmed">
                        {detail.actualTokens !== null && text(`实际消耗 ${detail.actualTokens.toLocaleString()} token（申请上限 ${call.requestedOutputTokens?.toLocaleString() ?? '—'}）。`, `Actual usage ${detail.actualTokens.toLocaleString()} tokens (requested cap ${call.requestedOutputTokens?.toLocaleString() ?? '—'}).`)}
                        {detail.actualTokens === null && text('这条记录没有实际用量数据（旧版本不记录）。', 'No actual usage recorded for this call (older versions did not record it).')}
                        {detail.elapsedMs !== null && text(`耗时 ${(detail.elapsedMs / 1000).toFixed(1)} 秒。`, `Took ${(detail.elapsedMs / 1000).toFixed(1)}s.`)}
                        {detail.finishReason && text(`收尾原因：${detail.finishReason === 'length' ? '输出/推理撞到上限被截断' : detail.finishReason === 'stop' ? '正常结束' : detail.finishReason}。`, `Finish reason: ${detail.finishReason}.`)}
                        {detail.finishReason === 'length' && !detail.output && text('推理把输出预算吃满、正文一个字都没输出——换更小的任务或限制推理预算。', 'Reasoning consumed the whole output budget with no response text — try a smaller task or cap reasoning.')}
                      </p>
                      {detail.promptTrimmed && (
                        <p className="stage-logs-trimmed">
                          {text(
                            '这次调用的完整 Prompt 已按保留策略清理（只保留最近 ' + GENERATION_PROMPT_RETENTION + ' 次）。返回文本、模型与用途仍然完整。',
                            "This call's full prompt was trimmed by the retention policy (only the most recent " + GENERATION_PROMPT_RETENTION + ' calls keep prompts). The response, model and purpose are still complete.',
                          )}
                        </p>
                      )}
                      {!detail.promptTrimmed && detail.promptMessages.length === 0 && (
                        <p className="stage-logs-empty">{text('这次调用没有记录 Prompt。', 'No prompt was recorded for this call.')}</p>
                      )}
                      {detail.promptMessages.length > 0 && (
                        <section className="stage-logs-prompt">
                          <h2>{text('完整 Prompt', 'Full prompt')}</h2>
                          {detail.promptMessages.map((message, index) => (
                            <div key={index} className="stage-logs-message">
                              <span className="stage-logs-role">{message.role}</span>
                              <pre className="stage-logs-text">{message.content}</pre>
                            </div>
                          ))}
                        </section>
                      )}
                      {detail.toolCalls.length > 0 && (
                        <section className="stage-logs-tools">
                          <h2>{text('工具调用', 'Tool calls')}</h2>
                          <ol className="stage-logs-tool-list">
                            {detail.toolCalls.map((tool, index) => (
                              <li key={index} className="stage-logs-tool">
                                <div className="stage-logs-tool-head">
                                  <span className="stage-logs-tool-name">{tool.name}</span>
                                </div>
                                <pre className="stage-logs-text">{JSON.stringify(tool.arguments, null, 2)}</pre>
                                <span className="stage-logs-role">{text('返回', 'Result')}</span>
                                <pre className="stage-logs-text">{tool.result || text('（没有返回记录）', '(no result recorded)')}</pre>
                              </li>
                            ))}
                          </ol>
                        </section>
                      )}
                      <section className="stage-logs-output">
                        <h2>{text('完整返回', 'Full response')}</h2>
                        <pre className="stage-logs-text">{detail.output || text('（这次调用没有返回文本）', '(no response text for this call)')}</pre>
                      </section>
                    </>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ol>

      {calls.length > 0 && (
        <p className="stage-logs-note">
          <Trash2 size={12} aria-hidden />
          {text('日志为只读投影，删除记录请使用设置里的项目清理。', 'Logs are a read-only projection; use project cleanup in Settings to remove records.')}
        </p>
      )}
    </div>
  )
}
