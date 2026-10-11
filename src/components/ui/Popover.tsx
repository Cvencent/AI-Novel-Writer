import { useEffect, useId, useRef, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { Button, type InkButtonVariant } from './Button'
import { useAnchoredLayer } from './use-anchored-layer'
import '../../styles/paper-ink/index.css'

interface PopoverProps {
  /** 触发按钮文字。 */
  label: string
  /** 弹层标题，同时是弹层的可访问名称。 */
  title: string
  triggerVariant?: Exclude<InkButtonVariant, 'icon' | 'danger-solid'>
  align?: 'start' | 'end'
  children: ReactNode
}

/** 锚定在触发按钮下方的非模态弹层，打开时焦点进入弹层，Esc 关闭并回到触发按钮。 */
export function Popover({ label, title, triggerVariant = 'secondary', align = 'start', children }: PopoverProps) {
  const { open, layerId, anchorRef, triggerRef, toggle } = useAnchoredLayer()
  const titleId = useId()
  const layerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) layerRef.current?.focus()
  }, [open])

  return (
    <div className="pi-anchor" ref={anchorRef}>
      <Button
        ref={triggerRef}
        variant={triggerVariant}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? layerId : undefined}
        onClick={toggle}
      >
        {label}
      </Button>
      {open && (
        <div
          id={layerId}
          ref={layerRef}
          role="dialog"
          aria-labelledby={titleId}
          tabIndex={-1}
          className={clsx('pi-popover', align === 'end' && 'pi-popover--end')}
        >
          <h3 id={titleId} className="pi-popover-title">{title}</h3>
          {children}
        </div>
      )}
    </div>
  )
}
