import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { Check, Layers, ListTree, PencilLine, SkipForward, Sparkles, Trash2 } from 'lucide-react'
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
import { DangerConfirm } from '../../ui/DangerConfirm'
import type { ArcOutlineRecord } from '../../../../electron/repositories/arc-outline-repository'

/** 生成模式：逐段等作者确认，或连续铺完。 */
export type ArcGenerationMode = 'waitConfirm' | 'skipConfirm'

/**
 * 粗纲面板：列出已生成的粗纲段，控制生成模式，并在存在过期细纲时提示。
 * 粗纲不含人名，只管方向；细纲才落到每章。
 */
export default function ArcOutlinePanel({ projectKey, fineSource, fineProgress, embedded = false, runnerRef, onChanged }: {
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
  /**
   * 台账变化（新增一段、确认、改写）后通知上层重读：节徽标与流程脊都读上层那份 overview.arc，
   * 只刷新面板自己的列表不够。
   */
  onChanged?: () => void
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
  const [selectedArcs, setSelectedArcs] = useState<Set<number>>(new Set())
  const [pendingDeleteArc, setPendingDeleteArc] = useState<number | null>(null)
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

  /** 最新的 onChanged：用 ref 持有，免去给每个写入路径的 useCallback 加依赖。 */
  const onChangedRef = useRef(onChanged)
  useEffect(() => { onChangedRef.current = onChanged })
  /** 台账被写过（新增、确认、改写）之后：重读本面板，并让上层重读节徽标与流程脊。 */
  const notifyChanged = () => { onChangedRef.current?.() }

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
   * “等我确认”每段停下等你确认；“跳过确认”一段接一段生成到全书铺满。
   *
   * generateAll=true 是「一键生成全部粗纲」：不管当前模式，都按跳过确认一路铺到全书末章。
   * 单独给这个参数而不是直接改 mode，是为了不悄悄改掉作者选好的模式——
   * 那个选择在按钮松开后应该还是他原来选的那个。
   */
  const startArc = async (arcMode: 'next' | 'reverse', generateAll = false) => {
    const effectiveMode: ArcGenerationMode = generateAll ? 'skipConfirm' : mode
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
        notifyChanged()
        return
      }
      let latest = await readArcs()
      let coveredNow = latest.reduce((max, arc) => Math.max(max, arc.toChapter), 0)
      while (coveredNow < totalChapters) {
        if (effectiveMode === 'waitConfirm' && latest.some(arc => arc.status !== 'confirmed')) {
          setError(text('请先确认当前粗纲段，再生成下一段。', 'Confirm the current arc segment before generating the next one.'))
          break
        }
        const receipt = await launchCreativeWorkflow({ workflow: 'generate_arc_outline', mode: 'next' }, projectSession)
        await waitForArcRun(receipt.runId)
        latest = await readArcs()
        const nextCovered = latest.reduce((max, arc) => Math.max(max, arc.toChapter), 0)
        if (nextCovered <= coveredNow) break
        coveredNow = nextCovered
        if (effectiveMode === 'skipConfirm') {
          for (const arc of latest.filter(item => item.status === 'draft')) {
            await ipc.invoke('db:arc-outline-confirm', arc.arcIndex, arc.revision, projectKey).catch(() => null)
          }
          latest = await readArcs()
        }
        if (effectiveMode === 'waitConfirm') break
      }
      await load()
      notifyChanged()
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


  /** 操作前重读一次：面板里的 revision 可能已经过期。 */
  const readLatestArc = async (arcIndex: number): Promise<ArcOutlineRecord | null> => {
    const list = await ipc.invoke('db:arc-outline-list', projectKey).catch(() => [])
    const fresh = Array.isArray(list) ? list as ArcOutlineRecord[] : []
    setArcs(fresh)
    return fresh.find(arc => arc.arcIndex === arcIndex) ?? null
  }

  const isStale = (result: { error?: string } | null) => String(result?.error ?? '').includes('ARC_OUTLINE_REVISION_STALE')

  /** 人工确认一段粗纲，之后才允许按“等我确认”继续下一段或生成细纲。 */
  const confirmArc = async (arc: ArcOutlineRecord) => {
    setError('')
    let latest = await readLatestArc(arc.arcIndex)
    if (!latest) { setError(text('这一段已经不存在，请刷新后重试', 'This segment no longer exists; refresh and try again')); return }
    let result = await ipc.invoke('db:arc-outline-confirm', latest.arcIndex, latest.revision, projectKey).catch(() => null) as { success?: boolean; error?: string } | null
    if (!result?.success && isStale(result)) {
      latest = await readLatestArc(arc.arcIndex)
      if (latest) result = await ipc.invoke('db:arc-outline-confirm', latest.arcIndex, latest.revision, projectKey).catch(() => null) as { success?: boolean; error?: string } | null
    }
    if (!result?.success) setError(result?.error || text('确认粗纲失败', 'Could not confirm the arc segment'))
    await load()
    notifyChanged()
  }

  /** 按一个已确认粗纲段生成逐章细纲。 */
  const startFineOutline = async (arc: ArcOutlineRecord) => {
    const projectSession = captureProjectSession(useProjectStore.getState().currentProject)
    if (!projectSession || !isProjectSessionCurrent(projectSession)) {
      setError(text('项目会话已切换，请重新打开作品。', 'The project session changed. Reopen the book and try again.'))
      return
    }
    const latest = await readLatestArc(arc.arcIndex)
    if (!latest) { setError(text('这一段已经不存在，请刷新后重试', 'This segment no longer exists; refresh and try again')); return }
    setBusyFineArc(latest.arcIndex)
    setError('')
    try {
      for (let from = latest.fromChapter; from <= latest.toChapter; from += 10) {
        const to = Math.min(latest.toChapter, from + 9)
        const receipt = await launchCreativeWorkflow({
          workflow: 'generate_architecture',
          selectedSteps: ['synopsis'],
          synopsisRange: { from, to },
          arcContext: { arcId: latest.id, rev: latest.revision, from: latest.fromChapter, to: latest.toChapter, summary: latest.summary, beat: latest.beat },
        }, projectSession)
        await waitForArcRun(receipt.runId)
      }
      await load()
      notifyChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyFineArc(null)
    }
  }

  if (loading) return null

  const body = (
    <section className={embedded ? 'arch-arc arch-arc-embedded' : 'arch-arc'} aria-label={text('粗纲', 'Arc outline')}>
      {/*
        嵌入到架构页时也要能选模式、也要有一键铺满的入口。
        以前这些控件全在 header 里，而嵌入模式整个 header 都不渲染，
        结果架构页上既看不到「等我确认/跳过确认」，也没有一键生成全部粗纲。
      */}
      {embedded && (
        <div className="arch-arc-toolbar" role="group" aria-label={text('粗纲生成方式', 'Arc generation mode')}>
          <div className="arch-arc-toolbar-modes">
            <Button
              variant={mode === 'waitConfirm' ? 'primary' : 'secondary'}
              size="sm"
              aria-pressed={mode === 'waitConfirm'}
              disabled={busyArc}
              onClick={() => setMode('waitConfirm')}
            >
              <Check size={14} aria-hidden />{text('等我确认', 'Wait for me')}
            </Button>
            <Button
              variant={mode === 'skipConfirm' ? 'primary' : 'secondary'}
              size="sm"
              aria-pressed={mode === 'skipConfirm'}
              disabled={busyArc}
              onClick={() => setMode('skipConfirm')}
            >
              <SkipForward size={14} aria-hidden />{text('跳过确认', 'Skip confirmation')}
            </Button>
          </div>
          <div className="arch-arc-toolbar-actions">
            {covered < totalChapters && (
              <Button
                variant="primary"
                size="sm"
                disabled={busyArc || totalChapters <= 0}
                title={text('从下一段开始，一段接一段生成到全书末章', 'Generate segment after segment through the final chapter')}
                onClick={() => { void startArc('next', true) }}
              >
                <Sparkles size={14} aria-hidden />
                {busyArc ? text('生成中…', 'Generating…') : text('一键生成全部粗纲', 'Generate all arc segments')}
              </Button>
            )}
            {arcs.length === 0 && (
              <Button variant="text" size="sm" disabled={busyArc} onClick={() => { void startArc('reverse') }}>
                {text('从现有细纲反推粗纲', 'Derive from existing outline')}
              </Button>
            )}
          </div>
        </div>
      )}
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
        : (<>
          <div className="arch-arc-bulk">
            <label className="arch-arc-bulk-all">
              <input type="checkbox" checked={arcs.length > 0 && arcs.every(arc => selectedArcs.has(arc.arcIndex))}
                onChange={event => setSelectedArcs(event.target.checked ? new Set(arcs.map(arc => arc.arcIndex)) : new Set())} />
              {text('全选', 'Select all')}
            </label>
            <span>{text(`已选 ${selectedArcs.size} 段`, `${selectedArcs.size} selected`)}</span>
            <Button variant="secondary" size="sm" disabled={selectedArcs.size === 0}
              onClick={() => setPendingDeleteArc(Math.min(...selectedArcs))}>
              <Trash2 size={13} aria-hidden />{text('删除所选段及之后的全部段', 'Delete selected and all later segments')}
            </Button>
          </div>
          <ol className="arch-arc-list">
            {arcs.map(arc => (
              <li key={arc.id} className="arch-arc-item" data-status={arc.status}>
                <input type="checkbox" className="arch-arc-check"
                  aria-label={text(`选择第 ${arc.fromChapter}–${arc.toChapter} 章粗纲`, `Select arc ch. ${arc.fromChapter}-${arc.toChapter}`)}
                  checked={selectedArcs.has(arc.arcIndex)}
                  onChange={event => setSelectedArcs(prev => { const next = new Set(prev); if (event.target.checked) next.add(arc.arcIndex); else next.delete(arc.arcIndex); return next })} />
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
        </>)}

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
                  const latestTarget = await readLatestArc(targetArc.arcIndex)
                  if (!latestTarget) continue
                  const receipt = await launchCreativeWorkflow({
                    workflow: 'generate_arc_outline',
                    mode: 'revise',
                    revise: { arcIndex: latestTarget.arcIndex, expectedRevision: latestTarget.revision, direction },
                  }, projectSession)
                  await waitForArcRun(receipt.runId)
                }
                setPendingRevise({ direction, chapters: affected })
                await load()
      notifyChanged()
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
      {pendingDeleteArc !== null && (
        <DangerConfirm
          open
          onOpenChange={open => { if (!open) setPendingDeleteArc(null) }}
          title={text('删除所选粗纲段？', 'Delete the selected arc segments?')}
          consequence={text(`将从第 ${pendingDeleteArc} 段起，删除该段及之后的全部粗纲段。`, `Segments from #${pendingDeleteArc} onward will be deleted.`)}
          recoverability={text('删除后无法撤销。可以重新生成这些段。', 'This cannot be undone. You can regenerate these segments.')}
          confirmLabel={text('删除', 'Delete')}
          cancelLabel={text('取消', 'Cancel')}
          onConfirm={() => { void (async () => {
            const result = await ipc.invoke('db:arc-outline-remove-from', pendingDeleteArc, projectKey).catch(() => null) as { success?: boolean; error?: string } | null
            if (!result?.success) { setError(result?.error ?? text('删除失败', 'Delete failed')); setPendingDeleteArc(null); return }
            setSelectedArcs(new Set())
            setPendingDeleteArc(null)
            await load()
            notifyChanged()
          })() }}
        />
      )}
    </section>
  )

  return body
}
