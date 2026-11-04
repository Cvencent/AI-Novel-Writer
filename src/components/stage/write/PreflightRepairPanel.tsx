import { useState } from 'react'
import { Wrench } from 'lucide-react'

import { useLocaleStore } from '../../../stores/locale-store'
import type { RepairFieldDiff } from '../../../shared/preflight-repair'
import { Button } from '../../ui/Button'

export interface RepairProposal {
  layerLabel: string
  chapterNumber: number | null
  diffs: RepairFieldDiff[]
  /** 「全部修复」排队里还剩几层（issue #137）：0 表示修完这一层就结束了。 */
  remainingLayers?: number
}

interface PreflightRepairPanelProps {
  proposal: RepairProposal
  busy: boolean
  /** 采纳**这一条**字段改动。 */
  onApplyOne: (field: string) => void
  /** 采纳全部可修的字段改动。 */
  onApplyAll: () => void
  /** 全部放弃（不改任何字段）。 */
  onDismiss: () => void
}

/**
 * 「改完先看差异，作者确认后才落库」（issue #137 用户要求 3）。
 *
 * ⚠️ 默认**不勾选**：模型给出的每一处改写都要作者看过才生效。这不是谨慎过度——
 * 模型可能顺手改了与提醒无关的段落，而那种改动一旦自动落库就没人发现。
 *
 * ⚠️ 差异按**字段**展示（before → after），不渲染整篇文本：整篇 diff 会让作者
 * 在几百字里找那几处变化，而这一层本来就只需要看变了的字段。
 */
export default function PreflightRepairPanel({
  proposal, busy, onApplyOne, onApplyAll, onDismiss,
}: PreflightRepairPanelProps) {
  const text = useLocaleStore(s => s.text)
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const chosen = proposal.diffs.filter(diff => selected[diff.field])
  return (
    <section className="stage-preflight-repair" aria-label={text('修复建议', 'Suggested fixes')}>
      <p className="stage-preflight-head">
        <Wrench size={14} aria-hidden />
        {text(
          `${proposal.layerLabel}的改写建议 · ${proposal.diffs.length} 处`,
          `Suggested rewrites for ${proposal.layerLabel} · ${proposal.diffs.length} field${proposal.diffs.length === 1 ? '' : 's'}`,
        )}
      </p>
      <p className="stage-preflight-note">
        {text('下面是模型按提醒改出来的具体字段。勾选你认可的那几处，才会写进项目。',
          'These are the fields the model rewrote to resolve the reminders. Nothing is written until you pick the ones you accept.')}
      </p>
      {/* 跨层排队（issue #137）：告诉作者这一层不是最后一批，采纳后会继续提出下一层。 */}
      {(proposal.remainingLayers ?? 0) > 0 ? (
        <p className="stage-preflight-note">
          {text(`采纳后还会继续提出另外 ${proposal.remainingLayers} 层（每层都要你确认，不会自动连改）。`,
            `${proposal.remainingLayers} more layer${proposal.remainingLayers === 1 ? '' : 's'} will be proposed after you accept; each one still needs your confirmation.`)}
        </p>
      ) : null}
      {proposal.diffs.map(diff => (
        <div key={diff.field} className="stage-preflight-repair-item">
          <label className="stage-preflight-repair-pick">
            <input
              type="checkbox"
              checked={Boolean(selected[diff.field])}
              disabled={busy}
              onChange={event => setSelected(current => ({ ...current, [diff.field]: event.target.checked }))}
            />
            <span>{diff.field}</span>
          </label>
          {diff.reason ? <p className="stage-preflight-note">{diff.reason}</p> : null}
          <div className="stage-preflight-repair-diff">
            <p><strong>{text('改前', 'Before')}</strong></p>
            <p className="stage-preflight-repair-before">{diff.before || text('（空）', '(empty)')}</p>
            <p><strong>{text('改后', 'After')}</strong></p>
            <p className="stage-preflight-repair-after">{diff.after}</p>
          </div>
          <Button variant="text" size="sm" disabled={busy} onClick={() => onApplyOne(diff.field)}>
            {text('只采纳这一处', 'Apply just this one')}
          </Button>
        </div>
      ))}
      <div className="stage-preflight-actions">
        <Button variant="secondary" size="sm" disabled={busy || chosen.length === 0} onClick={onApplyAll}>
          {text(`采纳勾选的 ${chosen.length} 处`, `Apply ${chosen.length} selected`)}
        </Button>
        <Button variant="text" size="sm" disabled={busy} onClick={onDismiss}>
          {text('都不改', 'Keep as is')}
        </Button>
      </div>
    </section>
  )
}