import { describe, expect, it, vi } from 'vitest'

import { isTransientTransportError, withTransientRetry } from '../transient-retry'

// issue #85：`GENERATION_PROVIDER_FAILED` 在四个链路上出现（定稿后处理/细纲/审稿/起草），
// 而原来只有细纲那条有重试——它走架构工作流，四个步骤各自被 withTransientRetry 包住；
// 起草/审稿/定稿走章节工作流，步骤执行器**没有任何传输重试**，一次抖动就整步失败。
describe('isTransientTransportError', () => {
  it('matches the transport codes the command layer appends in brackets', () => {
    expect(isTransientTransportError(new Error('模型请求失败。 [GENERATION_PROVIDER_FAILED]'))).toBe(true)
    expect(isTransientTransportError(new Error('与模型的连接失败 [NETWORK_ERROR]'))).toBe(true)
  })

  it('matches a transport code carried on error.code', () => {
    expect(isTransientTransportError(Object.assign(new Error('x'), { code: 'GENERATION_PROVIDER_FAILED' }))).toBe(true)
  })

  it('does not treat a content failure as a transport failure', () => {
    // 输出撞顶重发同一个请求只会再撞一次——绝不能被当成通道问题重试。
    expect(isTransientTransportError(new Error('AI 输出达到本次请求长度限制，尚未完整生成。'))).toBe(false)
    expect(isTransientTransportError(new Error('AI 输出因内容限制而未完成，结果未被保存。'))).toBe(false)
    expect(isTransientTransportError(Object.assign(new Error('x'), { code: 'GENERATION_REVIEW_REPLACEMENT_LIMIT' }))).toBe(false)
  })

  it('does not match on free text that merely mentions the word', () => {
    // 只认 `[CODE]` 形态与 error.code，避免作者/日志里提到这个词就被当成传输失败。
    expect(isTransientTransportError(new Error('日志里出现过 GENERATION_PROVIDER_FAILED 这个词'))).toBe(false)
  })
})

describe('withTransientRetry (issue #85)', () => {
  const noWait = { backoffMs: () => 0 }

  it('returns the first successful result without retrying', async () => {
    const run = vi.fn().mockResolvedValue('ok')
    const log = vi.fn()
    await expect(withTransientRetry(run, log, noWait)).resolves.toBe('ok')
    expect(run).toHaveBeenCalledOnce()
    expect(log).not.toHaveBeenCalled()
  })

  it('retries a transport failure and returns the eventual success', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('模型请求失败。 [GENERATION_PROVIDER_FAILED]'))
      .mockRejectedValueOnce(new Error('模型请求失败。 [NETWORK_ERROR]'))
      .mockResolvedValueOnce('recovered')
    const log = vi.fn()
    await expect(withTransientRetry(run, log, noWait)).resolves.toBe('recovered')
    expect(run).toHaveBeenCalledTimes(3)
    // 每一次重试都要让作者在日志里看得见，而不是默默多等。
    expect(log).toHaveBeenCalledTimes(2)
    expect(String(log.mock.calls[0]![0])).toContain('第 1 次')
    expect(String(log.mock.calls[1]![0])).toContain('第 2 次')
  })

  it('gives up after the retry limit and rethrows the last error', async () => {
    const run = vi.fn().mockRejectedValue(new Error('[GENERATION_PROVIDER_FAILED]'))
    const log = vi.fn()
    await expect(withTransientRetry(run, log, noWait)).rejects.toThrow(/GENERATION_PROVIDER_FAILED/u)
    // 首次 + 2 次重试，不再无限重发。
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('does not retry a content failure', async () => {
    const run = vi.fn().mockRejectedValue(new Error('AI 输出达到本次请求长度限制，尚未完整生成。'))
    const log = vi.fn()
    await expect(withTransientRetry(run, log, noWait)).rejects.toThrow(/长度限制/u)
    expect(run).toHaveBeenCalledOnce()
    expect(log).not.toHaveBeenCalled()
  })

  it('never retries once the author cancelled', async () => {
    // 取消是意图，不是故障：重试会让「停止」按钮看起来失灵。
    const run = vi.fn().mockRejectedValue(new Error('[GENERATION_PROVIDER_FAILED]'))
    const log = vi.fn()
    await expect(withTransientRetry(run, log, { ...noWait, isCancelled: () => true })).rejects.toThrow()
    expect(run).toHaveBeenCalledOnce()
  })

  it('honours a custom limit and backoff schedule', async () => {
    const run = vi.fn().mockRejectedValue(new Error('[NETWORK_ERROR]'))
    const backoff = vi.fn((_attempt: number) => 0)
    await expect(withTransientRetry(run, vi.fn(), { limit: 4, backoffMs: backoff })).rejects.toThrow()
    expect(run).toHaveBeenCalledTimes(5)
    // 线性退避：第 1 次重试等 1 份，第 4 次等 4 份。
    expect(backoff.mock.calls.map(call => call[0])).toEqual([1, 2, 3, 4])
  })

  it('reports the retry count against the configured limit', async () => {
    const run = vi.fn().mockRejectedValue(new Error('[NETWORK_ERROR]'))
    const log = vi.fn()
    await expect(withTransientRetry(run, log, { limit: 1, backoffMs: () => 0 })).rejects.toThrow()
    expect(String(log.mock.calls[0]![0])).toContain('最多 1 次')
  })
})