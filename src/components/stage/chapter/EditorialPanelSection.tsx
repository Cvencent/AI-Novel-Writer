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
  const [starting, setStarting] = useState(false)
  // Bound to this draft so a late response from a previous draft cannot win.
  const requestRevision = useRef(0)
  const activeRunId = useRef<string | null>(null)
  const quality = loaded && loaded.draftId === draftId ? loaded.quality : null

  const load = useCallback(async (boundDraftId: number | undefined, revision: number) => {
    if (boundDraftId === undefined) return
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session) return
    try {
      const response = await ipc.invokeWithProjectSession(session, 'db:writing-intelligence-quality-get', boundDraftId, session.projectPath)
      if (isProjectSessionCurrent(session) && revision === requestRevision.current) setLoaded({ draftId: boundDraftId, quality: response })
    } catch {
      if (isProjectSessionCurrent(session) && revision === requestRevision.current) setLoaded({ draftId: boundDraftId, quality: null })
    }
  }, [])

  // Switching drafts invalidates any in-flight read; the paired guard hides stale content.
  useEffect(() => {
    requestRevision.current += 1
    activeRunId.current = null
    void load(draftId, requestRevision.current)
  }, [draftId, load])

  useEffect(() => globalEventBus.on('WORKFLOW_COMPLETE', ({ runId }) => {
    if (runId !== activeRunId.current) return
    activeRunId.current = null
    if (!captureProjectSession(useProjectStore.getState().currentProject)) return
    // Re-read against whichever draft is mounted now; the revision guard drops stale replies.
    requestRevision.current += 1
    void load(draftId, requestRevision.current)
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
      ) : <p className="stage-ch-sheet-note">{text('还没有编辑部评分。点上方「AI 审稿」会连同五角色评审一起跑，结果写入这份草稿的质量记录。', 'No editorial score yet. “AI review” above runs the five-editor panel together with the consistency review and records it for this draft.')}</p>}
    </section>
  )
}
