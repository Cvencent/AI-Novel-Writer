import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { useLocaleStore } from '../../../stores/locale-store'
import { pluralEn } from '../../../shared/plural-en'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'
import { InkDialog } from '../InkDialog'
import type { ArcOutlineRecord } from '../../../../electron/repositories/arc-outline-repository'

export type ArcReviseScope =
  | { kind: 'arc'; arcIndex: number }
  | { kind: 'from-chapter'; chapterNumber: number }

/**
 * 对话式重生成。作者用自然语言说明方向，系统先算出受影响范围并展示，
 * 确认后才重生成；覆盖前由调用方保存可恢复版本。
 */
export default function ArcReviseDialog({ scope, arcs, staleChapters, totalChapters, onConfirm, onClose }: {
  scope: ArcReviseScope
  arcs: readonly ArcOutlineRecord[]
  staleChapters: readonly number[]
  totalChapters: number
  onConfirm: (direction: string, affectedChapters: number[]) => void
  onClose: () => void
}) {
  const text = useLocaleStore(s => s.text)
  const [direction, setDirection] = useState('')

  const affectedChapters = (() => {
    if (scope.kind === 'arc') {
      const arc = arcs.find(item => item.arcIndex === scope.arcIndex)
      if (!arc) return []
      // 该段已有过期章节时只重生成过期的；否则整段重生成。
      if (staleChapters.length > 0) {
        return staleChapters.filter(chapter => chapter >= arc.fromChapter && chapter <= arc.toChapter)
      }
      return Array.from({ length: arc.toChapter - arc.fromChapter + 1 }, (_v, i) => arc.fromChapter + i)
    }
    // 从某章之后重来：覆盖该章到全书末尾。
    const from = Math.max(1, scope.chapterNumber)
    if (totalChapters < from) return []
    return Array.from({ length: totalChapters - from + 1 }, (_v, i) => from + i)
  })()

  const previewCount = 30

  return (
    <InkDialog
      open
      onOpenChange={open => { if (!open) onClose() }}
      title={scope.kind === 'arc'
        ? text(`重新生成粗纲第 ${scope.arcIndex} 段`, `Regenerate arc segment ${scope.arcIndex}`)
        : text(`从第 ${scope.chapterNumber} 章之后重来`, `Regenerate from chapter ${scope.chapterNumber}`)}
      description={text('说明你希望这一段往哪个方向走，确认后按影响范围重新生成。', 'Describe the direction you want. After you confirm, the affected range is regenerated.')}
      footer={<>
          <Button variant="text" onClick={onClose}>{text('取消', 'Cancel')}</Button>
          <Button
            variant="primary"
            disabled={!direction.trim() || affectedChapters.length === 0}
            onClick={() => onConfirm(direction.trim(), affectedChapters)}
          >
            <Sparkles size={14} aria-hidden />{text('按此方向重新生成', 'Regenerate in this direction')}
          </Button>
      </>}
    >
      <label className="pi-field">
        {text('方向说明', 'Direction')}
        <textarea
          className="pi-input"
          rows={4}
          value={direction}
          onChange={event => setDirection(event.target.value)}
          placeholder={text('例如：拉回学院线，不要再走市井谍战。', 'For example: pull back to the academy line, away from the street-intrigue thread.')}
        />
      </label>

      <Notice tone="warn" title={text(`将重新生成 ${affectedChapters.length} 章`, `${affectedChapters.length} ${pluralEn(affectedChapters.length, 'chapter')} will be regenerated`)}>
        <span>
          {affectedChapters.length > 0
            ? text(
                `受影响章号：${affectedChapters.slice(0, previewCount).join('、')}${affectedChapters.length > previewCount ? ' 等' : ''}`,
                `Affected chapters: ${affectedChapters.slice(0, previewCount).join(', ')}${affectedChapters.length > previewCount ? ' and more' : ''}`,
              )
            : text('没有需要重新生成的章节。', 'No chapters need regeneration.')}
        </span>
        <span>{text('覆盖前会先保存一份可恢复版本。', 'A recoverable copy is saved before overwriting.')}</span>
      </Notice>
    </InkDialog>
  )
}
