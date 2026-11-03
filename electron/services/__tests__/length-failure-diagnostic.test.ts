import { describe, expect, it } from 'vitest'

import { lengthFailureDiagnostic } from '../main-generation-owner'

/**
 * 非 `stop` 终态的**可诊断**记录（issue #121）。
 *
 * 缺陷形态：`error_message` 一律是 `finish:length`，而实测那本 24 章的书里，
 * 16 次撞顶中 **15 次是「推理把输出预算吃满、正文一个字没写出来」**（产物为空），
 * 只有 1 次是「报告写到一半被截断」。两者被记成同一个字符串，
 * 于是作者与 QA 都会判成「报告太长、需要拆分」——**方向完全错**。
 *
 * 这里钉住判据：`reasoningTokens` 与输出上限的比较是**结构性的**（不枚举文案/码值）。
 */
describe('lengthFailureDiagnostic (issue #121)', () => {
  it('keeps a plain reason when the cap was consumed by the report itself', () => {
    // 没有推理用量（或推理占比很低）→ 只报 finish:length，不额外下结论。
    expect(lengthFailureDiagnostic('length', { completionTokens: 24576 }, null)).toBe('finish:length')
    expect(lengthFailureDiagnostic('length', { completionTokens: 24576 }, 0)).toBe('finish:length')
  })

  it('flags reasoning-exhausted when reasoning takes the whole output budget', () => {
    // 实测形态：reasoning 恰好等于输出上限、产物为空。
    expect(lengthFailureDiagnostic('length', { completionTokens: 24576 }, 24576))
      .toBe('finish:length reasoning=24576/24576 reasoning-exhausted')
    // 8192 档（#26 时代的上限）同样会被打满。
    expect(lengthFailureDiagnostic('length', { completionTokens: 8192 }, 8192))
      .toBe('finish:length reasoning=8192/8192 reasoning-exhausted')
  })

  it('does not flag exhausted when reasoning left room for visible output', () => {
    // reasoning 只占一半 → 那是「正文写到上限被截断」，不是推理吃满。
    const diagnostic = lengthFailureDiagnostic('length', { completionTokens: 24576 }, 12000)
    expect(diagnostic).toBe('finish:length reasoning=12000/24576')
    expect(diagnostic).not.toContain('reasoning-exhausted')
  })

  it('treats the 90% boundary as exhausted (measured shape, not a guess)', () => {
    expect(lengthFailureDiagnostic('length', { completionTokens: 10000 }, 9000)).toContain('reasoning-exhausted')
    expect(lengthFailureDiagnostic('length', { completionTokens: 10000 }, 8999)).not.toContain('reasoning-exhausted')
  })

  it('degrades safely when completion tokens are unknown', () => {
    // 上游没给 completion 用量时：仍记录 reasoning 数值，但不擅自判「吃满」。
    const diagnostic = lengthFailureDiagnostic('length', null, 24576)
    expect(diagnostic).toBe('finish:length reasoning=24576')
    expect(diagnostic).not.toContain('reasoning-exhausted')
  })

  it('carries other non-stop reasons through unchanged', () => {
    expect(lengthFailureDiagnostic('content_filter', {}, null)).toBe('finish:content_filter')
  })

  it('never leaks prose or free text into the diagnostic (only numbers and reason)', () => {
    const diagnostic = lengthFailureDiagnostic('length', { completionTokens: 24576 }, 24576)
    expect(diagnostic).toMatch(/^finish:[a-z_]+( reasoning=\d+(\/\d+)?( reasoning-exhausted)?)?$/u)
  })
})