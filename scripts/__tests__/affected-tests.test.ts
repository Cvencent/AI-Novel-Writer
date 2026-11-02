import { describe, expect, it } from 'vitest'

import { affectedTests, changedFiles } from '../qa/affected-tests.mjs'

/**
 * 这些用例只验证「挑测试」这一步的判据，不跑 vitest 自身。
 *
 * 目的（性能）：全量 `vitest run src/shared src/services electron/services
 * electron/repositories` 实测 156 秒，其中 electron/ 一项 130 秒；而一轮修复
 * 真正可能影响的测试通常只有 5–10 个文件（约 4 秒）。这个脚本就是替代默认全量的。
 */
describe('affected-tests', () => {
  const tests = [
    'src/shared/__tests__/foreshadowing-commitments.test.ts',
    'src/shared/__tests__/consistency-preflight.test.ts',
    'src/shared/__tests__/unrelated-thing.test.ts',
    'src/services/workflows/commands/__tests__/directory.command.test.ts',
    'electron/services/__tests__/review-revision-context.test.ts',
  ]

  it('picks the same-name test for a source file', () => {
    expect(affectedTests(['src/shared/foreshadowing-commitments.ts'], tests))
      .toContain('src/shared/__tests__/foreshadowing-commitments.test.ts')
  })

  it('picks tests that import the module', () => {
    // consistency-preflight 测试 import 了 consistency-preflight。
    const picked = affectedTests(['src/shared/consistency-preflight.ts'], tests)
    expect(picked).toContain('src/shared/__tests__/consistency-preflight.test.ts')
  })

  it('keeps a changed test file itself', () => {
    expect(affectedTests(['src/shared/__tests__/unrelated-thing.test.ts'], tests))
      .toContain('src/shared/__tests__/unrelated-thing.test.ts')
  })

  it('does not pull in the whole shared test folder for a shared source file', () => {
    // `src/shared/__tests__/` 装着整个 shared 层的六七十个测试，
    // 「同目录」对任何一个 shared 文件都成立——那样等于跑全量。
    const picked = affectedTests(['src/shared/foreshadowing-commitments.ts'], tests)
    expect(picked).not.toContain('src/shared/__tests__/unrelated-thing.test.ts')
  })

  it('ignores build output and non-source files', () => {
    expect(affectedTests(['release/1.5.97/win-unpacked/app.asar', 'README.md'], tests)).toEqual([])
  })

  it('reads the worktree change list without throwing', () => {
    // 只断言形状：内容取决于当前工作区，不能写死。
    const files = changedFiles()
    expect(Array.isArray(files)).toBe(true)
    expect(files.every(file => typeof file === 'string' && !file.includes('\\'))).toBe(true)
  })
})
