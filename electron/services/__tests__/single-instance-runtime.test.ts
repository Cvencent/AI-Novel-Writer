import { describe, expect, it, vi } from 'vitest'

import { configureSingleInstanceRuntime } from '../single-instance-runtime'
import { focusExistingInstance, handleSecondInstance, isExistingInstanceUsable } from '../single-instance-recovery'

describe('single-instance runtime', () => {
  it('does not interfere with isolated packaged release smoke processes', () => {
    const requestLock = vi.fn(() => false)
    const quit = vi.fn()
    const onSecondInstance = vi.fn()

    expect(configureSingleInstanceRuntime({
      releaseSmokeRequested: true,
      requestLock,
      quit,
      onSecondInstance,
      getWindow: () => null,
    })).toBe(true)
    expect(requestLock).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
    expect(onSecondInstance).not.toHaveBeenCalled()
  })

  it('quits an ordinary secondary instance before startup work begins', () => {
    const quit = vi.fn()
    const onSecondInstance = vi.fn()

    expect(configureSingleInstanceRuntime({
      releaseSmokeRequested: false,
      requestLock: () => false,
      quit,
      onSecondInstance,
      getWindow: () => null,
    })).toBe(false)
    expect(quit).toHaveBeenCalledOnce()
    expect(onSecondInstance).not.toHaveBeenCalled()
  })

  it('restores and focuses the primary window after a second launch', () => {
    let listener: (() => void) | undefined
    const restore = vi.fn()
    const show = vi.fn()
    const focus = vi.fn()

    expect(configureSingleInstanceRuntime({
      releaseSmokeRequested: false,
      requestLock: () => true,
      quit: vi.fn(),
      onSecondInstance: next => { listener = next },
      getWindow: () => ({
        isDestroyed: () => false,
        isMinimized: () => true,
        // issue #90 起窗口可用性还要看 isVisible（不可见 = 黑屏/跑到别的桌面，
        // 聚焦它等于没做，改走恢复对话框）。
        isVisible: () => true,
        restore,
        show,
        focus,
      }),
    })).toBe(true)

    listener?.()
    expect(restore).toHaveBeenCalledOnce()
    expect(show).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledOnce()
  })
})

