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
  /**
   * 这条调用的完整 Prompt 已被保留策略清理（只留返回文本与元信息）。
   * 与 hasPrompt=false 的区别：false 是这次调用本来就没记录 Prompt，true 是曾经有、后来按策略清掉了。
   */
  promptTrimmed: boolean
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

/**
 * 这条调用的 Prompt 是不是被保留策略清掉的。
 *
 * 清理时会在 usage_receipt_json 上留 promptTrimmedAt 标记，然后删掉 replayTask.messages。
 * 有这个标记且没有 messages，就是「曾经有、后来按策略清理」，与「这次调用本来就没记 Prompt」区分开。
 */
function wasPromptTrimmed(row: AttemptRow): boolean {
  const usage = safeJson<{ promptTrimmedAt?: unknown }>(row.usage_receipt_json, {})
  return typeof usage.promptTrimmedAt === 'string' && usage.promptTrimmedAt.length > 0
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
        promptTrimmed: wasPromptTrimmed(row),
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
      promptTrimmed: wasPromptTrimmed(row),
      promptMessages: readMessages(row),
      output: artifactPayload.text ?? '',
      toolCalls: readToolCalls(readMessages(row)),
    }
  }

  /**
   * 保留策略：完整 Prompt 只留最近 keepCount 次调用，更早的记录删掉 replayTask.messages，
   * 返回文本、purpose、模型、token 这些摘要信息全部留着。
   *
   * 为什么需要：大纲类调用的用户提示词会带上已确认大纲的上下文，单次可到 MB 级。
   * 如果每次调用都永久保留完整 Prompt，作品的生成日志会随章节数线性膨胀（实测一部作品
   * 可以涨到几百 MB），打开作品与切页都会变慢。
   *
   * 清理时在 usage_receipt_json 上写 promptTrimmedAt 标记，日志页据此明确告诉作者
   * 「这条的 Prompt 已按保留策略清理」，而不是让它看起来像一条空记录。
   *
   * 排序按 rowid（写入顺序）：最近 keepCount 条保留，更早的清理。
   * 返回这次清理掉的条数；不写任何小说内容，只动日志表里的 Prompt 字段。
   */
  /**
   * 当前日志占用的概况，给设置页显示「能回收多少」。
   *
   * promptBytes 是还留着完整 Prompt 的那些记录的字节数（不含返回文本），
   * 也就是执行保留策略后能真正释放的量。
   */
  static promptStorageStats(db?: BetterSqlite3.Database): {
    totalCalls: number
    callsWithPrompt: number
    callsTrimmed: number
    promptBytes: number
  } {
    const database = requireDb(db)
    const row = database.prepare(`SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN json_type(usage_receipt_json,'$.replayTask.messages') = 'array' THEN 1 ELSE 0 END) AS with_prompt,
        SUM(CASE WHEN json_type(usage_receipt_json,'$.promptTrimmedAt') IS NOT NULL THEN 1 ELSE 0 END) AS trimmed,
        SUM(CASE WHEN json_type(usage_receipt_json,'$.replayTask.messages') = 'array'
          THEN LENGTH(CAST(usage_receipt_json AS BLOB)) ELSE 0 END) AS prompt_bytes
      FROM generation_attempts`).get() as { total: number; with_prompt: number | null; trimmed: number | null; prompt_bytes: number | null }
    return {
      totalCalls: Number(row.total) || 0,
      callsWithPrompt: Number(row.with_prompt) || 0,
      callsTrimmed: Number(row.trimmed) || 0,
      promptBytes: Number(row.prompt_bytes) || 0,
    }
  }

  static trimPromptHistory(keepCount: number, db?: BetterSqlite3.Database): number {
    const database = requireDb(db)
    const keep = Math.max(0, Math.floor(keepCount))
    const rows = database.prepare(`SELECT attempt_id, usage_receipt_json FROM generation_attempts
      WHERE usage_receipt_json IS NOT NULL
        AND json_type(usage_receipt_json,'$.replayTask.messages') = 'array'
      ORDER BY rowid DESC`).all() as { attempt_id: string; usage_receipt_json: string }[]
    const stale = rows.slice(keep)
    if (stale.length === 0) return 0
    const update = database.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?')
    database.transaction(() => {
      for (const row of stale) {
        const usage = safeJson<Record<string, unknown>>(row.usage_receipt_json, {})
        const replayTask = usage.replayTask as Record<string, unknown> | undefined
        if (!replayTask) continue
        // 只删 messages；replayTask 里别的字段（purpose / reasoningStage / output）留着。
        const { messages: _messages, ...rest } = replayTask
        void _messages
        const next = { ...usage, ...(Object.keys(rest).length > 0 ? { replayTask: rest } : {}), promptTrimmedAt: new Date().toISOString() }
        if (Object.keys(rest).length === 0) delete (next as Record<string, unknown>).replayTask
        update.run(JSON.stringify(next), row.attempt_id)
      }
    }).immediate()
    return stale.length
  }
}
