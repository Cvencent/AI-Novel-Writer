/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { OctagonAlert } from 'lucide-react'
import { Button } from './Button'
import { createInkOverlayMount } from './ink-overlay'
import { keepToastStackClickable } from './ToastStack'

/** alert：只有「确定」；confirm：取消加确认；danger：后果用朱批排、确认为实心朱印，进场焦点落在取消上。 */
export type InkPromptKind = 'alert' | 'confirm' | 'danger'

export interface InkPromptOptions {
  kind: InkPromptKind
  title: string
  message: string
  confirmText: string
  cancelText?: string
}

function InkPrompt({ kind, title, message, confirmText, cancelText, onResolve }: InkPromptOptions & { onResolve: (value: boolean) => void }) {
  const [open, setOpen] = useState(true)
  const result = useRef(false)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const marked = kind !== 'confirm'

  useEffect(() => {
    if (!open) onResolve(result.current)
  }, [open, onResolve])

  const close = (value: boolean) => {
    result.current = value
    setOpen(false)
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={next => { if (!next) close(false) }}>
      <DialogPrimitive.Overlay className="pi-scrim" />
      <DialogPrimitive.Content
        className={marked ? 'pi-dialog pi-dialog--marked' : 'pi-dialog'}
        role={kind === 'alert' ? 'alertdialog' : 'dialog'}
        onOpenAutoFocus={event => {
          event.preventDefault()
          ;(kind === 'danger' ? cancelRef : confirmRef).current?.focus()
        }}
        onPointerDownOutside={keepToastStackClickable}
      >
        <div className="pi-dialog-head">
          {marked && <span className="pi-dialog-mark" aria-hidden><OctagonAlert /></span>}
          <DialogPrimitive.Title className="pi-dialog-title">{title}</DialogPrimitive.Title>
        </div>
        <div className="pi-dialog-body">
          <DialogPrimitive.Description asChild>
            {kind === 'danger'
              ? <div className="pi-dialog-consequence"><p className="pi-dialog-message">{message}</p></div>
              : <p className="pi-dialog-text pi-dialog-message">{message}</p>}
          </DialogPrimitive.Description>
        </div>
        <div className="pi-dialog-foot">
          {kind !== 'alert' && (
            <Button ref={cancelRef} variant="secondary" onClick={() => close(false)}>{cancelText}</Button>
          )}
          <Button ref={confirmRef} variant={kind === 'danger' ? 'danger-solid' : 'primary'} onClick={() => close(true)}>
            {confirmText}
          </Button>
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Root>
  )
}

/** 在纸墨宿主里渲染一次性的对话框；关闭后卸载挂载点，再以用户的选择 resolve。 */
export function openInkPrompt(options: InkPromptOptions): Promise<boolean> {
  return new Promise(resolve => {
    const mount = createInkOverlayMount()
    const root = createRoot(mount)
    const finish = (value: boolean) => {
      setTimeout(() => {
        root.unmount()
        mount.remove()
        resolve(value)
      })
    }
    root.render(<InkPrompt {...options} onResolve={finish} />)
  })
}
