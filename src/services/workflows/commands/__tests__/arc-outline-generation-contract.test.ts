import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { getBuiltinPromptTemplate } from '../../../builtin-prompt-templates'

describe('arc outline generation contract', () => {
  it.each(['zh-CN', 'en-US'] as const)('resolves a non-empty arc_outline builtin prompt in %s', language => {
    const template = getBuiltinPromptTemplate('arc_outline', language)
    expect(template).toBeDefined()
    expect(template!.key).toBe('arc_outline')
    expect(template!.content.trim().length).toBeGreaterThan(80)
    expect(template!.systemRole?.trim().length).toBeGreaterThan(20)
  })

  it('never sends an empty prompt-key set, which main rejects as GENERATION_BEGIN_INVALID', () => {
    const source = readFileSync('src/services/workflows/commands/arc-outline.command.ts', 'utf8')
    expect(source).not.toContain('promptKeys: []')
    // 生成、重写、反推、检查四条命令都必须带上非空的 arc_outline 提示词键。
    const keys = source.match(/promptKeys: \[[^\]]*\]/g) ?? []
    expect(keys.length).toBeGreaterThanOrEqual(3)
    expect(keys.every(entry => entry.includes('arc_outline'))).toBe(true)
  })
})
