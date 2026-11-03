import { describe, expect, it, vi } from 'vitest'

import {
  SLOW_OPERATION_THRESHOLD_MS,
  timeSyncOperation,
  type SlowOperationReport,
} from '../slow-operation-log'

/**
 * issue #104 第 ⑥ 条：主进程一条长任务日志都没有——那次「切页打字卡、最小化恢复不了」
 * 用进程采样 + CPU profile 花了两轮才落到「77% 在 SQLite 全表读」。
 * 这条判据补齐最小可观测性：同步操作超阈值就带上标签与耗时打一条日志。
 */
describe('timeSyncOperation (issue #104 ⑥)', () => {
  it('returns the operation result unchanged', () => {
    expect(timeSyncOperation('x', () => 42, { now: () => 0 })).toBe(42)
  })

  it('does NOT report a fast operation', () => {
    const reporter = vi.fn()
    let clock = 0
    timeSyncOperation('domain-scan:characters', () => 'ok', { now: () => clock, reporter, thresholdMs: 200 })
    clock = 150
    timeSyncOperation('domain-scan:characters', () => 'ok', { now: () => clock, reporter, thresholdMs: 200 })
    expect(reporter).not.toHaveBeenCalled()
  })

  it('reports a slow operation with its label and elapsed time', () => {
    const reports: SlowOperationReport[] = []
    let n = 0
    timeSyncOperation('domain-scan:llm_calls', () => 'ok', {
      now: () => (n++ === 0 ? 0 : 2500),
      reporter: report => reports.push(report),
      thresholdMs: 200,
    })
    expect(reports).toHaveLength(1)
    expect(reports[0]!.label).toBe('domain-scan:llm_calls')
    expect(reports[0]!.elapsedMs).toBe(2500)
    expect(reports[0]!.thresholdMs).toBe(200)
  })

  it('reports exactly at the threshold (>=, not >)', () => {
    const reports: SlowOperationReport[] = []
    let n = 0
    timeSyncOperation('x', () => 'ok', {
      now: () => (n++ === 0 ? 0 : 200),
      reporter: report => reports.push(report),
      thresholdMs: 200,
    })
    expect(reports).toHaveLength(1)
  })

  it('still reports when the operation throws, and rethrows unchanged', () => {
    const reporter = vi.fn()
    let n = 0
    let caught: unknown
    try {
      timeSyncOperation('domain-scan:big_table', () => { throw new Error('boom') }, {
        now: () => (n++ === 0 ? 0 : 900),
        reporter,
        thresholdMs: 200,
      })
    } catch (error) { caught = error }
    expect((caught as Error).message).toBe('boom')
    expect(reporter).toHaveBeenCalledTimes(1)
  })

  it('never lets a failing reporter break the caller', () => {
    let n = 0
    // 上报自身抛异常也要吞掉——日志不能影响主流程。
    expect(timeSyncOperation('x', () => 'value', {
      now: () => (n++ === 0 ? 0 : 999),
      reporter: () => { throw new Error('reporter down') },
      thresholdMs: 200,
    })).toBe('value')
  })

  it('defaults to the documented 200ms threshold', () => {
    expect(SLOW_OPERATION_THRESHOLD_MS).toBe(200)
  })
})