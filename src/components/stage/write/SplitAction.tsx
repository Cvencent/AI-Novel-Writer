import { useEffect, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '../../ui/Button'
import type { useAnchoredLayer } from '../../ui/use-anchored-layer'

/**
 * 拆分主按钮：主按钮直接执行，箭头打开一个小弹层改本次选项（写作此章的模型与指导、审稿的检查维度、修稿的模型）。
 * 弹层的开关由调用方的 useAnchoredLayer 持有，调用方可以自己打开（写作请求）或在开始后关掉它。
 */
export default function SplitAction({ layer, label, icon, onRun, disabled, optionsLabel, popoverClassName, children }: {
  layer: ReturnType<typeof useAnchoredLayer>
  label: string
  icon: ReactNode
  onRun: () => void
  disabled?: boolean
  /** 箭头与弹层的可访问名称，例如「检查维度」。 */
  optionsLabel: string
  popoverClassName: string
  children: ReactNode
}) {
  const { open, layerId, anchorRef, triggerRef, layerRef, renderLayer, toggle } = layer

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
        <div id={layerId} ref={layerRef} role="dialog" aria-label={optionsLabel} tabIndex={-1} className={`pi-popover ${popoverClassName}`}>
          {children}
        </div>,
      )}
    </div>
  )
}
