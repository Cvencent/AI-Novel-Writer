import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { getBuiltinPromptTemplate } from '../../../builtin-prompt-templates'

/**
 * A command that declares a promptKey main does not know about fails at
 * generation:begin with GENERATION_BUILTIN_PROMPT_MISSING, long after the run
 * looks like it started. Catch that statically for every command.
 */
function commandFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : commandFiles(full)
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : []
  })
}

function declaredPromptKeys(source: string): string[] {
  const keys: string[] = []
  for (const match of source.matchAll(/promptKeys:\s*\[([^\]]*)\]/gu)) {
    const content = match[1]!.trim()
    // Only literal arrays: `['a', 'b']`. Expressions (ternaries, variables) are
    // resolved at runtime and are covered by their own tests.
    if (content && !/^['"][^'"]+['"](?:\s*,\s*['"][^'"]+['"])*$/u.test(content)) continue
    for (const literal of content.matchAll(/['"]([^'"]+)['"]/gu)) keys.push(literal[1]!)
  }
  return keys
}

describe('every declared promptKey is a registered builtin prompt', () => {
  const dir = join(process.cwd(), 'src/services/workflows/commands')
  const files = commandFiles(dir)

  it('finds command files to scan', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it('resolves every promptKey for both languages', () => {
    const missing: string[] = []
    for (const file of files) {
      for (const key of declaredPromptKeys(readFileSync(file, 'utf8'))) {
        for (const language of ['zh-CN', 'en-US'] as const) {
          if (!getBuiltinPromptTemplate(key, language)) missing.push(`${file.split('/').pop()}: ${key} (${language})`)
        }
      }
    }
    expect(missing).toEqual([])
  })
})
