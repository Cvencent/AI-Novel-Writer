import { describe, expect, it } from 'vitest'
import { runWorkflowToolLoop } from '../tool-loop'
import { toolRegistry, type AgentTool } from '../../agent/tool-registry'
const foreignTool: AgentTool = {
  name: 'mcp_foreign_tool',
  description: 'foreign',
  inputSchema: { type: 'object', properties: {} },
  source: 'mcp',
  requiresConfirmation: false,
  isReadOnly: true,
  execute: async () => ({ success: true, content: 'ok' }),
}
describe('workflow tool loop builtin registration', () => {
  it('registers builtin tools even when the registry already holds foreign tools', async () => {
    toolRegistry.register(foreignTool)
    const seen: string[] = []
    await runWorkflowToolLoop({
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      writingLanguage: 'zh-CN',
      allowedTools: ['read_characters', 'create_character'],
      executionContext: {} as never,
      generate: async messages => { seen.push(messages[0]!.content); return '## 第1章：标题' + String.fromCharCode(10) + '正文。' },
    })
    expect(seen[0]).toContain('read_characters')
    expect(seen[0]).toContain('create_character')
    expect(toolRegistry.get('mcp_foreign_tool')).toBeDefined()
  })
})
