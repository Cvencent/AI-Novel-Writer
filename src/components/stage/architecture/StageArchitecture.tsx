import { useCallback, useRef, useState } from 'react'
import { ArrowRight, Ellipsis, Sparkles } from 'lucide-react'
import { ARCH_STEP_NAMES, type ArchStepKey } from '../../../services/architecture-step-selection'
import { useCharacterStore } from '../../../stores/character-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { navigate } from '../../../stores/navigation/navigation-intents'
import { openBuiltinEditor } from '../../../stores/open-builtin-editor'
import { useProjectStore } from '../../../stores/project-store'
import { clearArchSection } from '../../editor/clear-arch-section'
import { ARCH_FILES, useArchitectureOverview, type ArchitectureOverview } from '../../editor/use-architecture-overview'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { captureProjectSession, isProjectSessionCurrent, isProjectSessionPath } from '../../project-session-gate'
import { Button } from '../../ui/Button'
import { DangerConfirm } from '../../ui/DangerConfirm'
import { Menu } from '../../ui/Menu'
import { toast } from '../../ui/Toast'
import { refreshStageWork } from '../use-stage-work'
import ArchitectureGenerateDialog from './ArchitectureGenerateDialog'
import { ipc } from '../../../services/ipc-client'
import { STAGE_REVIEW_MAX_TARGETS, type StageReviewFindingRecord } from '../../../shared/stage-review-types'
import ContinuousOutlinePanel from './ContinuousOutlinePanel'
import StageReviewPanel from '../review/StageReviewPanel'
import ReviewRangeDialog from '../review/ReviewRangeDialog'
import { startContinuousOutline } from '../../../services/workflows/continuous-outline-runner'
import { plotOutlineChapterSpans, plotOutlineNextChapter } from '../../../shared/plot-outline-contract'
import ArchitectureSection from './ArchitectureSection'
import { excerpt, mainAction, sectionBadge, SECTION_ORDER } from './architecture-sections'

/** 角色名单一节的摘要。角色卡在打开作品后单独载入（角色多时要几百毫秒），载完之前只这一节写「正在读取」，其余三节照常可用。 */
function useCastSummary(projectKey: string): { summary: string; loading: boolean } {
  const text = useLocaleStore(s => s.text)
  const characters = useCharacterStore(s => s.characters)
  const loaded = useCharacterStore(s => s.dataProjectKey === projectKey && s.loadingProjectKey === null)
  const error = useCharacterStore(s => s.lastError)
  if (!loaded) return { summary: text('正在读取角色名单…', 'Loading the cast…'), loading: true }
  if (error) return { summary: text(`角色名单读取失败：${error}`, 'Could not load the cast.'), loading: false }
  const names = characters.map(character => character.name).filter(Boolean)
  if (names.length === 0) return { summary: text('还没有角色。可以让 AI 按设定生成，也可以在角色名单里自己添加。', 'No characters yet. Let AI create them from the setup, or add them in the cast.'), loading: false }
  const shown = names.slice(0, 5).join(text('、', ', '))
  return { summary: text(`${names.length} 位角色：${shown}${names.length > 5 ? '……' : ''}`, `${names.length} ${names.length === 1 ? 'character' : 'characters'}: ${shown}${names.length > 5 ? '…' : ''}`), loading: false }
}

const openCast = (text: (zh: string, en: string) => string) => openBuiltinEditor('character-editor', text('角色名单', 'Cast'), 'character')

/**
 * 细纲检查入口只在「已经写出至少一章细纲」时显示：没有内容可检查时不该出现空面板。
 */
function synopsisTextForReview(overview: ArchitectureOverview): string {
  return overview.synopsisSource?.synopsis || overview.contents.synopsis || ''
}

/** 只要正式细纲里已有章节条目，就允许检查；与「是否有未完成候选」无关。 */
function outlineReviewAvailableForPage(overview: ArchitectureOverview): boolean {
  return plotOutlineChapterSpans(synopsisTextForReview(overview)).length > 0
}

/**
 * 架构阶段：故事前提、角色名单、世界观、粗纲、细纲五节。编辑一节打开它的文档标签，角色名单打开名单页；
 * 数据与操作来自 useArchitectureOverview。粗纲有自己的分段生成流程，不在「AI 生成架构」对话框里。
 */
