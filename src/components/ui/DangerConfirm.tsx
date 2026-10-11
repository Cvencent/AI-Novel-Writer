import { useId, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Button } from './Button'
import '../../styles/paper-ink/index.css'

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
 * 不经 Portal 渲染，留在 .paper-ink 作用域内才能取到纸墨令牌与深色主题。
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

  const changeOpen = (next: boolean) => {
    if (!next) setTyped('')
    onOpenChange(next)
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={changeOpen}>
      <DialogPrimitive.Overlay className="pi-scrim" />
      <DialogPrimitive.Content className="pi-dialog">
        <div className="pi-dialog-head">
          <DialogPrimitive.Title className="pi-dialog-title">{title}</DialogPrimitive.Title>
        </div>
        <div className="pi-dialog-body">
          <DialogPrimitive.Description asChild>
            <div className="pi-dialog-text">
              <p>{consequence}</p>
              <p>{recoverability}</p>
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
    </DialogPrimitive.Root>
  )
}
