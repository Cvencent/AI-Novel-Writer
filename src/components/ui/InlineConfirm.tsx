import { useEffect, useId, useRef, type KeyboardEvent } from 'react'
import { Button } from './Button'
import { rememberFocus } from './focus-return'

interface InlineConfirmProps {
  /** 写明后果与能否恢复，例如「清空后无法恢复这 12 条日志」。 */
  message: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  onCancel: () => void
}

/**
 * 侧页内影响较小的危险操作用的就地确认条。出现时焦点落在取消上，Esc 取消。
 * 确认条一消失焦点就丢了：还给打开它的按钮，按钮已被替换或已禁用（清空后无日志可清）时落到最近的可聚焦祖先。
 */
export function InlineConfirm({ message, confirmLabel, cancelLabel, onConfirm, onCancel }: InlineConfirmProps) {
  const messageId = useId()
  const groupRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef<(() => void) | null>(null)

  useEffect(() => {
    restoreFocus.current ??= rememberFocus(groupRef.current)
    cancelRef.current?.focus()
    return () => {
      if (!document.activeElement || document.activeElement === document.body) restoreFocus.current?.()
    }
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onCancel()
    }
  }

  return (
    <div ref={groupRef} className="pi-inline-confirm" role="group" aria-labelledby={messageId} onKeyDown={onKeyDown}>
      <p id={messageId} className="pi-inline-confirm-text">{message}</p>
      <Button ref={cancelRef} variant="text" size="sm" onClick={onCancel}>{cancelLabel}</Button>
      <Button variant="danger" size="sm" onClick={onConfirm}>{confirmLabel}</Button>
    </div>
  )
}
