import { useCallback, useEffect, useState } from 'react'
import { Check, Layers, SkipForward, Sparkles } from 'lucide-react'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { ipc } from '../../../services/ipc-client'
import { Button } from '../../ui/Button'
import type { ArcOutlineRecord } from '../../../../electron/repositories/arc-outline-repository'

/** 生成模式：逐段等作者确认，或连续铺完。 */
export type ArcGenerationMode = 'waitConfirm' | 'skipConfirm'

/**
 * 粗纲面板：列出已生成的粗纲段，控制生成模式，并在存在过期细纲时提示。
 * 粗纲不含人名，只管方向；细纲才落到每章。
 */
export default function ArcOutlinePanel({ projectKey }: { projectKey: string }) {
  const text = useLocaleStore(s => s.text)
  const [arcs, setArcs] = useState<ArcOutlineRecord[]>([])
  const [staleChapters, setStaleChapters] = useState<number[]>([])
  const [mode, setMode] = useState<ArcGenerationMode>('waitConfirm')
  const [loading, setLoading] = useState(true)

  const session = useProjectStore(s => s.currentProject?.sessionLease)
  const load = useCallback(async () => {
    if (!session) return
    const [list, stale] = await Promise.all([
      ipc.invoke('db:arc-outline-list', projectKey).catch(() => []),
      ipc.invoke('db:arc-outline-stale-list', projectKey).catch(() => []),
    ])
    setArcs(Array.isArray(list) ? list : [])
    setStaleChapters(Array.isArray(stale) ? stale : [])
    setLoading(false)
  }, [projectKey, session])

  useEffect(() => { void load() }, [load])

  if (loading) return null

  const covered = arcs.reduce((max, arc) => Math.max(max, arc.toChapter), 0)

  return (
    <section className="arch-arc" aria-label={text('粗纲', 'Arc outline')}>
      <header className="arch-arc-head">
        <span className="arch-arc-title">
          <Layers size={15} aria-hidden />
          {text('粗纲', 'Arc outline')}
          {arcs.length > 0 && (
            <span className="arch-arc-count">
              {text(arcs.length + ' 段 · 到第 ' + covered + ' 章', arcs.length + ' segments · through ch. ' + covered)}
            </span>
          )}
        </span>
        <span className="arch-arc-actions">
          <Button
            variant={mode === 'waitConfirm' ? 'primary' : 'secondary'}
            size="sm"
            aria-pressed={mode === 'waitConfirm'}
            onClick={() => setMode('waitConfirm')}
          >
            <Check size={14} aria-hidden />{text('等我确认', 'Wait for me')}
          </Button>
          <Button
            variant={mode === 'skipConfirm' ? 'primary' : 'secondary'}
            size="sm"
            aria-pressed={mode === 'skipConfirm'}
            onClick={() => setMode('skipConfirm')}
          >
            <SkipForward size={14} aria-hidden />{text('跳过确认', 'Skip confirmation')}
          </Button>
        </span>
      </header>

      {arcs.length === 0
        ? <p className="arch-arc-empty">{text('还没有粗纲。粗纲负责定方向，不含人名；确认后再生成逐章细纲。', 'No arc outline yet. The arc outline sets direction without character names; chapter outlines come after you confirm it.')}</p>
        : (
          <ol className="arch-arc-list">
            {arcs.map(arc => (
              <li key={arc.id} className="arch-arc-item" data-status={arc.status}>
                <span className="arch-arc-range">{text('第 ' + arc.fromChapter + '–' + arc.toChapter + ' 章', 'Ch. ' + arc.fromChapter + '-' + arc.toChapter)}</span>
                <span className="arch-arc-name">{arc.title}</span>
                <span className="arch-arc-beat">{arc.beat}</span>
                <span className="arch-arc-status">
                  {arc.status === 'confirmed'
                    ? text('已确认', 'Confirmed')
                    : arc.status === 'needs_regen'
                      ? text('待重生成', 'Needs regeneration')
                      : text('草稿', 'Draft')}
                </span>
              </li>
            ))}
          </ol>
        )}

      {staleChapters.length > 0 && (
        <p className="arch-arc-stale" role="status">
          <Sparkles size={13} aria-hidden />
          {text(
            '粗纲改动后，第 ' + staleChapters.join('、') + ' 章的细纲需要重新生成。',
            'After the arc change, chapter outlines for ch. ' + staleChapters.join(', ') + ' need regeneration.',
          )}
        </p>
      )}
    </section>
  )
}
