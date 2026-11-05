import { describe, expect, it } from 'vitest'

import { firstFailedCheck, firstFailedNamedCheck } from '../named-check'

/**
 * issue #178：全仓 12 个 `*_MISMATCH` 错误码都是「多个字段合取成一个码」，不说是哪一项。
 * 最典型的是同一族的 `GENERATION_RUN_IDENTITY_MISMATCH` 在 **5 个模块**里各写一遍，
 * 检查的项目还不完全相同 —— 拿到码时既不知道是哪个模块、也不知道哪一项不等。
 */
describe('firstFailedCheck (issue #178)', () => {
  it('returns null when every check passes', () => {
    expect(firstFailedCheck('GENERATION_X_MISMATCH', [['a', true], ['b', true]])).toBeNull()
  })

  it('names the failing field while KEEPING the original code prefix', () => {
    const code = firstFailedCheck('GENERATION_RUN_IDENTITY_MISMATCH', [
      ['handleProjectId', true],
      ['rootActionId', false],
    ])
    expect(code).toBe('GENERATION_RUN_IDENTITY_MISMATCH:rootActionId')
    // 前缀必须保留：既有 `message.includes('…MISMATCH')` 的分支照旧生效。
    expect(code!.startsWith('GENERATION_RUN_IDENTITY_MISMATCH')).toBe(true)
  })

  it('preserves the original conjunction order (short-circuit semantics unchanged)', () => {
    // 两项都不等时，第一个仍是原式里先求值的那一项。
    expect(firstFailedCheck('X', [['first', false], ['second', false]]))
      .toBe('X:first,second')
  })

  it('reports ALL failing fields, not just the first (debugging needs "how many differed")', () => {
    const code = firstFailedCheck('X', [['a', false], ['b', true], ['c', false], ['d', true]])
    expect(code).toBe('X:a,c')
  })

  it('degrades an invalid field name to "unnamed" instead of leaking Chinese into the code', () => {
    // IPC 边界的白名单正则只认 `[A-Za-z]{1,40}`（#179 的教训）——
    // 脏名字会把整个码判成「不是具名码」，落进兜底分支。
    expect(firstFailedCheck('X', [['这是中文', false]])).toBe('X:unnamed')
    expect(firstFailedCheck('X', [['a'.repeat(41), false]])).toBe('X:unnamed')
    expect(firstFailedCheck('X', [['ok_name_1', false]])).toBe('X:ok_name_1')
  })

  it('has a named-shape helper for call sites that already hold objects', () => {
    expect(firstFailedNamedCheck('X', [{ name: 'p', passed: true }, { name: 'q', passed: false }]))
      .toBe('X:q')
  })

  it('handles an empty check list (nothing to verify)', () => {
    expect(firstFailedCheck('X', [])).toBeNull()
  })
})