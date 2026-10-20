import { useEffect, useState } from 'react'
import { Pause, Play, Square } from 'lucide-react'
import { useLocaleStore } from '../../../stores/locale-store'
import {
  cancelContinuousOutline,
  getContinuousOutlineProgress,
  pauseContinuousOutline,
  resumeContinuousOutline,
  subscribeContinuousOutline,
  type ContinuousOutlineProgress,
} from '../../../services/workflows/continuous-outline-runner'
import { Button } from '../../ui/Button'
import { pluralEn } from '../../../shared/plural-en'

/**
 * 连续大纲生成进度面板。
 *
 * 展示「已生成 / 全书」章数、百分比、当前批次与批次内进度，并提供暂停/继续/停止。
 * 仅在连续生成被启动或已有进度时显示。
 */
export default function ContinuousOutlinePanel({ targetUnits }: { targetUnits?: number }) {
  const text = useLocaleStore(s => s.text)
  const [progress, setProgress] = useState<ContinuousOutlineProgress>(() => getContinuousOutlineProgress())

  useEffect(() => subscribeContinuousOutline(setProgress), [])

  const active = progress.status === 'running' || progress.status === 'paused'
  if (!active && progress.status !== 'failed' && progress.status !== 'completed') return null

  const percent = Math.max(0, Math.min(100, progress.percent))
  const batchPercent = Math.max(0, Math.min(100, Math.round(progress.batchPercent)))

  return (
    <section className="arch-continuous" aria-label={text('连续生成进度', 'Continuous generation progress')}>
      <header className="arch-continuous-head">
        <span className="arch-continuous-title">
          {text('连续生成情节大纲', 'Continuous plot-outline generation')}
          <span className="arch-continuous-count">{progress.coveredChapters} / {progress.totalChapters} {text('章', 'ch.')}</span>
        </span>
        <span className="arch-continuous-actions">
          {progress.status === 'running' && (
            <>
              <Button variant="secondary" size="sm" onClick={() => pauseContinuousOutline()}>
                <Pause size={14} aria-hidden />{text('暂停', 'Pause')}
              </Button>
              <Button variant="text" size="sm" onClick={() => cancelContinuousOutline()}>
                <Square size={14} aria-hidden />{text('停止', 'Stop')}
              </Button>
            </>
          )}
          {progress.status === 'paused' && (
            <>
              <Button variant="primary" size="sm" onClick={() => resumeContinuousOutline(targetUnits)}>
                <Play size={14} aria-hidden />{text('继续', 'Resume')}
              </Button>
              <Button variant="text" size="sm" onClick={() => cancelContinuousOutline()}>
                <Square size={14} aria-hidden />{text('停止', 'Stop')}
              </Button>
            </>
          )}
          {progress.status === 'failed' && (
            <Button variant="primary" size="sm" onClick={() => resumeContinuousOutline(targetUnits)}>
              <Play size={14} aria-hidden />{text('重试', 'Retry')}
            </Button>
          )}
        </span>
      </header>
      <div className="arch-continuous-bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <span className="arch-continuous-fill" style={{ width: percent + '%' }} />
      </div>
      <p className="arch-continuous-meta">
        {text(`${percent}% · 剩余 ${progress.remainingChapters} 章 · 已完成 ${progress.batchesCompleted} 批`, `${percent}% · ${progress.remainingChapters} ${pluralEn(progress.remainingChapters, 'chapter')} left · ${progress.batchesCompleted} ${pluralEn(progress.batchesCompleted, 'batch', 'batches')} done`)}
        {progress.currentBatch && (
          <span className="arch-continuous-batch">
            {text(`当前批次 第 ${progress.currentBatch.from}–${progress.currentBatch.to} 章（${batchPercent}%）`, `Current batch ch. ${progress.currentBatch.from}-${progress.currentBatch.to} (${batchPercent}%)`)}
          </span>
        )}
      </p>
      {progress.message && <p className="arch-continuous-message">{progress.message}</p>}
    </section>
  )
}
