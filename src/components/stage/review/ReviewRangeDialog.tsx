import { useState } from 'react'
import { useId } from 'react'
import { Sparkles } from 'lucide-react'
import { useLocaleStore } from '../../../stores/locale-store'
import { Button } from '../../ui/Button'
import { InkDialog } from '../../stage/InkDialog'
import { pluralEn } from '../../../shared/plural-en'
import { STAGE_REVIEW_MAX_TARGETS } from '../../../shared/stage-review-types'

/**
 * 选择 AI 检查的章节范围。
 *
 * 默认给一个合理的窗口（最近生成的若干章），也允许手填。上限由调用方决定：
 * 检查是只读的，但要限制一次喂给模型的章数，避免输入超预算。
 */
export default function ReviewRangeDialog({
  open,
  title,
  description,
  defaultFrom,
  defaultTo,
  maxTo,
  onClose,
  onConfirm,
}: {
  open: boolean
  title: string
  description: string
  defaultFrom: number
  defaultTo: number
  /** 允许的最大章号（通常是全书章数或已生成到的章号）。 */
  maxTo: number
  onClose: () => void
  onConfirm: (range: { from: number; to: number }) => void
}) {
  const text = useLocaleStore(s => s.text)
  const ids = { from: useId(), to: useId() }
  const [from, setFrom] = useState(String(defaultFrom))
  const [to, setTo] = useState(String(defaultTo))


  const fromValue = Number(from) || 0
  const toValue = Number(to) || 0
  const invalid = !Number.isSafeInteger(fromValue) || !Number.isSafeInteger(toValue) || fromValue < 1 || toValue < fromValue || toValue > maxTo
    || toValue - fromValue + 1 > STAGE_REVIEW_MAX_TARGETS
  const count = invalid ? 0 : toValue - fromValue + 1

  return (
    <InkDialog
      open={open}
      onOpenChange={next => { if (!next) onClose() }}
      title={title}
      description={description}
      footer={(
        <>
          <Button variant='secondary' onClick={onClose}>{text('取消', 'Cancel')}</Button>
          <Button variant='primary' disabled={invalid} onClick={() => onConfirm({ from: fromValue, to: toValue })}>
            <Sparkles size={15} aria-hidden />{text('确定范围', 'Use range')}
          </Button>
        </>
      )}
    >
      <div className='stage-review-range'>
        <label htmlFor={ids.from}>{text('起始章', 'From')}</label>
        <input id={ids.from} type='number' min={1} max={maxTo} value={from} onChange={event => setFrom(event.target.value)} />
        <label htmlFor={ids.to}>{text('结束章', 'To')}</label>
        <input id={ids.to} type='number' min={1} max={maxTo} value={to} onChange={event => setTo(event.target.value)} />
        <p className='stage-review-range-hint'>
          {invalid
            ? text('请输入有效范围：起始章不小于 1，结束章不小于起始章，不超过 ' + maxTo + ' 章，且单次最多 ' + STAGE_REVIEW_MAX_TARGETS + ' 章。',
                   'Enter a valid range: from 1, to >= from, at most ' + maxTo + ', and no more than ' + STAGE_REVIEW_MAX_TARGETS + ' chapters per run.')
            : text(`将检查 ${count} 章，全书共 ${maxTo} 章。`, `${count} of ${maxTo} ${pluralEn(maxTo, 'chapter')} will be reviewed.`)}
        </p>
      </div>
    </InkDialog>
  )
}
