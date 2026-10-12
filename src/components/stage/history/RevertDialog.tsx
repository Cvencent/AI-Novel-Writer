import { useRef } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { RotateCcw } from 'lucide-react'
import { useLocaleStore } from '../../../stores/locale-store'
import { Button } from '../../ui/Button'
import { usePaperInkRoot } from '../../ui/use-paper-ink-root'

interface RevertDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  chapterNumber: number
  /** 要回退到的那一稿，例如「草稿 v1」。 */
  source: string
  /** 回退后新建的那一稿的版本号。 */
  nextVersion: number
  /** 回退前的当前稿，例如「草稿 v2」；这一章还没有别的稿时为 null。 */
  current: string | null
  busy: boolean
  onConfirm: () => void
}

/** 回退不删除也不覆盖任何一稿，所以用普通确认而不是危险确认，主按钮写明会新建哪一稿。 */
export default function RevertDialog({ open, onOpenChange, chapterNumber, source, nextVersion, current, busy, onConfirm }: RevertDialogProps) {
  const text = useLocaleStore(s => s.text)
  const sentinel = useRef<HTMLSpanElement>(null)
  const root = usePaperInkRoot(sentinel)

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <span ref={sentinel} hidden />
      {root !== undefined && (
        <DialogPrimitive.Portal container={root}>
          <DialogPrimitive.Overlay className="pi-scrim" />
          <DialogPrimitive.Content className="pi-dialog stage-revert">
            <div className="pi-dialog-head">
              <DialogPrimitive.Title className="pi-dialog-title">{text(`回退到${source}？`, `Revert to ${source}?`)}</DialogPrimitive.Title>
            </div>
            <div className="pi-dialog-body">
              <DialogPrimitive.Description asChild>
                <div className="pi-dialog-text">
                  <p>{text(
                    `会用${source}的内容新建一份草稿 v${nextVersion}，作为第 ${chapterNumber} 章的当前稿。`,
                    `This creates draft v${nextVersion} from ${source} and makes it the current draft of chapter ${chapterNumber}.`,
                  )}</p>
                  <p>{current
                    ? text(`现在的${current}和所有历史版本都会保留，随时可以再切回去。`, `${current} and every earlier version stay, so you can switch back at any time.`)
                    : text('所有历史版本都会保留。', 'Every earlier version stays.')}</p>
                </div>
              </DialogPrimitive.Description>
            </div>
            <div className="pi-dialog-foot">
              <DialogPrimitive.Close asChild>
                <Button variant="text">{text('取消', 'Cancel')}</Button>
              </DialogPrimitive.Close>
              <Button variant="primary" disabled={busy} onClick={onConfirm}>
                <RotateCcw size={14} aria-hidden="true" />
                {text('新建回滚草稿', 'Create rollback draft')}
              </Button>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      )}
    </DialogPrimitive.Root>
  )
}
