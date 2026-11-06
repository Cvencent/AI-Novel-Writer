import { useEffect, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { clsx } from 'clsx'
import { Button } from '../../ui/Button'
import type { useAnchoredLayer } from '../../ui/use-anchored-layer'

/**
 * 拆分主按钮：主按钮直接执行，箭头打开一个小弹层改本次选项（写作此章的模型与指导、审稿的检查维度、修稿的模型）。
 * 弹层的开关由调用方的 useAnchoredLayer 持有，调用方可以自己打开（写作请求）或在开始后关掉它。
 */
export default function SplitAction({ layer, label, icon, onRun, disabled, busy, busyLabel, optionsLabel, popoverClassName, children }: {
  layer: ReturnType<typeof useAnchoredLayer>
  label: string
  icon: ReactNode
  onRun: () => void
  disabled?: boolean
  /** 主操作进行中：主体保持上墨并画加载墨线（aria-busy），箭头半边不带，刻痕占着它的 ::before。 */
  busy?: boolean
  /**
   * 进行中时替换在按钮上的文案（issue #210）。
   *
   * 「点下去」到「弹层出现」之间原来只有一圈加载墨线、没有任何字：作者看不出是在算预检、
   * 还是在等模型、还是按钮坏了。给一句带秒数的文案，**这一段空白就变成可读的状态**。
   */
  busyLabel?: string
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
    <div className={clsx('pi-anchor pi-split', disabled && !busy && 'pi-split--main-off')} ref={anchorRef}>
      <Button variant="primary" className="pi-split-main" disabled={disabled || busy} aria-busy={busy || undefined} onClick={onRun}>
        {icon}{busy && busyLabel ? busyLabel : label}
      </Button>
      <Button
        ref={triggerRef}
        variant="primary"
        className="pi-split-toggle"
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
