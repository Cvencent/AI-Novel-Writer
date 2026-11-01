import { afterEach, describe, expect, it, vi } from 'vitest'

import { globalEventBus } from '../../../shared/event-bus'
import { subscribeSystemNotices, systemNoticeToast } from '../system-notice'
import * as toastStack from '../ToastStack'

// issue #25：SYSTEM_NOTICE 此前全仓零订阅者，runProjectEventTask/AppLogger 发出的
// 「某某失败」永远不会显示；这里锁住「事件 → 提示栈」这条出口。

afterEach(() => { vi.restoreAllMocks() })

describe('systemNoticeToast 映射（issue #25）', () => {
  it.each([
    ['error', 'danger', 8000],
    ['warn', 'warn', 6000],
    ['info', 'info', 4000],
    ['success', 'ok', 3500],
  ] as const)('level=%s 映射到 %s tone', (level, tone, duration) => {
    expect(systemNoticeToast({ level, message: '工作流完成后的项目刷新失败：项目会话已失效' }))
      .toEqual({ tone, message: '工作流完成后的项目刷新失败：项目会话已失效', duration })
  })

  it('空白消息不弹提示（不制造空卡片）', () => {
    expect(systemNoticeToast({ level: 'error', message: '   ' })).toBeNull()
  })

  it('消息两端空白被去掉', () => {
    expect(systemNoticeToast({ level: 'warn', message: '  蓝图刷新失败  ' })?.message).toBe('蓝图刷新失败')
  })
})

describe('SYSTEM_NOTICE 订阅接线（issue #25）', () => {
  it('订阅后 emit 一次会推入一条对应 tone 的提示，解绑后不再推入', () => {
    const push = vi.spyOn(toastStack, 'pushToast').mockReturnValue(() => {})
    const unsubscribe = subscribeSystemNotices()
    globalEventBus.emit('SYSTEM_NOTICE', { level: 'error', message: '工作流完成后的项目刷新失败：项目会话已失效' })
    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith({
      tone: 'danger', message: '工作流完成后的项目刷新失败：项目会话已失效', duration: 8000,
    })
    unsubscribe()
    globalEventBus.emit('SYSTEM_NOTICE', { level: 'error', message: '再来一次' })
    expect(push).toHaveBeenCalledTimes(1)
  })
})