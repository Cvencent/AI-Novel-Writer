import { useCallback, useEffect, useState, type MutableRefObject } from 'react'
import { Check, Layers, ListTree, PencilLine, SkipForward, Sparkles } from 'lucide-react'
import ArcReviseDialog, { type ArcReviseScope } from './ArcReviseDialog'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { ipc } from '../../../services/ipc-client'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'
import { launchCreativeWorkflow } from '../../../services/workflows/creative-workflow-launcher'
import { plotOutlineNextChapter, type PlotOutlineRangeSource } from '../../../shared/plot-outline-contract'
import type { OutlineProgress } from '../../../shared/plot-outline-checkpoint'
import { Button } from '../../ui/Button'
import type { ArcOutlineRecord } from '../../../../electron/repositories/arc-outline-repository'

/** 生成模式：逐段等作者确认，或连续铺完。 */
export type ArcGenerationMode = 'waitConfirm' | 'skipConfirm'

/**
 * 粗纲面板：列出已生成的粗纲段，控制生成模式，并在存在过期细纲时提示。
 * 粗纲不含人名，只管方向；细纲才落到每章。
 */
export default function ArcOutlinePanel({ projectKey, fineSource, fineProgress, embedded = false, runnerRef }: {
  projectKey: string
  /** 正式细纲来源事实；由架构页复用，避免这里重复读取 project_core。 */
  fineSource?: PlotOutlineRangeSource
  fineProgress?: OutlineProgress
  /** 嵌在「粗纲」一节里时不再自带头部，避免与节标题重复。 */
  embedded?: boolean
  /**
   * 节头按钮的入口。粗纲的生成逻辑（模式、按段推进、等待运行结束）都在这里，
   * 交给父级调用，避免在节头重复一份。
   */
  runnerRef?: MutableRefObject<((mode: 'next' | 'reverse') => void) | null>
}) {
  const text = useLocaleStore(s => s.text)
  const [arcs, setArcs] = useState<ArcOutlineRecord[]>([])
  const [staleChapters, setStaleChapters] = useState<number[]>([])
  const [mode, setMode] = useState<ArcGenerationMode>('waitConfirm')
  const [loading, setLoading] = useState(true)
  const [fineCovered, setFineCovered] = useState(0)
  const [reviseScope, setReviseScope] = useState<ArcReviseScope | null>(null)
  const [pendingRevise, setPendingRevise] = useState<{ direction: string; chapters: number[] } | null>(null)
  const [busyArc, setBusyArc] = useState(false)
  const [busyFineArc, setBusyFineArc] = useState<number | null>(null)
  const [error, setError] = useState('')
  const totalChapters = useProjectStore(s => s.currentProject?.novelConfig?.totalChapters ?? 0)

  const session = useProjectStore(s => s.currentProject?.sessionLease)
  const load = useCallback(async () => {
    if (!session) return
    const [list, stale] = await Promise.all([
      ipc.invoke('db:arc-outline-list', projectKey).catch(() => []),
      ipc.invoke('db:arc-outline-stale-list', projectKey).catch(() => []),
    ])
    setArcs(Array.isArray(list) ? list : [])
    setStaleChapters(Array.isArray(stale) ? stale : [])
    const synopsis = fineSource?.synopsis ?? ''
    const total = fineSource?.totalChapters ?? 0
    if (synopsis && total > 0) {
      const next = plotOutlineNextChapter({ synopsis, totalChapters: total, writingLanguage: fineSource?.writingLanguage ?? 'zh-CN' })
      setFineCovered(next > 1 ? next - 1 : 0)
    } else {
      setFineCovered(fineProgress?.kind === 'partial' ? fineProgress.coveredTo : 0)
    }
    setLoading(false)
  }, [projectKey, session, fineSource, fineProgress])

  // 首次挂载与切换作品时读取粗纲；load 内部只做远端读取后的 setState。
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])


  const covered = arcs.reduce((max, arc) => Math.max(max, arc.toChapter), 0)


  /** 重生成后的刷新：重新读取粗纲与过期章节。 */
  /** 读取一次粗纲，返回最新列表；生成循环用它判断是否已铺满全书。 */
  const readArcs = async (): Promise<ArcOutlineRecord[]> => {
    const list = await ipc.invoke('db:arc-outline-list', projectKey).catch(() => [])
    const fresh = Array.isArray(list) ? list as ArcOutlineRecord[] : []
    setArcs(fresh)
    return fresh
  }

  /** 等这一轮粗纲工作流结束；工作流在后台跑，失败时把错误带回。 */
  const waitForArcRun = async (runId: string): Promise<void> => {
    for (let attempt = 0; attempt < 1800; attempt += 1) {
      const state = useWorkflowStore.getState()
      const run = state.activeRuns.find(item => item.id === runId) ?? state.history.find(item => item.id === runId)
      if (run?.status === 'completed') return
      if (run?.status === 'failed') throw new Error(run.error || text('粗纲生成失败', 'Arc-outline generation failed'))
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    throw new Error(text('粗纲生成等待超时，请到任务中心查看。', 'Timed out waiting for arc generation. Check the task center.'))
  }

  /**
   * 粗纲生成：mode=next 续生成下一段，mode=reverse 从现有细纲反推。
   * “跳过确认”会一段接一段生成到全书铺满；“等我确认”每段停下。
   */
  const startArc = async (arcMode: 'next' | 'reverse') => {
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession || !isProjectSessionCurrent(projectSession)) {
      setError(text('项目会话已切换，请重新打开作品。', 'The project session changed. Reopen the book and try again.'))
      return
    }
    setBusyArc(true)
    setError('')
    try {
      if (arcMode === 'reverse') {
        const receipt = await launchCreativeWorkflow({ workflow: 'generate_arc_outline', mode: 'reverse' }, projectSession)
        await waitForArcRun(receipt.runId)
        await load()
        return
      }
      let latest = await readArcs()
      let coveredNow = latest.reduce((max, arc) => Math.max(max, arc.toChapter), 0)
      while (coveredNow < totalChapters) {
        if (mode === 'waitConfirm' && latest.some(arc => arc.status !== 'confirmed')) {
          setError(text('请先确认当前粗纲段，再生成下一段。', 'Confirm the current arc segment before generating the next one.'))
          break
        }
        const receipt = await launchCreativeWorkflow({ workflow: 'generate_arc_outline', mode: 'next' }, projectSession)
        await waitForArcRun(receipt.runId)
        latest = await readArcs()
        const nextCovered = latest.reduce((max, arc) => Math.max(max, arc.toChapter), 0)
        if (nextCovered <= coveredNow) break
        coveredNow = nextCovered
        if (mode === 'skipConfirm') {
          for (const arc of latest.filter(item => item.status === 'draft')) {
            await ipc.invoke('db:arc-outline-confirm', arc.arcIndex, arc.revision, projectKey).catch(() => null)
          }
          latest = await readArcs()
        }
        if (mode === 'waitConfirm') break
      }
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyArc(false)
    }
  }

  // 节头按钮复用同一份生成逻辑：模式判断、按段推进、等待运行结束都在这里。
  // 每次渲染后重新登记，保证闭包里的 mode 与 arcs 是最新值。
  useEffect(() => {
    if (runnerRef) runnerRef.current = (arcMode) => { void startArc(arcMode) }
  })

  /** 人工确认一段粗纲，之后才允许按“等我确认”继续下一段或生成细纲。 */
  const confirmArc = async (arc: ArcOutlineRecord) => {
    setError('')
    const result = await ipc.invoke('db:arc-outline-confirm', arc.arcIndex, arc.revision, projectKey).catch(() => null) as { success?: boolean; error?: string } | null
    if (!result?.success) setError(result?.error || text('确认粗纲失败', 'Could not confirm the arc segment'))
    await load()
  }

  /** 按一个已确认粗纲段生成逐章细纲。 */
  const startFineOutline = async (arc: ArcOutlineRecord) => {
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession || !isProjectSessionCurrent(projectSession)) {
      setError(text('项目会话已切换，请重新打开作品。', 'The project session changed. Reopen the book and try again.'))
      return
    }
    setBusyFineArc(arc.arcIndex)
    setError('')
    try {
      for (let from = arc.fromChapter; from <= arc.toChapter; from += 10) {
        const to = Math.min(arc.toChapter, from + 9)
        const receipt = await launchCreativeWorkflow({
          workflow: 'generate_architecture',
          selectedSteps: ['synopsis'],
          synopsisRange: { from, to },
          arcContext: { arcId: arc.id, rev: arc.revision, from: arc.fromChapter, to: arc.toChapter, summary: arc.summary, beat: arc.beat },
        }, projectSession)
        await waitForArcRun(receipt.runId)
      }
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyFineArc(null)
    }
  }

  if (loading) return null

  const body = (
    <section className={embedded ? 'arch-arc arch-arc-embedded' : 'arch-arc'} aria-label={text('粗纲', 'Arc outline')}>
      {!embedded && <header className="arch-arc-head">
        <span className="arch-arc-title">
          <Layers size={15} aria-hidden />
          {text('粗纲', 'Arc outline')}
          {arcs.length > 0 && (
            <span className="arch-arc-count">
              {text(arcs.length + ' 段 · 粗纲到第 ' + covered + ' 章', arcs.length + ' segments · arc through ch. ' + covered)}
              {fineCovered > 0 && <span className="arch-arc-fine"> · {text('细纲到第 ' + fineCovered + ' 章', 'chapter outline through ch. ' + fineCovered)}</span>}
            </span>
          )}
        </span>
        <span className="arch-arc-actions">
          <Button variant="secondary" size="sm" hidden={embedded} disabled={busyArc || covered >= totalChapters} onClick={() => { void startArc('next') }}>
            <Sparkles size={14} aria-hidden />{busyArc ? text('提交中…', 'Starting…') : text('AI 生成粗纲', 'Generate arc outline')}
          </Button>
          {arcs.length === 0 && (
            <Button variant="text" size="sm" disabled={busyArc} onClick={() => { void startArc('reverse') }}>
              {text('从现有细纲反推粗纲', 'Derive from existing outline')}
            </Button>
          )}
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
      </header>}

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
                {arc.status !== 'confirmed' && (
                  <Button variant="secondary" size="sm" onClick={() => { void confirmArc(arc) }}>
                    <Check size={13} aria-hidden />{text('确认此段', 'Confirm segment')}
                  </Button>
                )}
                <Button variant="text" size="sm" disabled={arc.status !== 'confirmed' || busyFineArc !== null} onClick={() => { void startFineOutline(arc) }}>
                  <ListTree size={13} aria-hidden />{busyFineArc === arc.arcIndex ? text('提交中…', 'Starting…') : text('按本段生成全部细纲', 'Generate all chapter outlines in this segment')}
                </Button>
                <Button variant="text" size="sm" onClick={() => setReviseScope({ kind: 'arc', arcIndex: arc.arcIndex })}>
                  <PencilLine size={13} aria-hidden />{text('改这一段', 'Revise')}
                </Button>
                <Button variant="text" size="sm" onClick={() => setReviseScope({ kind: 'from-chapter', chapterNumber: arc.fromChapter })}>
                  {text('从本章之后重来', 'Regenerate after this chapter')}
                </Button>
              </li>
            ))}
          </ol>
        )}

      {pendingRevise && (
        <p className="arch-arc-pending" role="status">
          {text(
            '已按你的方向登记重生成范围：第 ' + pendingRevise.chapters[0] + '–' + pendingRevise.chapters[pendingRevise.chapters.length - 1] + ' 章。',
            'Regeneration registered for chapters ' + pendingRevise.chapters[0] + '-' + pendingRevise.chapters[pendingRevise.chapters.length - 1] + '.',
          )}
        </p>
      )}
      {error && <p className="arch-arc-error" role="alert">{error}</p>}
      {staleChapters.length > 0 && (
        <p className="arch-arc-stale" role="status">
          <Sparkles size={13} aria-hidden />
          {text(
            '粗纲改动后，第 ' + staleChapters.join('、') + ' 章的细纲需要重新生成。',
            'After the arc change, chapter outlines for ch. ' + staleChapters.join(', ') + ' need regeneration.',
          )}
        </p>
      )}
      {reviseScope && (
        <ArcReviseDialog
          scope={reviseScope}
          arcs={arcs}
          staleChapters={staleChapters}
          totalChapters={totalChapters}
          onConfirm={(direction, affected) => {
            // 段级：只重写这一段；从第 X 章之后：依次重写该章所在段及其后所有段。
            const firstChapter = affected[0]
            const startIndex = reviseScope.kind === 'arc'
              ? reviseScope.arcIndex
              : arcs.find(arc => firstChapter !== undefined && firstChapter >= arc.fromChapter && firstChapter <= arc.toChapter)?.arcIndex
            const targets = startIndex === undefined
              ? []
              : arcs.filter(arc => reviseScope.kind === 'arc' ? arc.arcIndex === startIndex : arc.arcIndex >= startIndex)
            setReviseScope(null)
            if (targets.length === 0) {
              setError(text('没有找到需要重写的粗纲段。', 'No arc segment was found to rewrite.'))
              return
            }
            void (async () => {
              const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
              if (!projectSession || !isProjectSessionCurrent(projectSession)) return
              setBusyArc(true)
              setError('')
              try {
                // 重写只改目标段自己的 revision，后续段 revision 不变，因此可依次提交。
                for (const targetArc of targets) {
                  const receipt = await launchCreativeWorkflow({
                    workflow: 'generate_arc_outline',
                    mode: 'revise',
                    revise: { arcIndex: targetArc.arcIndex, expectedRevision: targetArc.revision, direction },
                  }, projectSession)
                  await waitForArcRun(receipt.runId)
                }
                setPendingRevise({ direction, chapters: affected })
                await load()
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause))
              } finally {
                setBusyArc(false)
              }
            })()
          }}
          onClose={() => setReviseScope(null)}
        />
      )}
    </section>
  )

  return body
}
