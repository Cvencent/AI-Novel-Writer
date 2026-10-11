import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react'

/** Menu 与 Popover 共用：锚点内开合、点击外部关闭、Esc 关闭并把焦点还给触发按钮。 */
export function useAnchoredLayer(): {
  open: boolean
  layerId: string
  anchorRef: RefObject<HTMLDivElement | null>
  triggerRef: RefObject<HTMLButtonElement | null>
  show: () => void
  toggle: () => void
  close: (returnFocus: boolean) => void
} {
  const [open, setOpen] = useState(false)
  const layerId = useId()
  const anchorRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) close(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close(true)
      }
    }
    const anchor = anchorRef.current
    document.addEventListener('pointerdown', onPointerDown)
    anchor?.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      anchor?.removeEventListener('keydown', onKeyDown)
    }
  }, [open, close])

  return {
    open,
    layerId,
    anchorRef,
    triggerRef,
    show: useCallback(() => setOpen(true), []),
    toggle: useCallback(() => setOpen((value) => !value), []),
    close,
  }
}
