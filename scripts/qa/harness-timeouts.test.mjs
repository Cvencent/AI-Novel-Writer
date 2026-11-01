/**
 * QA harness 收尾兜底回归（issue #31）：
 * sim 撞上覆盖安装把 renderer 弄崩后，收尾的 `page.evaluate` 等的是「目标可用」而非
 * selector，默认超时失效、永不返回 → 阻塞在 finally → app 永不关闭、报告不落盘、
 * 下一轮被单实例锁挡死。这里锁住「永不 settle 也会被超时抢回控制权」这一条。
 */
import { describe, expect, it, vi } from 'vitest'

import { closeAppWithTimeout, withTimeout } from './harness-timeouts.mjs'
// 审稿等待时长回归（issue #37）：review() 此前写死 60 秒，而实测审稿要 178–191 秒，
// 于是 user-sim 每轮把「生成慢」判成「界面不出审稿报告」、同一章被反复重写 12 版。
import { review } from '../redesign/pages/chapter-view.mjs'
// issue #39：运行侧页成功后不自己收起，下一步会被它挡住。
import * as runSheet from '../redesign/pages/run-sheet.mjs'

/** 只提供 review() 用到的三个选择器与 waitFor，不拉起真实浏览器。 */
function fakeReviewPage({ visible = false } = {}) {
  const waits = []
  const sheet = {
    waitFor: async options => {
      waits.push(options)
      if (!visible) throw new Error(`locator.waitFor: Timeout ${options.timeout}ms exceeded.`)
    },
    isVisible: async () => visible,
  }
  const clicks = []
  const button = { click: async () => { clicks.push('ai-review') } }
  const viewLocator = { getByRole: () => button }
  const rootLocator = { locator: () => viewLocator }
  return { page: { locator: () => rootLocator, getByRole: () => sheet }, waits, clicks }
}

describe('chapter-view.review wait budget (issue #37)', () => {
  it('默认仍等 60 秒（不动其它场景脚本的既有行为）', async () => {
    const f = fakeReviewPage()
    await expect(review(f.page)).rejects.toThrow('Timeout 60000ms exceeded')
    expect(f.waits).toEqual([{ state: 'visible', timeout: 60_000 }])
    expect(f.clicks).toEqual(['ai-review'])
  })

  it('调用方给了时长就照调用方的等——这正是 user-sim 需要的那条路', async () => {
    const f = fakeReviewPage()
    await expect(review(f.page, { timeoutMs: 12 * 60_000 })).rejects.toThrow('Timeout 720000ms exceeded')
    expect(f.waits).toEqual([{ state: 'visible', timeout: 720_000 }])
  })

  it('timeoutMs=0 表示点完就返回，不等待（给外层统一等待的调用方用）', async () => {
    const f = fakeReviewPage()
    await expect(review(f.page, { timeoutMs: 0 })).resolves.toBeUndefined()
    expect(f.waits).toEqual([])
    expect(f.clicks).toEqual(['ai-review'])
  })
})

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
/**
 * issue #39 的 harness 侧：粗纲续生成成功后运行侧页不会自己收起，下一步
 * 「确保蓝图」会因为它挡着而直接失败（本轮 3 个步骤全废）。
 * closeIfOpen 必须是「开着就收、收着就返回 true」的幂等动作。
 */
describe('run-sheet.closeIfOpen', () => {
  const fakeSheetPage = ({ visible, hidden }) => {
    const clicks = []
    const sheet = {
      isVisible: async () => visible(),
      waitFor: async () => {
        if (!hidden()) throw new Error('Timeout')
      },
      getByRole: () => ({ count: async () => 1, first: () => ({ click: async () => { clicks.push('close'); visible(false) } }) }),
    }
    return { page: { getByRole: () => sheet, keyboard: { press: async () => {} } }, clicks }
  }

  it('侧页已收起时不动作，直接返回 true', async () => {
    const f = fakeSheetPage({ visible: () => false, hidden: () => true })
    expect(await runSheet.closeIfOpen(f.page)).toBe(true)
    expect(f.clicks).toEqual([])
  })

  it('侧页开着时点「收起运行侧页」并确认它真的收起', async () => {
    const f = fakeSheetPage({ visible: () => true, hidden: () => false })
    expect(await runSheet.closeIfOpen(f.page)).toBe(false)   // 点了但假 page 的 hidden 仍为 false
    expect(f.clicks).toEqual(['close'])
  })
})
