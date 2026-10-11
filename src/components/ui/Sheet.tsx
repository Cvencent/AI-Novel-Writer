import { useId, type KeyboardEvent, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { clsx } from 'clsx'
import { Button } from './Button'
import '../../styles/paper-ink/index.css'

export interface SheetTab {
  id: string
  label: string
}

interface SheetProps {
  open: boolean
  title: string
  subtitle?: string
  closeLabel: string
  onClose: () => void
  /** 侧页分页；给出时 children 是当前分页的内容。 */
  tabs?: { items: readonly SheetTab[]; active: string; onChange: (id: string) => void }
  footer?: ReactNode
  wide?: boolean
  children: ReactNode
}

/** 内容区右侧的按需侧页。由所在布局决定位置，侧页本身不遮挡正文。 */
export function Sheet({ open, title, subtitle, closeLabel, onClose, tabs, footer, wide, children }: SheetProps) {
  const titleId = useId()
  const panelId = useId()
  if (!open) return null

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
    }
  }

  return (
    <aside className={clsx('pi-sheet', wide && 'pi-sheet--wide')} aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <header className="pi-sheet-head">
        <div>
          <h2 id={titleId} className="pi-sheet-title">{title}</h2>
          {subtitle && <p className="pi-sheet-sub">{subtitle}</p>}
        </div>
        <Button variant="icon" size="sm" aria-label={closeLabel} onClick={onClose}>
          <X size={16} aria-hidden />
        </Button>
      </header>
      {tabs && (
        <div className="pi-sheet-tabs" role="tablist">
          {tabs.items.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              className="pi-sheet-tab pi-focusable"
              aria-selected={tab.id === tabs.active}
              aria-controls={panelId}
              onClick={() => tabs.onChange(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}
      <div className="pi-sheet-body" id={panelId} role={tabs ? 'tabpanel' : undefined}>
        {children}
      </div>
      {footer && <footer className="pi-sheet-foot">{footer}</footer>}
    </aside>
  )
}
