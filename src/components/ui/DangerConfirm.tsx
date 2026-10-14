import { useId, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { OctagonAlert } from 'lucide-react'
import { Button } from './Button'
import { keepToastStackClickable } from './ToastStack'
import { usePaperInkRoot } from './use-paper-ink-root'

interface DangerConfirmProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** 后果，例如「将删除全部章节、蓝图与设定」。 */
  consequence: string
  /** 能否恢复，例如「删除后无法恢复，项目备份不受影响」。 */
  recoverability: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  /** 删除整部作品时要求输入作品名，输入一致才可确认。 */
  typeToConfirm?: { expected: string; label: string }
}

/**
 * 不可逆、影响作品数据的操作用的危险确认对话框。
 * Portal 到最近的 .paper-ink 根而不是 body，才能取到纸墨令牌与深色主题；
 * 原地的空 span 只用来找到这个根。
 */
export function DangerConfirm({
  open,
  onOpenChange,
  title,
  consequence,
  recoverability,
  confirmLabel,
  cancelLabel,
  onConfirm,
  typeToConfirm,
}: DangerConfirmProps) {
  const [typed, setTyped] = useState('')
  const inputId = useId()
  const confirmable = !typeToConfirm || typed === typeToConfirm.expected
  const sentinelRef = useRef<HTMLSpanElement>(null)
  const root = usePaperInkRoot(sentinelRef)

  const changeOpen = (next: boolean) => {
    if (!next) setTyped('')
    onOpenChange(next)
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={changeOpen}>
      <span ref={sentinelRef} hidden />
      {root !== undefined && (
        <DialogPrimitive.Portal container={root}>
          <DialogPrimitive.Overlay className="pi-scrim" />
          <DialogPrimitive.Content className="pi-dialog pi-dialog--marked" onPointerDownOutside={keepToastStackClickable}>
            <div className="pi-dialog-head">
              <span className="pi-dialog-mark" aria-hidden><OctagonAlert /></span>
              <DialogPrimitive.Title className="pi-dialog-title">{title}</DialogPrimitive.Title>
            </div>
            <div className="pi-dialog-body">
              <DialogPrimitive.Description asChild>
                <div className="pi-dialog-consequence">
                  <p>{consequence}</p>
                  <p className="pi-dialog-recover">{recoverability}</p>
                </div>
              </DialogPrimitive.Description>
              {typeToConfirm && (
                <label className="pi-field" htmlFor={inputId}>
                  {typeToConfirm.label}
                  <input
                    id={inputId}
                    className="pi-input"
                    value={typed}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setTyped(event.target.value)}
                  />
                </label>
              )}
            </div>
            <div className="pi-dialog-foot">
              <DialogPrimitive.Close asChild>
                <Button variant="secondary">{cancelLabel}</Button>
              </DialogPrimitive.Close>
              <Button
                variant="danger-solid"
                disabled={!confirmable}
                onClick={() => {
                  onConfirm()
                  changeOpen(false)
                }}
              >
                {confirmLabel}
              </Button>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      )}
    </DialogPrimitive.Root>
  )
}
