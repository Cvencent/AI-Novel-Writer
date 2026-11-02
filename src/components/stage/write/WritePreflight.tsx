import { useState } from 'react'
import { RotateCcw, ShieldAlert } from 'lucide-react'
import type { ConsistencyPreflightResult } from '../../../services/consistency-preflight'
import { useLocaleStore } from '../../../stores/locale-store'
import { Button } from '../../ui/Button'

interface WritePreflightProps {
  preflight: ConsistencyPreflightResult
  busy: boolean
  onIgnoreOnce: () => void
  onRerun: () => void
  onSave: (stableFactKey: string, reason: string) => void
  onRevoke: (stableFactKey: string) => void
  /** 「我已知，稍后处理」（issue #79）：与「保存安排」分开，只表示知道，不表示刻意为之。 */
  onAcknowledge: (stableFactKey: string) => void
  onUnacknowledge: (stableFactKey: string) => void
}

/**
 * 写作弹层里的一致性预检（issue #79）。
 *
 * 三个出口各自的语义，作者此前只有前两个可用：
 *  1. 「保存安排」——**我刻意这么写的**（进 `consistency_exemptions`，会列进「已保存安排」）；
 *  2. 「我已知，稍后处理」——**知道是真问题、回头再改**（进 `consistency_acknowledgements`）。
 *     这是本轮新增的第三个口径：没有它时，作者面对历史旧账要么每章点一次
 *     「带提醒继续写」，要么把缺点记成好事。
 *  3. 「带提醒继续写」——本次不处理，也不落任何状态（仍然是一次性的）。
 */
export default function WritePreflight({
  preflight, busy, onIgnoreOnce, onRerun, onSave, onRevoke, onAcknowledge, onUnacknowledge,
}: WritePreflightProps) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const { findings } = preflight
  const saved = preflight.exemptions.filter(exemption => !exemption.revoked)
  const acknowledged = preflight.acknowledgements

  return (
    <section className="stage-preflight" aria-label={text('一致性预检', 'Consistency preflight')}>
      {findings.length > 0 && (
        <p className="stage-preflight-head">
          <ShieldAlert size={14} aria-hidden />
          {text(`一致性预检 · ${findings.length} 条线索提醒`, `Consistency preflight · ${findings.length} continuity ${findings.length === 1 ? 'finding' : 'findings'}`)}
        </p>
      )}
      {findings.length > 0 && (
        <p className="stage-preflight-note">{text('这些是证据提示，不会阻止创作，也不会自动改写内容。', 'These are evidence prompts. They never block writing or edit content automatically.')}</p>
      )}
      {findings.map(finding => {
        const reason = reasons[finding.stableFactKey] ?? ''
        return (
          <div key={finding.stableFactKey} className="stage-preflight-item">
            <p>{locale === 'en-US' ? finding.issue.enUS : finding.issue.zhCN}</p>
            <p className="stage-preflight-source">{text(`来源：第${finding.sourceChapter}章 · ${finding.evidence}`, `Source: Chapter ${finding.sourceChapter} · ${finding.evidence}`)}</p>
            <p>{locale === 'en-US' ? finding.suggestion.enUS : finding.suggestion.zhCN}</p>
            <div className="stage-preflight-save">
              <input
                className="pi-input"
                aria-label={text('安排说明', 'Why this is intentional')}
                value={reason}
                placeholder={text('说明为何属于刻意安排', 'Explain why this is intentional')}
                onChange={event => setReasons(current => ({ ...current, [finding.stableFactKey]: event.target.value }))}
              />
              <Button variant="secondary" size="sm" disabled={busy || !reason.trim()} onClick={() => onSave(finding.stableFactKey, reason)}>
                {text('保存安排', 'Save arrangement')}
              </Button>
              <Button variant="text" size="sm" disabled={busy} onClick={() => onAcknowledge(finding.stableFactKey)}>
                {text('我已知，稍后处理', 'Noted — deal with it later')}
              </Button>
            </div>
          </div>
        )
      })}
      {findings.length > 0 && (
        <div className="stage-preflight-actions">
          <Button variant="text" size="sm" disabled={busy} onClick={onIgnoreOnce}>{text('带提醒继续写', 'Continue with reminders')}</Button>
          <Button variant="text" size="sm" disabled={busy} onClick={onRerun}>{text('改蓝图后重检', 'Recheck after editing')}</Button>
        </div>
      )}
      {saved.length > 0 && (
        <details className="stage-preflight-saved">
          <summary>{text(`已保存安排（${saved.length}）`, `Saved arrangements (${saved.length})`)}</summary>
          {saved.map(exemption => (
            <div key={exemption.stableFactKey} className="stage-preflight-exemption">
              <span>{exemption.reason}</span>
              <Button variant="text" size="sm" disabled={busy} onClick={() => onRevoke(exemption.stableFactKey)}>
                <RotateCcw size={13} aria-hidden />{text('撤销', 'Revoke')}
              </Button>
            </div>
          ))}
        </details>
      )}
      {/* 这些与「已保存安排」分开展示：它们是「已知未改」，不是「刻意为之」（issue #79）。 */}
      {acknowledged.length > 0 && (
        <details className="stage-preflight-saved">
          <summary>{text(`已标记稍后处理（${acknowledged.length}）`, `Noted for later (${acknowledged.length})`)}</summary>
          {acknowledged.map(item => (
            <div key={item.stableFactKey} className="stage-preflight-exemption">
              <span>{item.stableFactKey}</span>
              <Button variant="text" size="sm" disabled={busy} onClick={() => onUnacknowledge(item.stableFactKey)}>
                <RotateCcw size={13} aria-hidden />{text('恢复提醒', 'Show again')}
              </Button>
            </div>
          ))}
        </details>
      )}
    </section>
  )
}
