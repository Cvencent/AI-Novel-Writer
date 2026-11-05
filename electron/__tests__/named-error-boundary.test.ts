import { describe, expect, it } from 'vitest'

import { generationErrorCode } from '../controllers/generation-controller'
import { firstFailedCheck } from '../services/named-check'

/**
 * **跨模块守卫**：`firstFailedCheck` 的产出必须能穿过 IPC 白名单（issue #189）。
 *
 * ## 为什么需要它
 *
 * `#178`（工具产出 `…MISMATCH:a,b`，含逗号）与 `#179`（白名单后缀只允许 `[A-Za-z]{1,40}`，
 * **不许逗号**）**各自都对，组合起来破**：
 *
 * ```
 * 产出:      GENERATION_REVIEW_CONTEXT_MISMATCH:chapterNumber,authorInputs
 * IPC 之后:  GENERATION_REQUEST_FAILED:GENERATION_REVIEW_CONTEXT_MISMATCH:chapterNumber,authorInputs
 *            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^  前缀换了
 * ```
 *
 * 后果是所有 `includes('…MISMATCH')` 的分支在**多名失败**时走不到 —— 而那正是最该一次看全的情况。
 *
 * 两个提交各自的测试都绿，因为**没人测「A 的输出能否穿过 B」这一跳**。
 * 这条测试补的就是那一跳：把工具在各种形状下的产出都跑一遍，逐个断言它能原样穿过边界。
 *
 * ⚠️ 与 `acknowledgement-title.test.ts` 的「穷举全部字面量」同一思路：
 * 跨模块的契约必须有一条**直接连接两侧**的断言，否则两边各自绿、组合起来破。
 */
describe('具名错误码必须穿过 IPC 白名单 (issue #189)', () => {
  const code = 'GENERATION_REVIEW_CONTEXT_MISMATCH'

  const passes = (message: string) => generationErrorCode(new Error(message))

  it('single failing field survives the boundary unchanged', () => {
    const produced = firstFailedCheck(code, [['operation', true], ['chapterNumber', false]])!
    expect(produced).toBe(`${code}:chapterNumber`)
    expect(passes(produced)).toBe(produced)
  })

  it('MULTIPLE failing fields survive the boundary unchanged (the reported defect)', () => {
    const produced = firstFailedCheck(code, [
      ['operation', true],
      ['chapterNumber', false],
      ['authorInputs', false],
    ])!
    expect(produced).toBe(`${code}:chapterNumber,authorInputs`)
    // 这一条在 #189 之前会变成 `GENERATION_REQUEST_FAILED:…`（前缀被换）。
    expect(passes(produced)).toBe(produced)
    // 前缀必须保留，否则 `includes('…MISMATCH')` 的既有分支全部失效。
    expect(passes(produced).startsWith(code)).toBe(true)
  })

  it('the maximum number of failing fields (8) survives', () => {
    const checks = Array.from({ length: 8 }, (_, index) => [`field${index}`, false] as const)
    const produced = firstFailedCheck(code, checks)!
    expect(passes(produced)).toBe(produced)
  })

  it('a long-but-legal field name (31 chars) survives, and an illegal one degrades safely', () => {
    const longName = 'a'.repeat(31)
    expect(passes(firstFailedCheck(code, [[longName, false]])!)).toBe(`${code}:${longName}`)
    // 40 字的旧上限现在不再合法（限额收到 31），会降级为 unnamed —— 那也仍能穿过。
    const tooLong = 'a'.repeat(40)
    const degraded = firstFailedCheck(code, [[tooLong, false]])!
    expect(degraded).toBe(`${code}:unnamed`)
    expect(passes(degraded)).toBe(degraded)
  })

  it('a Chinese field name degrades to unnamed and still survives (nothing dirty leaks)', () => {
    const produced = firstFailedCheck(code, [['这是中文', false]])!
    expect(produced).toBe(`${code}:unnamed`)
    expect(passes(produced)).toBe(produced)
    expect(passes(produced)).not.toContain('这是中文')
  })

  it('every code prefix the tool is used with today survives', () => {
    // 本仓现有调用点的码（新增时把名字加进来 —— 这条会立刻覆盖到它）。
    const codes = [
      'GENERATION_RUN_IDENTITY_MISMATCH',
      'GENERATION_REVIEW_CONTEXT_MISMATCH',
    ]
    for (const prefix of codes) {
      const produced = firstFailedCheck(prefix, [['a', false], ['b', false]])!
      expect(passes(produced), prefix).toBe(produced)
    }
  })

  it('a genuine non-code message still falls back (the whitelist is not wide open)', () => {
    // 反面：白名单放宽到允许逗号，但**不允许中文 / 空格 / 任意长文本**。
    expect(passes('第三方库抛出的真实原因')).toContain('GENERATION_REQUEST_FAILED:')
    expect(passes('GENERATION_X_MISMATCH:a b')).toContain('GENERATION_REQUEST_FAILED:')
    expect(passes(`${'x'.repeat(400)}`)).toContain('GENERATION_REQUEST_FAILED:')
  })
})