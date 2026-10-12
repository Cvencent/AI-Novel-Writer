import { useState } from 'react'
import { ChevronDown, ChevronUp, Eye } from 'lucide-react'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { CharacterProposalSelectionPanel } from '../../characters/CharacterProposalSelectionPanel'
import { usePendingCharacterProposals } from '../../characters/use-pending-character-proposals'
import { STATE_FIELD_LABELS, usePendingStateCandidates } from '../../characters/use-pending-state-candidates'
import { captureProjectSession } from '../../project-session-gate'
import { Button } from '../../ui/Button'
import { Notice } from '../../ui/Notice'

/** 角色决策（定稿或导入产生）与角色状态建议（定稿产生）合成一条提示条；没有待处理项时不显示。 */
export default function CharacterSuggestions() {
  const project = useProjectStore(state => state.currentProject)
  const session = captureProjectSession(project)
  return session ? <SessionSuggestions key={`${session.projectId}:${session.leaseId}`} session={session} /> : null
}

function SessionSuggestions({ session }: { session: ProjectSessionContext }) {
  const text = useLocaleStore(state => state.text)
  const proposals = usePendingCharacterProposals(session)
  const states = usePendingStateCandidates(session)
  const [collapsed, setCollapsed] = useState(false)
  const count = proposals.summaries.length + states.summaries.length
  const busy = proposals.busy || states.busy
  const errors = [proposals.error, states.error].filter(Boolean)
  if (count === 0 && errors.length === 0) return null

  return (
    <div className="cast-suggestions" role="region" aria-label={text('待处理的角色建议', 'Pending character suggestions')}>
      <Notice
        title={text(`${count} 项待处理的角色建议`, `${count} pending character suggestions`)}
        actions={(
          <Button variant="text" size="sm" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>
            {collapsed ? text('展开', 'Show') : text('收起', 'Hide')}
            {collapsed ? <ChevronDown size={14} aria-hidden /> : <ChevronUp size={14} aria-hidden />}
          </Button>
        )}
      >
        {text('来自定稿与导入的角色卡。接受前不会改动角色名单。', 'From finalized chapters and imported cards. Nothing changes in the cast until you accept.')}
      </Notice>
      {!collapsed && (
        <ul className="cast-suggestion-list">
          {!proposals.batch && proposals.summaries.map(summary => (
            <li key={summary.proposalBatchId} className="cast-suggestion" data-kind="decision">
              <span className="cast-suggestion-kind">{summary.importOperationId ? text('导入角色', 'Imported') : text('定稿角色', 'Finalized')}</span>
              <span className="cast-suggestion-text">{summary.importOperationId ?? summary.finalizationId}</span>
              <Button variant="text" size="sm" disabled={busy}
                aria-label={summary.importOperationId ? text('检查导入角色决策', 'Review imported character decision') : text('检查定稿角色决策', 'Review finalized character decision')}
                onClick={() => { void proposals.read(summary) }}>
                <Eye size={14} aria-hidden />{text('检查', 'Review')}
              </Button>
            </li>
          ))}
          {proposals.batch && proposals.choices && (
            <li className="cast-suggestion cast-suggestion-open" data-kind="decision">
              <CharacterProposalSelectionPanel batch={proposals.batch} identities={proposals.identities} choices={proposals.choices}
                onChange={proposals.setChoices} disabled={busy} />
              <div className="cast-suggestion-decide">
                <Button variant="text" size="sm" disabled={busy} onClick={() => { void proposals.decide('cancel') }}>{text('拒绝这些决策', 'Reject decisions')}</Button>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => { void proposals.decide('approve') }}>{text('接受这些决策', 'Accept decisions')}</Button>
              </div>
            </li>
          )}
          {!states.candidate && states.summaries.map(summary => (
            <li key={summary.candidateKey} className="cast-suggestion" data-kind="state">
              <span className="cast-suggestion-kind">{text('状态建议', 'State')}</span>
              <span className="cast-suggestion-text">{summary.characterName} · {text(...STATE_FIELD_LABELS[summary.field])}</span>
              <Button variant="text" size="sm" disabled={busy} aria-label={text('检查定稿状态建议', 'Review finalized state suggestion')}
                onClick={() => { void states.read(summary) }}>
                <Eye size={14} aria-hidden />{text('检查', 'Review')}
              </Button>
            </li>
          ))}
          {states.candidate && (
            <li className="cast-suggestion cast-suggestion-open" data-kind="state">
              <div className="cast-suggestion-compare">
                <strong>{states.candidate.characterName} · {text(...STATE_FIELD_LABELS[states.candidate.field])}</strong>
                <span>{text('当前：', 'Current: ')}{states.current || text('空', 'Empty')}</span>
                <span>{text('建议：', 'Suggested: ')}{states.candidate.value}</span>
              </div>
              <div className="cast-suggestion-decide">
                <Button variant="text" size="sm" disabled={busy} onClick={() => { void states.decide('decline') }}>{text('拒绝状态建议', 'Reject state suggestion')}</Button>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => { void states.decide('accept') }}>{text('接受状态建议', 'Accept state suggestion')}</Button>
              </div>
            </li>
          )}
          {errors.map(error => <li key={error} role="alert" className="cast-suggestion-error">{error}</li>)}
        </ul>
      )}
    </div>
  )
}
