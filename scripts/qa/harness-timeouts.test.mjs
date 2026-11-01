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
// issue #46：细纲续写入口按状态选，不能硬点不存在的按钮。
import { continueSynopsis } from '../redesign/pages/architecture.mjs'
// issue #53：写正文前的「一致性预检」弹层要按状态处理，否则永远停在「带提醒继续写」。
import * as blueprintPage from '../redesign/pages/blueprint.mjs'

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

/**
 * issue #46：user-sim 的「确保细纲」硬点「继续生成架构」，但五节全确认时那个按钮不存在
 * （主按钮是禁用的「下一步：章节蓝图」），于是每轮白等 120 秒；旧代码还会填范围 1–to，
 * 一旦成功就把已写好的 1–11 章整批重写。
 * continueSynopsis 必须按状态选入口，并且两条路都不显式覆盖已写章节。
 */
describe('architecture.continueSynopsis', () => {
  /** 只实现 continueSynopsis 用到的三个选择器：顶部按钮、section 的更多操作、菜单项、对话框。 */
  const fakePage = ({ continuous, menuEntry }) => {
    const clicks = []
    const buttonTexts = continuous
      ? ['一键生成全部剩余细纲']
      : ['下一步：章节蓝图', 'AI 生成架构']
    const continuousButton = {
      count: async () => (continuous ? 1 : 0),
      first: () => ({ click: async () => { clicks.push('continuous') } }),
    }
    const menuButton = { click: async () => { clicks.push('menu') } }
    const entry = {
      waitFor: async () => { if (!menuEntry) throw new Error('no entry') },
      click: async () => { clicks.push('entry') },
    }
    const dialog = { waitFor: async () => { clicks.push('dialog') } }
    const allButtons = { allInnerTexts: async () => buttonTexts }
    const region = { getByRole: (role, options) => (options?.name === '「情节大纲」的更多操作' ? menuButton : allButtons) }
    const rootLocator = {
      locator: () => ({ getByRole: (role, options) => (options?.name === '一键生成全部剩余细纲' ? continuousButton : region) }),
      getByRole: (role, options) => (options?.name === '一键生成全部剩余细纲' ? continuousButton : region),
    }
    const page = {
      getByRole: (role, options) => {
        if (role === 'button' && options?.name === '一键生成全部剩余细纲') return continuousButton
        if (role === 'menuitem') return entry
        if (role === 'dialog') return dialog
        if (role === 'button') return allButtons
        if (role === 'region') return region
        return { waitFor: async () => {}, isVisible: async () => false, locator: () => ({}) }
      },
    }
    page.locator = selector => (selector === '.stage' ? rootLocator : { locator: () => rootLocator, getByRole: rootLocator.getByRole })
    return { page, clicks }
  }

  it('有「一键生成全部剩余细纲」时优先走连续生成（范围由应用自己算，不覆盖已写章节）', async () => {
    const f = fakePage({ continuous: true, menuEntry: true })
    await expect(continueSynopsis(f.page)).resolves.toBe('continuous')
    expect(f.clicks).toEqual(['continuous'])
  })

  it('没有连续生成入口时走「更多操作 → 一次生成全部剩余大纲…」', async () => {
    const f = fakePage({ continuous: false, menuEntry: true })
    await expect(continueSynopsis(f.page)).resolves.toBe('dialog')
    expect(f.clicks).toEqual(['menu', 'entry', 'dialog'])
  })

  it('两个入口都不在时抛出带按钮清单的错误（不再只给 Timeout）', async () => {
    const f = fakePage({ continuous: false, menuEntry: false })
    await expect(continueSynopsis(f.page)).rejects.toThrow(/细纲续写入口不存在；当前按钮：/)
  })
})

/**
 * issue #50：`.stage-capsule[aria-expanded="true"]` 只在「有运行且侧页展开」时存在。
 * 直接 click 会等满默认超时（120 秒）再抛错，被 .catch 吞掉后就变成「每轮白等 120 秒却打 ✓」。
 * collapseCapsule 必须先数元素再点，并把点不动的原因回报给调用方。
 */
describe('run-sheet.collapseCapsule (issue #50)', () => {
  const fakeCapsulePage = ({ count, clickFails = false }) => {
    const clicks = []
    const locator = {
      count: async () => count,
      first: () => ({ click: async () => { clicks.push('click'); if (clickFails) throw new Error('intercepted') } }),
    }
    return { page: { locator: () => locator }, clicks }
  }

  it('胶囊不存在时立即返回 no-capsule（不再等满超时）', async () => {
    const f = fakeCapsulePage({ count: 0 })
    expect(await runSheet.collapseCapsule(f.page)).toBe('no-capsule')
    expect(f.clicks).toEqual([])
  })

  it('胶囊存在时点它并回报 collapsed', async () => {
    const f = fakeCapsulePage({ count: 1 })
    expect(await runSheet.collapseCapsule(f.page)).toBe('collapsed')
    expect(f.clicks).toEqual(['click'])
  })

  it('胶囊在但点不动时回报原因，而不是静默吞掉', async () => {
    const f = fakeCapsulePage({ count: 1, clickFails: true })
    const outcome = await runSheet.collapseCapsule(f.page)
    expect(outcome).toContain('failed:')
    expect(outcome).toContain('intercepted')
  })
})

/**
 * issue #53：预检有提醒时应用不会直接开写，而是把弹层打开、把「带提醒继续写」做成显式按钮。
 * 点完「写第 N 章」就去等运行的 harness 会永远停在这一层（实测 6 分钟零正文调用）。
 * continuePastPreflight 必须按状态判断：没有弹层就立即返回，有按钮就点它。
 */
describe('blueprint.continuePastPreflight (issue #53)', () => {
  const fakeWritePage = ({ dialogVisible, hasContinue }) => {
    const clicks = []
    const dialog = {
      waitFor: async () => { if (!dialogVisible) throw new Error('Timeout') },
      innerText: async () => '一致性预检 · 3 条线索提醒 任九不在角色卡',
      getByRole: () => ({
        count: async () => (hasContinue ? 1 : 0),
        first: () => ({ click: async () => { clicks.push('continue') } }),
      }),
    }
    return { page: { locator: () => ({ first: () => dialog }) }, clicks }
  }

  it('没有弹层时立即返回 no-dialog（正常章节形态）', async () => {
    const f = fakeWritePage({ dialogVisible: false, hasContinue: true })
    await expect(blueprintPage.continuePastPreflight(f.page)).resolves.toEqual({ outcome: 'no-dialog' })
    expect(f.clicks).toEqual([])
  })

  it('弹层带「带提醒继续写」时点它，并把提醒摘要带回去', async () => {
    const f = fakeWritePage({ dialogVisible: true, hasContinue: true })
    const result = await blueprintPage.continuePastPreflight(f.page)
    expect(result.outcome).toBe('continued')
    expect(result.summary).toContain('一致性预检')
    expect(f.clicks).toEqual(['continue'])
  })

  it('弹层在但没有该按钮时如实回报（可能不是预检弹层）', async () => {
    const f = fakeWritePage({ dialogVisible: true, hasContinue: false })
    const result = await blueprintPage.continuePastPreflight(f.page)
    expect(result.outcome).toBe('no-continue-button')
    expect(result.summary).toContain('一致性预检')
    expect(f.clicks).toEqual([])
  })
})
