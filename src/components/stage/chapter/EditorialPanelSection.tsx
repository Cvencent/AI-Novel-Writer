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

  const run = () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || draftId === undefined || draftVersion === undefined || starting) return
    setStarting(true)
    const workflow = createEditorialPanelWorkflow({ projectPath: session.projectPath, projectSession: session, chapterNumber, draftId, draftVersion, locale })
    activeRunId.current = workflow.runId ?? null
    // 不跳到运行侧页：评审就是在这块面板里出分。跳走会把审稿报告（含勾选修稿）
    // 整个换掉，作者回来只看到运行日志和一步 JSON，还以为没出结果。
    void useWorkflowStore.getState().startWorkflow(workflow).finally(() => {
      if (isProjectSessionCurrent(session)) setStarting(false)
    })
  }

  if (draftId === undefined) return null

  return (
    <section className="stage-editorial-panel" aria-label={text('编辑部评审', 'Editorial panel')}>
      <header className="stage-editorial-head">
        <div><h3>{text('编辑部评审', 'Editorial panel')}</h3><p>{text('情节、连续性、角色、文风、节奏分别评分。', 'Independent scores for plot, continuity, character, style, and pacing.')}</p></div>
        <Button variant="secondary" size="sm" disabled={starting || draftVersion === undefined} onClick={run}><Sparkles size={13} aria-hidden />{starting ? text('五位编辑评审中…', 'Reviewing…') : quality ? text('重新评估', 'Re-evaluate') : text('运行编辑部', 'Run panel')}</Button>
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
                      const included = checklist
                        ? checklist.items.some(item => item.origin === 'author'
                            && (item.description + '|' + (item.quote ?? '')).trim() === (finding.description + '|' + (finding.evidence ?? '')).trim())
                        : false
                      return (
                        <li key={index} data-severity={finding.severity}>
                          <b>{finding.severity}</b>
                          {finding.description}
                          {finding.evidence && <q>{finding.evidence}</q>}
                          {checklist && (included
                            ? <span className="stage-editorial-included">{text('已纳入修稿', 'Included in revision')}</span>
                            : <Button variant="secondary" size="sm" onClick={() => {
                                checklist.includeEditorialFinding({ severity: finding.severity, description: finding.description, evidence: finding.evidence, roleLabel })
                              }}>{text('纳入修稿', 'Include in revision')}</Button>)}
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
            <div className="stage-editorial-actions">
              <Button variant="secondary" size="sm" onClick={() => {
                for (const role of quality.roles) {
                  const roleLabel = text(...ROLE_LABELS[role.role])
                  for (const finding of role.findings) {
                    checklist.includeEditorialFinding({ severity: finding.severity, description: finding.description, evidence: finding.evidence, roleLabel })
                  }
                }
              }}>{text('全部纳入修稿', 'Include all in revision')}</Button>
              <span className="stage-editorial-hint">{text('纳入后与普通审稿意见一样：在上方清单勾选，然后「按 N 项意见修稿」。', 'Included notes join the checklist above: tick them, then revise by the selected items.')}</span>
            </div>
          )}
        </>
      ) : <p className="stage-ch-sheet-note">{text('还没有编辑部评分。运行后会写入这份草稿的质量记录。', 'No editorial score yet. Running it records quality for this draft.')}</p>}
    </section>
  )
}
