import { useRef, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useLocaleStore } from '../../stores/locale-store'
import { Button } from '../ui/Button'
import { usePaperInkRoot } from '../ui/use-paper-ink-root'

interface PlainConfirmProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  children: ReactNode
  confirmLabel: ReactNode
  disabled?: boolean
  onConfirm: () => void
}

/**
 * 不丢数据、但要作者先知情的确认（新建回滚草稿、把资料发给模型、保存线索）。外形与危险确认相同，标题与主按钮用墨色与强调色；
 * 确认后由调用方决定何时关闭；忙碌或内容不完整时由调用方禁用主按钮。
 */
export default function PlainConfirm({ open, onOpenChange, title, children, confirmLabel, disabled = false, onConfirm }: PlainConfirmProps) {
  const text = useLocaleStore(s => s.text)
  const sentinel = useRef<HTMLSpanElement>(null)
  const root = usePaperInkRoot(sentinel)

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <span ref={sentinel} hidden />
      {root !== undefined && (
        <DialogPrimitive.Portal container={root}>
          <DialogPrimitive.Overlay className="pi-scrim" />
          <DialogPrimitive.Content className="pi-dialog stage-plain-confirm">
            <div className="pi-dialog-head">
              <DialogPrimitive.Title className="pi-dialog-title">{title}</DialogPrimitive.Title>
            </div>
            <div className="pi-dialog-body">
              <DialogPrimitive.Description asChild>
                <div className="pi-dialog-text">{children}</div>
              </DialogPrimitive.Description>
            </div>
            <div className="pi-dialog-foot">
              <DialogPrimitive.Close asChild>
                <Button variant="text">{text('取消', 'Cancel')}</Button>
              </DialogPrimitive.Close>
              <Button variant="primary" disabled={disabled} onClick={onConfirm}>{confirmLabel}</Button>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      )}
    </DialogPrimitive.Root>
  )
}