// issue #90：已有实例占着锁、但它的**窗口不可见/黑屏**时，用户再双击会被静默拒绝
// （`exitCode=0`、无提示、无崩溃报告）。实测那次是 GPU 挂起后窗口全黑，
// 用户反复双击都打不开，只能靠任务管理器杀进程 + 手删 lockfile 才恢复。
describe('single-instance recovery when the existing window is unusable (issue #90)', () => {
  const window = (over: Partial<{ destroyed: boolean; minimized: boolean; visible: boolean }> = {}) => {
    const state = { destroyed: false, minimized: false, visible: true, ...over }
    return {
      isDestroyed: () => state.destroyed,
      isMinimized: () => state.minimized,
      isVisible: () => state.visible,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    }
  }

  it('treats a destroyed window as unusable', () => {
    expect(isExistingInstanceUsable(window({ destroyed: true }))).toBe(false)
    expect(isExistingInstanceUsable(null)).toBe(false)
    expect(isExistingInstanceUsable(undefined)).toBe(false)
  })

  it('treats an invisible window as unusable — focusing it would show the user nothing', () => {
    expect(isExistingInstanceUsable(window({ visible: false }))).toBe(false)
  })

  it('treats a minimized but visible window as usable (restore() brings it back)', () => {
    expect(isExistingInstanceUsable(window({ minimized: true }))).toBe(true)
  })

  it('does not claim to have focused a window the user cannot see', () => {
    const target = window({ visible: false })
    expect(focusExistingInstance(target)).toBe(false)
    // 关键：不能"成功聚焦"一个看不见的窗口——那正是死局的来源。
    expect(target.focus).not.toHaveBeenCalled()
  })

  it('asks the user to reopen instead of silently doing nothing', () => {
    const recoverByRestart = vi.fn()
    const askToRestart = vi.fn((_options: unknown) => true)
    const result = handleSecondInstance({
      getWindow: () => window({ visible: false }),
      recoverByRestart,
      askToRestart,
      log: vi.fn(),
      locale: 'zh-CN',
    })
    expect(askToRestart).toHaveBeenCalledOnce()
    // 文案必须如实说明「窗口无法显示」并给可执行的出路，而不是只说「已有一个实例」。
    const options = askToRestart.mock.calls[0]![0] as { message: string; detail: string; buttons: string[] }
    expect(options.message).toContain('无法显示')
    expect(options.detail).toContain('重新打开')
    expect(options.buttons[0]).toBe('重新打开')
    expect(recoverByRestart).toHaveBeenCalledOnce()
    expect(result).toBe(true)
  })

  it('leaves the instance alone when the user cancels', () => {
    const recoverByRestart = vi.fn()
    const result = handleSecondInstance({
      getWindow: () => window({ visible: false }),
      recoverByRestart,
      askToRestart: vi.fn(() => false),
      log: vi.fn(),
      locale: 'zh-CN',
    })
    expect(result).toBe(false)
    expect(recoverByRestart).not.toHaveBeenCalled()
  })

  it('just focuses when the window is usable — no dialog, no restart', () => {
    const target = window()
    const askToRestart = vi.fn((_options: unknown) => true)
    const recoverByRestart = vi.fn()
    expect(handleSecondInstance({
      getWindow: () => target,
      recoverByRestart,
      askToRestart,
      log: vi.fn(),
      locale: 'zh-CN',
    })).toBe(true)
    expect(target.focus).toHaveBeenCalledOnce()
    expect(askToRestart).not.toHaveBeenCalled()
    expect(recoverByRestart).not.toHaveBeenCalled()
  })

  it('logs the rejection so an unopenable app is at least traceable (issue #90 point 4)', () => {
    const log = vi.fn()
    handleSecondInstance({
      getWindow: () => window({ visible: false }),
      recoverByRestart: vi.fn(),
      askToRestart: vi.fn(() => false),
      log,
      locale: 'zh-CN',
    })
    expect(log.mock.calls.map(call => String(call[0])).join('\n')).toContain('single-instance')
  })

  it('uses English copy for the English locale', () => {
    const askToRestart = vi.fn((_options: unknown) => false)
    handleSecondInstance({
      getWindow: () => window({ visible: false }),
      recoverByRestart: vi.fn(),
      askToRestart,
      log: vi.fn(),
      locale: 'en-US',
    })
    const options = askToRestart.mock.calls[0]![0] as { message: string; buttons: string[] }
    expect(options.buttons[0]).toBe('Reopen')
    expect(options.message).toContain('cannot be displayed')
  })

  it('bypasses the lock entirely for --force-new-instance (escape hatch)', () => {
    const requestLock = vi.fn(() => false)
    const quit = vi.fn()
    expect(configureSingleInstanceRuntime({
      releaseSmokeRequested: false,
      requestLock,
      quit,
      onSecondInstance: vi.fn(),
      getWindow: () => null,
      forceNewInstance: true,
    })).toBe(true)
    expect(requestLock).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
  })

  it('offers the recovery dialog from the primary instance on a second launch', () => {
    // second-instance 事件在主实例里触发——所以对话框要挂在 onSecondInstance 上，
    // 第二个进程没有别人的窗口可看（这是 #90 修复里最容易搞错的一点）。
    let listener: (() => void) | undefined
    const askToRestart = vi.fn((_options: unknown) => false)
    configureSingleInstanceRuntime({
      releaseSmokeRequested: false,
      requestLock: () => true,
      quit: vi.fn(),
      onSecondInstance: next => { listener = next },
      getWindow: () => ({
        isDestroyed: () => false,
        isMinimized: () => false,
        isVisible: () => false,
        restore: vi.fn(), show: vi.fn(), focus: vi.fn(),
      }),
      recovery: { recoverByRestart: vi.fn(), askToRestart, log: vi.fn(), locale: 'zh-CN' },
    })
    listener?.()
    expect(askToRestart).toHaveBeenCalledOnce()
  })

  it('logs on the rejected second process so the silent exit is at least traceable', () => {
    const log = vi.fn()
    configureSingleInstanceRuntime({
      releaseSmokeRequested: false,
      requestLock: () => false,
      quit: vi.fn(),
      onSecondInstance: vi.fn(),
      getWindow: () => null,
      recovery: { recoverByRestart: vi.fn(), askToRestart: vi.fn(), log, locale: 'zh-CN' },
    })
    expect(log).toHaveBeenCalledOnce()
  })
})
