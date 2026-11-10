import { describe, expect, it } from 'vitest'
import { deepCheckSummary } from '../deep-review-service'

/**
 * issue #245 现场：深度检查跑完 1 分 49 秒、13 次模型调用全部成功，结果一个字都看不见。
 * 摘要必须给出「跑了几维、几处发现、哪几维失败」，且**不依赖切页**（它是 executor 的返回值，
 * 也就是运行卡片那一步的详情）。
 */
describe('deepCheckSummary (issue #245)', () => {
  it('reports dimensions, findings, and where to read them', () => {
    const summary = deepCheckSummary({
      total: 13, lines: ['a', 'b', 'c'],
      findings: [{}, {}] as never,
      failures: [], cancelled: false,
    }, 'zh-CN')
    expect(summary).toContain('3/13')
    expect(summary).toContain('2 处发现')
    expect(summary).toContain('AI 检查 · 本章')
  })

  it('names the failed dimensions instead of hiding them', () => {
    const summary = deepCheckSummary({
      total: 2, lines: ['a'], findings: [],
      failures: [{ key: 'ability', error: 'boom' }], cancelled: false,
    }, 'zh-CN')
    expect(summary).toContain('1 维失败')
    expect(summary).toContain('能力限制')
  })

  it('says so when the run was cancelled instead of claiming completion', () => {
    const summary = deepCheckSummary({
      total: 5, lines: ['a'], findings: [], failures: [], cancelled: true,
    }, 'zh-CN')
    expect(summary).toContain('已取消')
    expect(summary).not.toContain('完成')
  })

  it('localizes to English without leaking the Chinese labels', () => {
    const summary = deepCheckSummary({
      total: 2, lines: ['a'], findings: [{}, {}] as never,
      failures: [{ key: 'ability', error: 'boom' }], cancelled: false,
    }, 'en-US')
    expect(summary).toContain('2 finding(s)')
    expect(summary).toContain('Ability limits')
    expect(summary).not.toMatch(/[\u4e00-\u9fff]/u)
  })

  it('omits the pointer when there is nothing to read', () => {
    const summary = deepCheckSummary({ total: 1, lines: ['a'], findings: [], failures: [], cancelled: false }, 'zh-CN')
    expect(summary).toContain('0 处发现')
    expect(summary).not.toContain('AI 检查 · 本章')
  })
})
