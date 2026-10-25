/**
 * 工作流侧的工具循环。
 *
 * 背景：生成链路（callLLMResult）原本是单次请求-响应，模型没有能力调用工具。
 * 这里把 Agent 引擎那套工具协议搬到工作流里：模型在正文之外发出 <tool_call>，
 * 系统执行对应工具、把 <tool_result> 回填，再让模型继续，直到它给出最终正文。
 *
 * 复用同一份协议解析器与同一个 toolRegistry，因此工具定义只有一处。
 */
import { parseAgentResponseProtocol, cleanAgentProtocolVisibleText } from '../../shared/agent-response-protocol'
import { toolRegistry, type AgentExecutionContext, type ToolResult } from '../agent/tool-registry'
import { registerBuiltinTools } from '../agent/tools'
import type { WritingLanguage } from '../../shared/writing-language'

/** 单轮工具调用的记录，供运行面板与日志展示。 */
export interface WorkflowToolCallRecord {
  name: string
  arguments: Record<string, unknown>
  status: 'completed' | 'failed'
  result?: string
  error?: string
}

export interface WorkflowToolLoopOptions {
  /** 发起一轮生成：给定完整消息列表，返回模型原文。 */
  generate: (messages: { role: 'system' | 'user' | 'assistant' | 'user'; content: string }[]) => Promise<string>
  systemPrompt: string
  userPrompt: string
  writingLanguage: WritingLanguage
  /** 允许模型使用的工具名；不传时使用全部内置工具。 */
  allowedTools?: readonly string[]
  /** 本循环最多允许的模型物理请求数（含最后一次收尾）；工作流按真实生成预算传入。 */
  maxRounds?: number
  /** 工具执行上下文（含冻结项目会话）。 */
  executionContext: AgentExecutionContext
  /** 每次工具调用结束后的回调，用于实时展示与记录。 */
  onToolCall?: (record: WorkflowToolCallRecord) => void
  /** 每轮完整原始返回（含工具调用标记）与随后回填的工具结果。 */
  onRound?: (round: {
    index: number
    rawResponse: string
    toolResults: readonly WorkflowToolCallRecord[]
  }) => void
  /** 工具结果回填的最大字符数。 */
  maxResultChars?: number
}

export interface WorkflowToolLoopResult {
  /** 去掉协议标记后的可见正文。 */
  text: string
  /** 全部工具调用记录。 */
  toolCalls: WorkflowToolCallRecord[]
  /** 最后一轮模型原文；非 stop 时用于恢复已生成部分。 */
  lastRawResponse: string
  /** 没有任何工具调用的最后一轮可见正文。 */
  lastVisibleText: string
}

/** 最后一轮之后强制的收尾指令：停止调工具，直接产出正文。 */
const FINAL_ROUND_INSTRUCTION =
  '工具调用到此为止，不要再调用任何工具。请立刻用已经掌握的全部事实，直接输出最终结果正文；只输出正文本身，不要解释。'

const DEFAULT_MAX_ROUNDS = 8
const DEFAULT_MAX_RESULT_CHARS = 6000

function toolPromptFor(names: readonly string[], language: WritingLanguage): string {
  return toolRegistry.generateToolPrompt(language, tool => names.includes(tool.name))
}

/**
 * 运行「生成 → 工具调用 → 回填 → 继续生成」循环。
 * 模型不再发出 tool_call 时，循环结束并返回正文。
 *
 * maxRounds 是本次循环允许花掉的**模型物理请求总数**（含最后一次收尾请求）。
 * 调用方按生成根预算的剩余量传入；业务侧不要再拍一个更小的硬上限——
 * 轮次太少会让模型把预算全花在工具上、正文永远写不出来。
 */
