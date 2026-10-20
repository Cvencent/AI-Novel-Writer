import type BetterSqlite3 from 'better-sqlite3'
import { getProjectDb } from '../database'

/** 一次模型调用的日志摘要（列表用）。 */
export interface ModelCallSummary {
  attemptId: string
  runId: string
  purpose: string
  status: string
  modelName: string
  requestedOutputTokens: number | null
  createdAtMs: number | null
  hasPrompt: boolean
  hasOutput: boolean
}

/** 单次调用中模型发起的一个工具调用。 */
export interface ModelToolCallDetail {
  name: string
  arguments: Record<string, unknown>
  result: string
}

/** 单次调用的完整详情：Prompt、返回、工具调用与元信息。 */
export interface ModelCallDetail extends ModelCallSummary {
  promptMessages: { role: string; content: string }[]
  output: string
  toolCalls: ModelToolCallDetail[]
}

interface AttemptRow {
  attempt_id: string
  run_id: string
  attempt_json: string
  usage_receipt_json: string | null
}

function requireDb(db?: BetterSqlite3.Database): BetterSqlite3.Database {
  const database = db ?? getProjectDb()
  if (!database) throw new Error('项目数据库未打开')
  return database
}

function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}

function readMessages(row: AttemptRow): { role: string; content: string }[] {
  const usage = safeJson<{ replayTask?: { messages?: unknown } }>(row.usage_receipt_json, {})
  const messages = usage.replayTask?.messages
  if (!Array.isArray(messages)) return []
  return messages.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const record = item as { role?: unknown; content?: unknown }
    return typeof record.role === 'string' && typeof record.content === 'string'
      ? [{ role: record.role, content: record.content }]
      : []
  })
}

/** 从一次调用的消息串里提取工具调用参数与随后回填的返回。 */
function readToolCalls(messages: readonly { role: string; content: string }[]): ModelToolCallDetail[] {
  const calls: Array<{ name: string; arguments: Record<string, unknown>; result: string }> = []
  const resultQueue: Array<{ name: string; result: string }> = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const match of message.content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gu)) {
        try {
          const parsed = JSON.parse(match[1]!) as { name?: unknown; arguments?: unknown }
          if (typeof parsed.name === 'string' && parsed.name.trim()) {
            calls.push({
              name: parsed.name.trim(),
              arguments: parsed.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments)
                ? parsed.arguments as Record<string, unknown>
                : {},
              result: '',
            })
          }
        } catch { /* malformed tool markup is shown as raw prompt text instead */ }
      }
    }
    if (message.role === 'user') {
      for (const match of message.content.matchAll(/<tool_result\s+name="([^"]+)"[^>]*>\s*([\s\S]*?)\s*<\/tool_result>/gu)) {
        resultQueue.push({ name: match[1]!, result: match[2]!.trim() })
      }
    }
  }
  for (const call of calls) {
    const index = resultQueue.findIndex(item => item.name === call.name)
    if (index >= 0) call.result = resultQueue.splice(index, 1)[0]!.result
  }
  // 工具循环的后续轮次会把完整历史再次带上；按工具名、参数和返回去重。
  const seen = new Set<string>()
  return calls.filter(call => {
    const key = call.name + '\u0000' + JSON.stringify(call.arguments) + '\u0000' + call.result
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * 生成日志的只读投影。
 *
 * Prompt 早已持久化在 generation_attempts.usage_receipt_json 的 replayTask 里，
 * 返回文本在 generation_artifacts。本仓库只读取与投影，不新增任何写入路径。
 */
export class GenerationLogRepository {
  static list(limit: number, db?: BetterSqlite3.Database): ModelCallSummary[] {
    const database = requireDb(db)
    const rows = database.prepare(`SELECT a.attempt_id, a.run_id, a.attempt_json, a.usage_receipt_json
      FROM generation_attempts a
      ORDER BY a.rowid DESC LIMIT ?`).all(Math.max(1, Math.min(500, limit))) as AttemptRow[]
    return rows.map(row => {
      const attempt = safeJson<{ status?: string; requestedOutputTokens?: number }>(row.attempt_json, {})
      const usage = safeJson<{ purpose?: string; artifactIdentity?: { artifactId?: string } }>(row.usage_receipt_json, {})
      const model = safeJson<{ modelId?: string }>(row.usage_receipt_json, {})
      return {
        attemptId: row.attempt_id,
        runId: row.run_id,
        purpose: usage.purpose ?? '',
        status: attempt.status ?? 'unknown',
        modelName: model.modelId ?? '',
        requestedOutputTokens: attempt.requestedOutputTokens ?? null,
        createdAtMs: null,
        hasPrompt: readMessages(row).length > 0,
        hasOutput: Boolean(usage.artifactIdentity?.artifactId),
      }
    })
  }

  static read(attemptId: string, db?: BetterSqlite3.Database): ModelCallDetail | null {
    const database = requireDb(db)
    const row = database.prepare(`SELECT attempt_id, run_id, attempt_json, usage_receipt_json
      FROM generation_attempts WHERE attempt_id = ?`).get(attemptId) as AttemptRow | undefined
    if (!row) return null
    const attempt = safeJson<{ status?: string; requestedOutputTokens?: number }>(row.attempt_json, {})
    const usage = safeJson<{ purpose?: string; artifactIdentity?: { artifactId?: string }; modelId?: string }>(row.usage_receipt_json, {})
    const artifactId = usage.artifactIdentity?.artifactId ?? ''
    const artifact = artifactId
      ? database.prepare('SELECT artifact_json FROM generation_artifacts WHERE artifact_id = ?').get(artifactId) as { artifact_json: string } | undefined
      : undefined
    const artifactPayload = safeJson<{ text?: string }>(artifact?.artifact_json ?? null, {})
    return {
      attemptId: row.attempt_id,
      runId: row.run_id,
      purpose: usage.purpose ?? '',
      status: attempt.status ?? 'unknown',
      modelName: usage.modelId ?? '',
      requestedOutputTokens: attempt.requestedOutputTokens ?? null,
      createdAtMs: null,
      hasPrompt: readMessages(row).length > 0,
      hasOutput: Boolean(artifactPayload.text),
      promptMessages: readMessages(row),
      output: artifactPayload.text ?? '',
      toolCalls: readToolCalls(readMessages(row)),
    }
  }
}
