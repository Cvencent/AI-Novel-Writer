import { describe, expect, it, vi } from 'vitest'
import { runWorkflowToolLoop } from '../tool-loop'
import { toolRegistry, buildAgentTool } from '../../agent/tool-registry'
import type { AgentExecutionContext } from '../../agent/tool-registry'

const context = {
  projectSession: { projectId: 'p', projectPath: 'C:/p', leaseId: 'l' },
  uiLocale: 'zh-CN', writingLanguage: 'zh-CN', selectedModelId: null,
} as unknown as AgentExecutionContext

function registerTool(name: string, execute: (args: Record<string, unknown>) => Promise<{ success: boolean; content: string; error?: string }>) {
  toolRegistry.register(buildAgentTool({
    name,
    description: 'test tool',
    source: 'builtin',
    requiresConfirmation: false,
    isReadOnly: false,
    inputSchema: { type: 'object', properties: {} },
    execute: async (args) => execute(args),
  }))
}

describe('runWorkflowToolLoop', () => {
  it('模型不调用工具时直接返回正文', async () => {
    const result = await runWorkflowToolLoop({
      systemPrompt: 'system', userPrompt: 'user', writingLanguage: 'zh-CN', executionContext: context,
      generate: async () => '## 第1章：开局\n正文内容。',
    })
    expect(result.text).toContain('正文内容')
    expect(result.toolCalls).toEqual([])
  })

  it('模型调用工具后把结果回填并继续生成', async () => {
    const execute = vi.fn(async () => ({ success: true, content: '林越 / 苏婉' }))
    registerTool('test_list_characters', execute)
    let call = 0
    const seen: string[] = []
    const result = await runWorkflowToolLoop({
      systemPrompt: 'system', userPrompt: 'user', writingLanguage: 'zh-CN', executionContext: context,
      allowedTools: ['test_list_characters'],
      generate: async messages => {
        seen.push(messages[messages.length - 1]!.content)
        call += 1
        return call === 1
          ? '先看看有哪些角色。\n<tool_call>\n{"name": "test_list_characters", "arguments": {}}\n</tool_call>'
          : '## 第1章：开局\n林越出场。'
      },
    })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(seen[1]).toContain('林越 / 苏婉')
    expect(result.text).toContain('林越出场')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]).toMatchObject({ name: 'test_list_characters', status: 'completed' })
  })

  it('工具失败时把错误回填而不是中断', async () => {
    registerTool('test_failing', vi.fn(async () => ({ success: false, content: '', error: '找不到角色' })))
    let call = 0
    const seen: string[] = []
    const result = await runWorkflowToolLoop({
      systemPrompt: 's', userPrompt: 'u', writingLanguage: 'zh-CN', executionContext: context,
      allowedTools: ['test_failing'],
      generate: async messages => {
        seen.push(messages[messages.length - 1]!.content)
        call += 1
        return call === 1
          ? '<tool_call>\n{"name": "test_failing", "arguments": {}}\n</tool_call>'
          : '正文。'
      },
    })
    expect(seen[1]).toContain('找不到角色')
    expect(result.toolCalls[0]!.status).toBe('failed')
    expect(result.text).toContain('正文')
  })

  it('不在允许清单里的工具名不产生工具调用', async () => {
    const result = await runWorkflowToolLoop({
      systemPrompt: 's', userPrompt: 'u', writingLanguage: 'zh-CN', executionContext: context,
      allowedTools: ['known_tool'],
      generate: async () => '<tool_call>\n{"name": "unknown_tool", "arguments": {}}\n</tool_call>',
    })
    expect(result.toolCalls).toEqual([])
  })

  it('工具轮用完后强制收尾，轮次耗尽时明确报错', async () => {
    registerTool('test_loop', vi.fn(async () => ({ success: true, content: 'ok' })))
    let call = 0
    const seen: string[] = []
    await expect(runWorkflowToolLoop({
      systemPrompt: 's', userPrompt: 'u', writingLanguage: 'zh-CN', executionContext: context,
      allowedTools: ['test_loop'], maxRounds: 3,
      generate: async messages => {
        call += 1
        seen.push(messages[messages.length - 1]!.content)
        return '<tool_call>\n{"name": "test_loop", "arguments": {}}\n</tool_call>'
      },
    })).rejects.toThrow('TOOL_ROUNDS_EXHAUSTED')
    // maxRounds 是物理请求总数：2 轮工具 + 1 次收尾，绝不超发。
    expect(call).toBe(3)
    expect(seen[2]).toContain('不要再调用任何工具')
  })

  it('最后一次收尾只输出正文时正常返回', async () => {
    registerTool('test_loop_final', vi.fn(async () => ({ success: true, content: 'ok' })))
    let call = 0
    const result = await runWorkflowToolLoop({
      systemPrompt: 's', userPrompt: 'u', writingLanguage: 'zh-CN', executionContext: context,
      allowedTools: ['test_loop_final'], maxRounds: 2,
      generate: async () => {
        call += 1
        return call === 1
          ? '<tool_call>\n{"name": "test_loop_final", "arguments": {}}\n</tool_call>'
          : '## 第1章：开局\n正文。'
      },
    })
    expect(call).toBe(2)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.text).toContain('正文')
  })

  it('预算只剩一次请求时不再向模型暴露工具', async () => {
    let call = 0
    let systemContents: string[] = []
    const result = await runWorkflowToolLoop({
      systemPrompt: 'system-only', userPrompt: 'user', writingLanguage: 'zh-CN', executionContext: context,
      allowedTools: ['test_loop_single'], maxRounds: 1,
      generate: async messages => {
        call += 1
        systemContents = messages.filter(message => message.role === 'system').map(message => message.content)
        return '## 第1章：开局\n正文。'
      },
    })
    expect(call).toBe(1)
    expect(systemContents).toEqual(['system-only'])
    expect(result.text).toContain('正文')
  })
})
