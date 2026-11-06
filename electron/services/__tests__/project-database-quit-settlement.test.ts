/**
 * issue #207：退出时必须结算在途运行，且收尾失败不许把「关不掉」变成新问题。
 */
import { describe, expect, it, vi } from 'vitest'

import { installProjectDatabaseQuitSettlement } from '../project-database-quit-settlement'

function host() {
  const listeners: Array<() => void> = []
  return { listeners, onWillQuit: (listener: () => void) => { listeners.push(listener) } }
}

describe('installProjectDatabaseQuitSettlement (issue #207)', () => {
  it('closes the project database on will-quit', () => {
    const h = host(), close = vi.fn(), log = vi.fn()
    installProjectDatabaseQuitSettlement(h, close, log)
    // 注册阶段不许提前关库。
    expect(close).not.toHaveBeenCalled()
    expect(h.listeners).toHaveLength(1)
    h.listeners[0]!()
    expect(close).toHaveBeenCalledOnce()
    expect(log).not.toHaveBeenCalled()
  })

  it('never blocks quitting when the settlement throws', () => {
    // `suspendForProjectClose` 会抛 GENERATION_UNSAVED_TAIL_PRESENT 这类错误；
    // 退出路径上必须吞掉，否则应用关不掉。
    const h = host(), close = vi.fn(() => { throw new Error('GENERATION_UNSAVED_TAIL_PRESENT') }), log = vi.fn()
    installProjectDatabaseQuitSettlement(h, close, log)
    expect(() => h.listeners[0]!()).not.toThrow()
    expect(log).toHaveBeenCalledOnce()
    expect(String((log.mock.calls[0]![0] as Error).message)).toContain('GENERATION_UNSAVED_TAIL_PRESENT')
  })

  it('is idempotent across repeated quit events (closeProjectDatabase already is)', () => {
    const h = host(), close = vi.fn(), log = vi.fn()
    installProjectDatabaseQuitSettlement(h, close, log)
    h.listeners[0]!()
    h.listeners[0]!()
    // 两次都调用；真正的幂等由 closeProjectDatabase 自己保证（无项目库时是空操作）。
    expect(close).toHaveBeenCalledTimes(2)
    expect(log).not.toHaveBeenCalled()
  })
})