export default function StageArchitecture({ projectKey }: { projectKey: string }) {
  const text = useLocaleStore(s => s.text)
  const overview = useArchitectureOverview(projectKey)
  const badges = Object.fromEntries(SECTION_ORDER.map(key => [key, sectionBadge(key, overview)])) as Record<ArchStepKey, ReturnType<typeof sectionBadge>>
  /** 页头计数与主按钮只数已确认的节（徽标「已确认」）：部分完成、不完整、待处理都不算。 */
  const filled = overview.loading ? null : SECTION_ORDER.filter(key => overview.confirmed[key]).length
  const cast = useCastSummary(projectKey)
  /** 清空确认打开时冻结的会话：确认时作品已换就什么也不写。 */
  const [clearing, setClearing] = useState<{ key: ArchStepKey; session: ProjectSessionContext } | null>(null)
  const [continuousTargetUnits, setContinuousTargetUnits] = useState(300)
  /** AI 检查细纲：待检查范围与进行中标记。空范围表示按已生成章节全检。 */
  const [outlineReviewRange, setOutlineReviewRange] = useState<{ from: number; to: number } | null>(null)
  const [outlineReviewBusy, setOutlineReviewBusy] = useState(false)
  const [outlineReviewOpen, setOutlineReviewOpen] = useState(false)
  /** 粗纲节的生成入口由 ArcOutlinePanel 提供，节头按钮直接复用同一份逻辑。 */
  const arcRunnerRef = useRef<((mode: 'next' | 'reverse') => void) | null>(null)

  const total = SECTION_ORDER.length
  const action = mainAction(SECTION_ORDER.map(key => overview.confirmed[key]), SECTION_ORDER)
  /** 细纲尚未覆盖到全书末章时，提供「一次生成全部剩余大纲」入口。 */
  const outlineIncomplete = (() => {
    const source = overview.synopsisSource
    if (!source || source.totalChapters <= 0) return false
    return plotOutlineNextChapter(source) <= source.totalChapters
  })()

  /** 细纲至少有一章时才谈得上检查；范围上限取全书章数与已生成到的章号。 */
  // 不要跟着 overview.loading 一起卸载：检查运行中重读页面会把面板和它的进行中状态一起丢掉。
  const outlineReviewVisible = outlineReviewAvailableForPage(overview)
  const outlineReviewMax = (() => {
    const spans = plotOutlineChapterSpans(synopsisTextForReview(overview))
    return spans.length > 0 ? spans[spans.length - 1]!.chapter : 0
  })()

  const reload = useCallback(() => {
    void overview.loadStatus()
    void overview.roster.refresh()
    void refreshStageWork(text)
  }, [overview, text])
  /** 接受一条细纲检查建议：按章替换 project_core.synopsis，然后重读整页状态。 */
  const applyOutlineFinding = useCallback(async (finding: StageReviewFindingRecord) => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || !isProjectSessionPath(session, projectKey)) return false
    const result = await ipc.invokeWithProjectSession(session, 'db:stage-review-apply-outline', finding.targetIndex, finding.expectedText, projectKey).catch(() => null) as { success?: boolean; error?: string } | null
    if (!result?.success) throw new Error(result?.error || text('写回失败', 'Could not write the change back.'))
    reload()
    return true
  }, [projectKey, reload, text])

  const editSection = (key: ArchStepKey) => {
    const file = ARCH_FILES.find(candidate => candidate.key === key)
    if (file) void overview.openArchFile(file)
  }

  const confirmClear = async () => {
    if (!clearing) return
    const { key, session } = clearing
    setClearing(null)
    if (!isProjectSessionPath(session, projectKey) || !isProjectSessionCurrent(session)) return
    const name = text(...ARCH_STEP_NAMES[key])
    const cleared = await clearArchSection(`ai-novel://core/${key}`, session)
    if (!isProjectSessionCurrent(session)) return
    if (!cleared) {
      toast.error(text(`清空「${name}」失败`, `Could not clear ${name}`))
      return
    }
    reload()
    toast.success(text(`已清空「${name}」`, `Cleared ${name}`))
  }

  const summary = (key: ArchStepKey) => {
    if (key === 'characters') return cast.summary
    // 粗纲是一组分段台账，不是单一正文字段；摘要列出各段标题与区间。
    if (key === 'arc') {
      const arcs = overview.arc.list
      if (arcs.length === 0) return text('还没有粗纲。先定方向，再按段生成逐章细纲。', 'No arc outline yet. Set direction first, then generate chapter outlines per segment.')
      const shown = arcs.slice(0, 3).map(arc => text(
        `第 ${arc.fromChapter}–${arc.toChapter} 章 ${arc.title}`,
        `Ch. ${arc.fromChapter}-${arc.toChapter} ${arc.title}`,
      )).join(text('；', '; '))
      return shown + (arcs.length > 3 ? text('……', '…') : '')
    }
    const content = overview.contents[key] ?? ''
    return overview.archStatus[key] && content
      ? excerpt(content, text('……', '…'))
      : text('还没有内容。可以让 AI 按设定生成，也可以自己写。', 'Nothing here yet. Let AI draft it from the setup, or write it yourself.')
  }

  const clearingName = clearing ? text(...ARCH_STEP_NAMES[clearing.key]) : ''

  return (
    <div className="arch-page" data-loading={overview.loading || undefined} data-cast-loading={cast.loading || undefined} data-status-unread={!overview.firstReadEnded || undefined}>
      <div className="arch-inner">
        <header className="arch-header">
          <div className="arch-heading">
            <p className="arch-eyebrow">{text('架构', 'Architecture')}{filled !== null && <span className="arch-progress"> · {text(`${filled} / ${total} 已确认`, `${filled} / ${total} confirmed`)}</span>}</p>
            <h1 className="arch-title">{text('故事的骨架', 'The bones of the story')}</h1>
            <p className="arch-lede">{text('前提、角色、世界观、粗纲和细纲。五节都确认后，就可以逐章规划蓝图。', 'Premise, cast, world, arc and outline. Once all five are confirmed, plan the chapters in the blueprint.')}</p>
          </div>
          <div className="arch-header-actions">
            <Menu
              label={text('架构的更多操作', 'More for architecture')}
              icon={<Ellipsis size={16} aria-hidden />}
              align="end"
              groups={[{ id: 'page', items: [
                { id: 'refresh', label: text('刷新状态', 'Refresh status'), onSelect: reload },
                ...(action === 'next' ? [{ id: 'generate', label: text('AI 生成架构…', 'Generate with AI…'), onSelect: () => overview.openGenerateDialog() }] : []),
                ...(outlineIncomplete ? [{ id: 'generate-all', label: text('一次生成全部剩余大纲…', 'Generate all remaining chapter outlines…'), onSelect: () => overview.openGenerateDialog(['synopsis']) }] : []),
              ] }]}
            />
            {action === 'next'
              ? (
                <Button variant="primary" onClick={() => navigate({ kind: 'stage', stage: 'blueprint' })}>
                  {text('下一步：章节蓝图', 'Next: chapter blueprint')}<ArrowRight size={14} aria-hidden />
                </Button>
              )
              : (
                <>
                  <Button variant="secondary" disabled title={text('五节都确认后才能进入蓝图', 'Confirm all five sections first')}>
                    {text('下一步：章节蓝图', 'Next: chapter blueprint')}<ArrowRight size={14} aria-hidden />
                  </Button>
                  <Button
                    variant="primary"
                    disabled={filled === null}
                    onClick={() => { if (action === 'generate-arc') arcRunnerRef.current?.('next'); else overview.openGenerateDialog() }}
                    title={action === 'generate-arc' ? text('其余四节都已确认，只差粗纲；点这里按段生成', 'All other sections are confirmed; only the arc outline is missing') : undefined}
                  >
                    <Sparkles size={14} aria-hidden />
                    {action === 'generate'
                      ? text('AI 生成架构', 'Generate architecture')
                      : action === 'generate-arc'
                        ? (overview.arc.list.length === 0 ? text('AI 生成粗纲', 'Generate arc outline') : text('继续生成粗纲', 'Continue arc outline'))
                        : text('继续生成架构', 'Continue architecture')}
                  </Button>
                </>
              )}
            {outlineIncomplete && (
              <><label className="arch-continuous-target">{text('每章约', 'About')}<input type="number" min={1} max={1000} value={continuousTargetUnits} aria-label={text('每章细纲目标字数', 'Outline target per chapter')} onChange={event => setContinuousTargetUnits(Math.max(1, Math.min(1000, Number(event.target.value) || 1)))} />{text('字', 'chars')}</label><Button variant="secondary" onClick={() => startContinuousOutline(continuousTargetUnits)} title={text('自动按 10 章一批，一直生成到全书结束，可随时暂停', 'Runs 10-chapter batches automatically to the end of the book; you can pause any time')}>
                <Sparkles size={14} aria-hidden />
                {text('一键生成全部剩余细纲', 'Generate all remaining chapter outlines')}
              </Button></>
            )}
          </div>
        </header>

        <ContinuousOutlinePanel targetUnits={continuousTargetUnits} />

        <div className="arch-sections">
          {SECTION_ORDER.map(key => (
            <ArchitectureSection
              key={key}
              sectionKey={key}
              overview={overview}
              badge={badges[key]}
              summary={summary(key)}
              onEdit={() => editSection(key)}
              onGenerate={() => { if (key !== 'arc') overview.openGenerateDialog([key]) }}
              onGenerateAllSynopsis={() => startContinuousOutline(continuousTargetUnits)}
              onGenerateArc={() => arcRunnerRef.current?.('next')}
              onArcChanged={reload}
              outlineReview={outlineReviewVisible ? (
                <StageReviewPanel
                  projectKey={projectKey}
                  target='outline'
                  launchIntent={{ workflow: 'review_outline', range: outlineReviewRange ?? { from: 1, to: 1 } }}
                  canReview={Boolean(outlineReviewRange)}
                  reviewBusy={outlineReviewBusy}
                  onReviewBusyChange={setOutlineReviewBusy}
                  applyFinding={applyOutlineFinding}
                  footer={(
                    <>
                      <span className='arch-arc-review-hint'>
                        {outlineReviewRange
                          ? text(`范围：第 ${outlineReviewRange.from}–${outlineReviewRange.to} 章`, `Range: chapters ${outlineReviewRange.from}-${outlineReviewRange.to}`)
                          : text('还没有选定检查范围', 'No review range chosen yet')}
                      </span>
                      <Button variant='secondary' size='sm' disabled={outlineReviewBusy} onClick={() => setOutlineReviewOpen(true)}>
                        {text('选择范围…', 'Choose range…')}
                      </Button>
                    </>
                  )}
                />
              ) : null}
              arcRunnerRef={arcRunnerRef}
              onClear={() => {
                const session = captureProjectSession(useProjectStore.getState().currentProject)
                if (session && isProjectSessionPath(session, projectKey)) setClearing({ key, session })
              }}
              onOpenCast={() => openCast(text)}
              onReload={reload}
            />
          ))}
        </div>
      </div>

      <ArchitectureGenerateDialog {...overview.generateDialog} />
      <ReviewRangeDialog
        key={'outline-review:' + outlineReviewMax}
        open={outlineReviewOpen}
        title={text('检查细纲', 'Review the outline')}
        description={text('选择要交给 AI 检查的章节范围。检查只读，不会自动改写原文；建议要你逐条接受。',
          'Choose which chapters to send to the AI. Reviewing is read-only; nothing is rewritten until you accept a suggestion.')}
        defaultFrom={1}
        defaultTo={Math.min(outlineReviewMax, STAGE_REVIEW_MAX_TARGETS)}
        maxTo={outlineReviewMax}
        onClose={() => setOutlineReviewOpen(false)}
        onConfirm={range => { setOutlineReviewRange(range); setOutlineReviewOpen(false) }}
      />
      <DangerConfirm
        open={clearing !== null}
        onOpenChange={open => { if (!open) setClearing(null) }}
        title={text(`清空「${clearingName}」？`, `Clear ${clearingName}?`)}
        consequence={text(`将删除「${clearingName}」的全部文本。其他三节、蓝图和正文不受影响。`, `All text in ${clearingName} will be deleted. The other sections, blueprints and chapters are not affected.`)}
        recoverability={text('清空后无法撤销；做过项目备份的，可以从备份恢复。', 'This cannot be undone. If you made a project backup, you can restore from it.')}
        confirmLabel={text('清空此节', 'Clear section')}
        cancelLabel={text('取消', 'Cancel')}
        onConfirm={() => { void confirmClear() }}
      />
    </div>
  )
}
