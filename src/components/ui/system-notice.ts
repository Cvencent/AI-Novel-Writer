/**
 * 全局 `SYSTEM_NOTICE` 的出口（issue #25）。
 *
 * `runProjectEventTask`（后台刷新失败的统一兜底）与 `AppLogger` 都只发这个事件，
 * 而全仓没有任何订阅者，于是「某某失败」永远不显示、用户只看到「点了没反应」。
 * 这里把它映射到既有的右下角提示栈（同一套 tone 与去重规则），一个接线修好全部发出方。
 */
import { globalEventBus } from '../../shared/event-bus'
import { pushToast, type ToastTone } from './ToastStack'

export interface SystemNoticeInput {
  level: 'info' | 'success' | 'warn' | 'error'
  message: string
}

export interface SystemNoticeToast {
  tone: ToastTone
  message: string
  duration: number
}

/**
 * 事件 → 提示栈条目。纯映射，便于直接断言：
 * 失败(pinned)留 8 秒够读完日志行，提醒 6 秒，其余用普通通知的默认时长。
 */
export function systemNoticeToast({ level, message }: SystemNoticeInput): SystemNoticeToast | null {
  const trimmed = message.trim()
  if (!trimmed) return null
  switch (level) {
    case 'error': return { tone: 'danger', message: trimmed, duration: 8000 }
    case 'warn': return { tone: 'warn', message: trimmed, duration: 6000 }
    case 'success': return { tone: 'ok', message: trimmed, duration: 3500 }
    default: return { tone: 'info', message: trimmed, duration: 4000 }
  }
}

/** 订阅并显示系统通知；返回解绑函数。 */
export function subscribeSystemNotices(): () => void {
  return globalEventBus.on('SYSTEM_NOTICE', notice => {
    const entry = systemNoticeToast(notice)
    if (entry) pushToast(entry)
  })
}