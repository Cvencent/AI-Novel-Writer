import { stripEmphasis } from '../../../shared/author-visible-text'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { createEditorialPanelWorkflow } from '../../../services/workflows/writing-intelligence-workflow'
import { ipc } from '../../../services/ipc-client'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { globalEventBus } from '../../../shared/event-bus'
import type { DraftQualityReview, EditorialRole } from '../../../shared/writing-intelligence'
import type { useReviewChecklist } from '../../editor/review-checklist'

type Checklist = ReturnType<typeof useReviewChecklist>
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'
import { StatGrid } from '../../ui/StatGrid'

const ROLE_LABELS: Record<EditorialRole, [string, string]> = {
  plot: ['情节', 'Plot'], continuity: ['连续性', 'Continuity'], character: ['角色', 'Character'], style: ['文风', 'Style'], pacing: ['节奏', 'Pacing'],
}

export default function EditorialPanelSection({ chapterNumber, draftId, draftVersion, checklist }: {
  chapterNumber: number
  draftId?: number
  draftVersion?: number
  /** 提供时，编辑部发现项可逐条「纳入修稿」，与普通审稿意见走同一条修稿链路。 */
  checklist?: Checklist
}) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  // Paired with the draft it was read for; a switch shows nothing until the new
  // read lands, so a previous draft's panel never lingers.
  const [loaded, setLoaded] = useState<{ draftId: number; quality: DraftQualityReview | null } | null>(null)
  /**
   * 审稿刚跑完、但这一稿**没有评分**时记下这次审稿的 runId。
   *
   * 现场（issue #245）：编辑部那一步模型失败，界面上却只显示「还没有编辑部评分」——
   * 跟「还没跑过」长得一模一样，作者以为没问题。这里用「跑完了却没有分」这个事实
   * 判定为**失败**，明确说出来，而不是让空状态冒充正常。
   */
  const [failedForDraft, setFailedForDraft] = useState<number | null>(null)
  const [starting, setStarting] = useState(false)
  // Bound to this draft so a late response from a previous draft cannot win.
  const requestRevision = useRef(0)
  const activeRunId = useRef<string | null>(null)
  const quality = loaded && loaded.draftId === draftId ? loaded.quality : null

  const load = useCallback(async (boundDraftId: number | undefined, revision: number): Promise<DraftQualityReview | null> => {
    if (boundDraftId === undefined) return null
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session) return null
    try {
      const response = await ipc.invokeWithProjectSession(session, 'db:writing-intelligence-quality-get', boundDraftId, session.projectPath)
      if (isProjectSessionCurrent(session) && revision === requestRevision.current) setLoaded({ draftId: boundDraftId, quality: response })
      return (response as DraftQualityReview | null) ?? null
    } catch {
      if (isProjectSessionCurrent(session) && revision === requestRevision.current) setLoaded({ draftId: boundDraftId, quality: null })
      return null
    }
  }, [])

  // Switching drafts invalidates any in-flight read; the paired guard hides stale content.
  useEffect(() => {
    requestRevision.current += 1
    activeRunId.current = null
    void load(draftId, requestRevision.current)
  }, [draftId, load])

  /**
   * 审稿完成后重读评分。
   *
   * `AI 审稿` 现在会把编辑部评审作为**工作流的一步**跑（不是这块面板自己启动的），
   * 所以不能再用 `runId === activeRunId.current` 过滤——那个 ref 只有「重新评估」按钮
   * 才会赋值，AI 审稿触发的 runId 永远不匹配，于是评分明明已落库、面板却停在
   * 「还没有编辑部评分」，作者必须切一次页面（重挂载）才看得到。
   *
   * 现在只按**当前挂载的稿**重读：`load` 内部有 revision 守卫，
   * 晚到的旧回应会被丢掉，不会把上一稿的分数盖上来。
   *
   * ⚠️ 必须监听 `WORKFLOW_SETTLED` 而不是 `WORKFLOW_COMPLETE`（issue #245 现场）：
   * 只有**成功**路径才发 COMPLETE；一旦某一层步骤抛错（比如深度检查失败），
   * 工作流 catch → break，只发 SETTLED。只听 COMPLETE 的话，失败时面板永远收不到
   * 刷新信号，评分即使已落库也停在「还没有编辑部评分」——作者只能靠切页重挂载。
   * SETTLED 的语义正是「这次运行结束了，去看落库结果」，成功失败都发。
   */
  useEffect(() => globalEventBus.on('WORKFLOW_SETTLED', () => {
    if (!captureProjectSession(useProjectStore.getState().currentProject)) return
    requestRevision.current += 1
    void load(draftId, requestRevision.current).then(quality => {
      // 读回来仍没有评分 → 这一稿的编辑部评审失败了（不是「还没跑过」）。
      // 只在确实跑完一次审稿之后才这样判定，否则新稿一挂载就会被误报成失败。
      if (draftId !== undefined) setFailedForDraft(quality ? null : draftId)
    })
  }), [draftId, load])

  /**
   * 自动把面板发现并入修稿清单（幂等，见 `autoMergeEditorialFindings`）。
   *
   * 五角色评审已并入 AI 审稿一起跑（审稿工作流的最后一步），所以这块面板不再有
   * 「运行编辑部」按钮——作者点一次审稿就出分、出发现，且发现**直接进清单**，
   * 不用再点一次「纳入修稿」。`merged` 记的是本次已并入的键，避免重挂载重复并入。
   */
  const autoMerge = useCallback((quality: DraftQualityReview | null) => {
    if (!checklist || !quality) return
    checklist.autoMergeEditorialFindings(quality.roles.flatMap(role => {
      const roleLabel = text(...ROLE_LABELS[role.role])
      return role.findings.map(finding => ({
        severity: finding.severity, description: finding.description, evidence: finding.evidence, roleLabel,
      }))
    }))
  }, [checklist, text])

  useEffect(() => { autoMerge(quality) }, [autoMerge, quality])

  /** 手动重跑：作者想换一次评分/发现时用（例如改过稿或想换采样）。 */
  const rerun = () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || draftId === undefined || draftVersion === undefined || starting) return
    setStarting(true)
    const workflow = createEditorialPanelWorkflow({ projectPath: session.projectPath, projectSession: session, chapterNumber, draftId, draftVersion, locale })
    activeRunId.current = workflow.runId ?? null
    void useWorkflowStore.getState().startWorkflow(workflow).finally(() => {
      if (!isProjectSessionCurrent(session) || draftId === undefined) return
      setStarting(false)
      requestRevision.current += 1
      void load(draftId, requestRevision.current)
    })
  }

  if (draftId === undefined) return null

  return (
    <section className="stage-editorial-panel" aria-label={text('编辑部评审', 'Editorial panel')}>
      <header className="stage-editorial-head">
        <div><h3>{text('编辑部评审', 'Editorial panel')}</h3><p>{text('情节、连续性、角色、文风、节奏分别评分；发现已并入上方修稿清单。', 'Independent scores for plot, continuity, character, style, and pacing; findings are already merged into the revision checklist above.')}</p></div>
        <Button variant="secondary" size="sm" disabled={starting || draftVersion === undefined} onClick={rerun}><Sparkles size={13} aria-hidden />{starting ? text('五位编辑评审中…', 'Reviewing…') : text('重新评估', 'Re-evaluate')}</Button>
      </header>
      {quality ? (
        <>
          <StatGrid label={text('编辑部评分', 'Editorial score')} items={[
            { id: 'score', label: text('加权总分', 'Weighted score'), value: quality.weightedScore.toFixed(1) },
            { id: 'blocking', label: text('阻断', 'Blocking'), value: String(quality.blockingCount) },
            { id: 'roles', label: text('角色数', 'Roles'), value: String(quality.roles.length) },
          ]} />
          {quality.summary && <p className="stage-ch-sheet-summary">{quality.summary}</p>}
          <div className="stage-editorial-roles">
            {quality.roles.map(role => {
              const roleLabel = text(...ROLE_LABELS[role.role])
              return (
              <details key={role.role} className="stage-editorial-role" open={role.findings.some(finding => finding.severity === 'blocking') || undefined}>
                <summary><b>{roleLabel}</b><span>{role.score.toFixed(0)}</span><small>{role.summary}</small></summary>
                {role.findings.length > 0 ? (
                  <ul>
                    {role.findings.map((finding, index) => {
                      // 发现已**自动并入**上方清单（见 autoMerge）。这里只如实显示并入状态；
                      // 想排除某条，作者直接在清单里取消勾选或删掉它——本面板不再提供第二个入口，
                      // 两个入口写同一份清单只会互相打架。
                      const included = checklist
                        ? checklist.items.some(item => item.origin === 'author'
                            && (item.description + '|' + (item.quote ?? '')).trim() === (finding.description + '|' + (finding.evidence ?? '')).trim())
                        : false
                      return (
                        <li key={index} data-severity={finding.severity}>
                          <b>{finding.severity}</b>
                          {/* issue #154：作者可见 → 剥掉 Markdown 粗体（只在渲染侧）。 */}
                          {stripEmphasis(finding.description)}
                          {finding.evidence && <q>{stripEmphasis(finding.evidence)}</q>}
                          {checklist && included && <span className="stage-editorial-included">{text('已并入清单', 'Merged into checklist')}</span>}
                        </li>
                      )
                    })}
                  </ul>
                ) : <p>{text('未发现需要记录的问题。', 'No finding recorded.')}</p>}
              </details>
              )
            })}
          </div>
          {checklist && quality.roles.some(role => role.findings.length > 0) && (
            <p className="stage-editorial-hint">{text('五角色的发现已自动并入上方修稿清单；要排除某条，直接在清单里取消勾选或删除它。', 'The five editors’ findings are merged into the checklist above; to exclude one, untick or delete it there.')}</p>
          )}
        </>
      ) : failedForDraft === draftId
        // 跑完了却没有分 = 失败。空状态不能冒充「一切正常」——那正是作者被误导的地方。
        ? <Notice tone="warn" title={text('编辑部评审没跑成', 'The editorial panel did not run')}
            actions={(
              <Button variant="secondary" size="sm" disabled={starting || draftVersion === undefined} onClick={rerun}>
                <Sparkles size={13} aria-hidden />{starting ? text('五位编辑评审中…', 'Reviewing…') : text('重试编辑部评审', 'Retry the panel')}
              </Button>
            )}>
            {text('五角色评审这次没有产出评分（模型调用失败或返回不合规）。一致性审稿已经完成并保存，上方清单不受影响。详情见运行侧页里「编辑部评审」那一步。',
              'This run produced no panel score (the model call failed or returned malformed output). The consistency review finished and is saved, so the checklist above is unaffected. See the “Editorial panel” step in the run sheet for details.')}
          </Notice>
        : <p className="stage-ch-sheet-note">{text('还没有编辑部评分。点上方「AI 审稿」会连同五角色评审一起跑，结果写入这份草稿的质量记录。', 'No editorial score yet. “AI review” above runs the five-editor panel together with the consistency review and records it for this draft.')}</p>}
    </section>
  )
}
