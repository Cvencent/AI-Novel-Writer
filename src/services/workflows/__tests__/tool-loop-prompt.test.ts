import { describe, expect, it } from 'vitest'
import { runWorkflowToolLoop } from '../tool-loop'
describe('workflow tool loop prompt', () => {
  it('exposes the allowed tool list inside the system message', async () => {
    const seen: string[] = []
    const result = await runWorkflowToolLoop({
      systemPrompt: 'SYSROLE',
      userPrompt: 'USERPROMPT',
      writingLanguage: 'zh-CN',
      allowedTools: ['read_characters', 'create_character'],
      executionContext: {} as never,
      generate: async messages => { seen.push(messages[0]!.content); return '## 第1章：标题' + String.fromCharCode(10) + '正文。' },
    })
    expect(seen[0]).toContain('read_characters')
    expect(seen[0]).toContain('create_character')
    expect(result.text).toContain('第1章')
  })
})