export async function runWorkflowToolLoop(options: WorkflowToolLoopOptions): Promise<WorkflowToolLoopResult> {
  const {
    generate, systemPrompt, userPrompt, writingLanguage, executionContext,
    maxRounds = DEFAULT_MAX_ROUNDS,
    maxResultChars = DEFAULT_MAX_RESULT_CHARS,
  } = options
  // 工作流可能在用户从未打开过 Agent 面板时启动；注册表可能已有 MCP/Skill 工具，
  // 因此这里不能以“注册表为空”为条件，否则内置工具会永远缺失，允许清单筛选为空。
  // registerAll 覆盖注册，重复调用安全。
  registerBuiltinTools()
  const totalRounds = Math.max(1, Math.floor(maxRounds))
  // 最后一轮固定留给收尾请求：工具轮全部用完时，还得有一次机会把正文写出来。
  const toolRounds = totalRounds - 1
  const allowed = toolRounds > 0
    ? options.allowedTools ?? toolRegistry.listAll().map(tool => tool.name)
    : []
  const registered = new Set(allowed)
  const toolPrompt = toolRounds > 0 ? toolPromptFor(allowed, writingLanguage) : ''
  const records: WorkflowToolCallRecord[] = []
  let lastRawResponse = ''
  let lastVisibleText = ''
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: toolPrompt ? systemPrompt + '\n\n' + toolPrompt : systemPrompt },
    { role: 'user', content: userPrompt },
  ]

  for (let round = 0; round < toolRounds; round += 1) {
    const raw = await generate(messages)
    lastRawResponse = raw
    const parsed = parseAgentResponseProtocol(raw, [...registered])
    // 只接受本次允许清单内的工具；不在清单里的调用视为普通正文里的噪声，
    // 否则未知工具会在每一轮重复出现并耗尽轮次预算。
    const accepted = parsed.toolCalls.filter(call => registered.has(call.name))
    const visible = cleanAgentProtocolVisibleText(parsed.textParts.join(''), [...registered]).trim()
    lastVisibleText = visible

    if (accepted.length === 0) {
      options.onRound?.({ index: round, rawResponse: raw, toolResults: [] })
      return { text: visible, toolCalls: records, lastRawResponse, lastVisibleText }
    }

    messages.push({ role: 'assistant', content: raw })
    const observations: string[] = []
    const roundRecords: WorkflowToolCallRecord[] = []
    for (const call of accepted) {
      const tool = toolRegistry.get(call.name)
      const record: WorkflowToolCallRecord = { name: call.name, arguments: call.arguments, status: 'failed' }
      if (!tool) {
        record.error = 'unknown tool'
        records.push(record)
        roundRecords.push(record)
        options.onToolCall?.(record)
        observations.push(`<tool_result name="${call.name}" error="true">unknown tool</tool_result>`)
        continue
      }
      let result: ToolResult
      try {
        result = await tool.execute(call.arguments, executionContext)
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error)
        records.push(record)
        roundRecords.push(record)
        options.onToolCall?.(record)
        observations.push(`<tool_result name="${call.name}" error="true">${record.error}</tool_result>`)
        continue
      }
      const content = (result.success ? result.content : result.error ?? result.content ?? '').slice(0, maxResultChars)
      record.status = result.success ? 'completed' : 'failed'
      if (result.success) record.result = content
      else record.error = content
      records.push(record)
      roundRecords.push(record)
      options.onToolCall?.(record)
      observations.push(result.success
        ? `<tool_result name="${call.name}">\n${content}\n</tool_result>`
        : `<tool_result name="${call.name}" error="true">\n${content}\n</tool_result>`)
    }
    options.onRound?.({ index: round, rawResponse: raw, toolResults: roundRecords })
    messages.push({ role: 'user', content: observations.join('\n') })
  }

  // 工具轮预算用完：最后再要一次正文，并在这次请求里明确禁止继续调工具。
  // totalRounds === 1 时连工具清单都不给，避免模型刚看到工具就又想调、白白多花一次请求。
  const finalMessages = toolRounds > 0
    ? [...messages, { role: 'user' as const, content: FINAL_ROUND_INSTRUCTION }]
    : [{ role: 'system' as const, content: systemPrompt }, { role: 'user' as const, content: userPrompt + '\n\n' + FINAL_ROUND_INSTRUCTION }]
  const finalRaw = await generate(finalMessages)
  lastRawResponse = finalRaw
  const finalParsed = parseAgentResponseProtocol(finalRaw, [...registered])
  const finalVisible = cleanAgentProtocolVisibleText(finalParsed.textParts.join(''), [...registered]).trim()
  if (finalVisible) {
    lastVisibleText = finalVisible
    return { text: finalVisible, toolCalls: records, lastRawResponse, lastVisibleText }
  }
  // 仍然只发工具调用或空正文：明确告诉调用方是轮次耗尽，而不是「模型没写」。
  throw new Error(
    `TOOL_ROUNDS_EXHAUSTED: 模型在 ${totalRounds} 次请求里只调用了工具（${records.map(record => record.name).join(', ') || '无'}），没有输出正文。`,
  )
}
