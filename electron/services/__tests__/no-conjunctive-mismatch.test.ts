import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 「多字段合取抛同一个错误码」的结构守卫（issue #178 建议 ③）。
 *
 * 全仓有 12 个 `*_MISMATCH` 错误码，形态一模一样：`a || b || c || …` 共抛一个码，**不说是哪一项**。
 * 最典型的是 `GENERATION_RUN_IDENTITY_MISMATCH` 在 5 个模块各写一遍、检查项还不同。
 *
 * 这条守卫与 `no-content-wordlists` 同一机制：**冻结清单、只减不增**。
 * 修法就是逐个改成 `firstFailedCheck(...)`（`electron/services/named-check.ts`），
 * 改完把清单里那一行删掉 —— 清单变短是允许的，变长会红。
 *
 * ⚠️ 这是**形态**扫描（一个 throw 语句的条件里出现 ≥2 个 `||`），不看语义：
 * 它只保证「新写的合取码必须具名」，不判断某个判据「应该」怎么拆。
 */

const ROOT = join(__dirname, '..', '..', '..')

/** 已冻结的「合取抛同一个 MISMATCH」位置（`文件::行号` 不稳定，用 `文件::码名` 计次）。 */
const BASELINE: ReadonlyArray<string> = [  // 格式：文件::码::出现次数
  'electron/services/agent-generation.ts::GENERATION_AGENT_IDENTITY_MISMATCH::1',
  'electron/services/agent-generation.ts::GENERATION_AGENT_ROOT_MISMATCH::1',
  'electron/services/graph-generation.ts::GENERATION_RUN_IDENTITY_MISMATCH::1',
  'electron/services/legacy-roster-generation-proof.ts::GENERATION_RUN_IDENTITY_MISMATCH::2',
  'electron/services/legacy-roster-generation.ts::GENERATION_RUN_IDENTITY_MISMATCH::1',
  'electron/services/main-generation-owner.ts::GENERATION_MATERIAL_PROMPT_MISMATCH::4',
  'electron/services/main-generation-owner.ts::GENERATION_RUN_IDENTITY_MISMATCH::2',
  'src/services/editor-inline-generation.ts::EDITOR_INLINE_IDENTITY_MISMATCH::2',
  'src/services/finalization-generation.ts::FINALIZATION_GENERATION_IDENTITY_MISMATCH::2',
  'src/services/generation/main-generation-transport.ts::GENERATION_PROJECT_SESSION_MISMATCH::1',
  'src/services/graph-generation.ts::GRAPH_GENERATION_IDENTITY_MISMATCH::1',
  'src/services/legacy-roster-generation.ts::LEGACY_ROSTER_GENERATION_IDENTITY_MISMATCH::1',
  'src/services/workflows/batch-chapter-workflow.ts::GENERATION_BATCH_INTENT_MISMATCH::1',
  'src/services/workflows/commands/architecture.command.ts::GENERATION_COMPOSITION_RECEIPT_MISMATCH::1',
  'src/services/workflows/commands/base-command.ts::GENERATION_COMPOSITION_RECEIPT_MISMATCH::1',
  'src/services/workflows/commands/generate-draft.command.ts::GENERATION_COMPOSITION_RECEIPT_MISMATCH::1',
  'src/services/workflows/commands/review-revision-command.ts::GENERATION_REVIEW_REVISION_RECEIPT_MISMATCH::1',
  'src/shared/character-proposal-parser.ts::CHARACTER_PROPOSAL_SLOT_MISMATCH::1',
]

function walk(dir: string, out: string[] = []): string[] {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (['node_modules', 'dist', 'dist-electron', 'release', '.git', '__tests__', '.runtime', '.qa'].includes(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

/**
 * 一个源文件里「throw new Error('…MISMATCH…')」且同一条件里出现 ≥2 个 `||` 的位置。
 *
 * 判定只认**同一条 throw 语句**（到分号或行末），跨多行也算 —— 本仓这类条件常折行。
 */
export function conjunctiveMismatchThrows(source: string): string[] {
  const found: string[] = []
  const pattern = /throw\s+new\s+Error\(\s*['"]([A-Z0-9_]*MISMATCH[A-Z0-9_]*)['"]\s*\)/gu
  for (const match of source.matchAll(pattern)) {
    const at = match.index ?? 0
    // 往回找这条 throw 所属的语句起点（上一个分号/块起点之后）。
    const head = source.slice(Math.max(0, at - 2000), at)
    const cut = Math.max(head.lastIndexOf(';'), head.lastIndexOf('{'), head.lastIndexOf('}'))
    const condition = cut >= 0 ? head.slice(cut + 1) : head
    const pipes = (condition.match(/\|\|/gu) ?? []).length
    if (pipes >= 2) found.push(match[1]!)
  }
  return found
}

describe('多字段合取抛同一个 MISMATCH 的守卫 (issue #178)', () => {
  it('never adds a new conjunctive MISMATCH throw (baseline only shrinks)', () => {
    const counts = new Map<string, number>()
    for (const file of walk(join(ROOT, 'electron')).concat(walk(join(ROOT, 'src')))) {
      const source = readFileSync(file, 'utf8')
      for (const code of conjunctiveMismatchThrows(source)) {
        const key = `${relative(ROOT, file).replace(/\\/gu, '/')}::${code}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
    const allowed = new Map<string, number>()
    for (const entry of BASELINE) {
      const [file, code, times] = entry.split('::')
      const key = `${file}::${code}`
      allowed.set(key, Number(times))
    }
    const added = [...counts].filter(([key, count]) => count > (allowed.get(key) ?? 0))
    expect(added).toEqual([])
  })

  it('the scanner really sees the pattern (a guard that cannot fire is not a guard)', () => {
    // 正面对照：三种常见写法都必须被扫到。
    const three = [
      "if (a !== b || c !== d || e !== f) throw new Error('GENERATION_RUN_IDENTITY_MISMATCH')",
      "if (a !== b || c !== d\n  || e !== f) throw new Error('GRAPH_GENERATION_IDENTITY_MISMATCH')",
      "if (x || y || z) throw new Error('LEASE_IDENTITY_MISMATCH')",
    ]
    for (const source of three) {
      expect(conjunctiveMismatchThrows(source), source).toHaveLength(1)
    }
    // 反面对照：只比一项的、以及已改成具名检查表的不算。
    expect(conjunctiveMismatchThrows("if (a !== b) throw new Error('GENERATION_RUN_IDENTITY_MISMATCH')")).toEqual([])
    expect(conjunctiveMismatchThrows([
      'const failure = firstFailedCheck(\'GENERATION_RUN_IDENTITY_MISMATCH\', [',
      "  ['a', a === b], ['c', c === d],",
      '])',
      'if (failure) throw new Error(failure)',
    ].join('\n'))).toEqual([])
  })
})