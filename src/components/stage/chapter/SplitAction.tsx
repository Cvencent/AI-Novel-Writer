import { useEffect, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '../../ui/Button'
import { useAnchoredLayer } from '../../ui/use-anchored-layer'

/**
 * 章节动作条的拆分主按钮：主按钮直接执行，箭头打开一个小弹层改本次选项（审稿的检查维度、修稿的模型）。
 * 样式与写作此章的拆分按钮相同。
 */
export default function SplitAction({ label, icon, onRun, disabled, optionsLabel, children }: {
  label: string
  icon: ReactNode
  onRun: () => void
  disabled?: boolean
  /** 箭头与弹层的可访问名称，例如「检查维度」。 */
  optionsLabel: string
  children: ReactNode
}) {
  const { open, layerId, anchorRef, triggerRef, layerRef, renderLayer, toggle } = useAnchoredLayer('start')

  useEffect(() => {
    if (open) layerRef.current?.focus()
  }, [open, layerRef])

  return (
    <div className="pi-anchor stage-write" ref={anchorRef}>
      <Button variant="primary" className="stage-write-main" disabled={disabled} onClick={onRun}>
        {icon}{label}
      </Button>
      <Button
        ref={triggerRef}
        variant="primary"
        className="stage-write-toggle"
        aria-label={optionsLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? layerId : undefined}
        onClick={toggle}
      >
        <ChevronDown size={14} aria-hidden />
      </Button>
      {open && renderLayer(
        <div id={layerId} ref={layerRef} role="dialog" aria-label={optionsLabel} tabIndex={-1} className="pi-popover stage-ch-options">
          {children}
        </div>,
      )}
    </div>
  )
}
