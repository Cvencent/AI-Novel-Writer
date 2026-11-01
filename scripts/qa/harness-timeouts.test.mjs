/**
 * QA harness 收尾兜底回归（issue #31）：
 * sim 撞上覆盖安装把 renderer 弄崩后，收尾的 `page.evaluate` 等的是「目标可用」而非
 * selector，默认超时失效、永不返回 → 阻塞在 finally → app 永不关闭、报告不落盘、
 * 下一轮被单实例锁挡死。这里锁住「永不 settle 也会被超时抢回控制权」这一条。
 */
import { describe, expect, it, vi } from 'vitest'

import { closeAppWithTimeout, withTimeout } from './harness-timeouts.mjs'

const never = () => new Promise(() => {})

describe('withTimeout (issue #31)', () => {
  it('永不 settle 的 Promise 会被硬超时中断，而不是无限等待', async () => {
    const started = Date.now()
    await expect(withTimeout(never(), 120, 'finalScreen 采集')).rejects.toThrow(/超时（120ms）/)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('正常 Promise 原样返回，不被超时影响', async () => {
    expect(await withTimeout(Promise.resolve('ok'), 500, 'x')).toBe('ok')
    await expect(withTimeout(Promise.reject(new Error('boom')), 500, 'x')).rejects.toThrow('boom')
  })

  it('超时后定时器被清掉，不留下悬挂的 timer', async () => {
    vi.useFakeTimers()
    try {
      const settled = await withTimeout(Promise.resolve(1), 60_000, 'x')
      expect(settled).toBe(1)
      // 若定时器没清，进程会多挂 60 秒；这里跑完全部伪时钟应当无事发生。
      await vi.advanceTimersByTimeAsync(120_000)
    } finally { vi.useRealTimers() }
  })
})

describe('closeAppWithTimeout (issue #31)', () => {
  it('app.close() 正常完成时不触碰进程', async () => {
    const close = vi.fn(async () => {})
    const app = { close, process: () => ({ pid: 4321 }) }
    await expect(closeAppWithTimeout(app, { ms: 500, log: () => {} })).resolves.toMatchObject({ closed: 'graceful' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('app.close() 挂住时退回 PID 兜底（不会无限等待）', async () => {
    const logs = []
    const app = { close: () => never(), process: () => ({ pid: -1 }) }   // 非法 pid：跳过真实 kill
    const result = await closeAppWithTimeout(app, { ms: 120, log: message => logs.push(message) })
    expect(result).toMatchObject({ closed: 'failed', pid: -1 })          // pid 不合法 → 只记日志、不 kill
    expect(logs.join('\n')).toContain('app.close 未在超时内完成')
  })
})