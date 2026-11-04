import { useState } from 'react'
import { RotateCcw, ShieldAlert } from 'lucide-react'
import type { ConsistencyPreflightResult } from '../../../services/consistency-preflight'
import { useLocaleStore } from '../../../stores/locale-store'
import { preflightRouteOf, type PreflightRoute } from '../../../shared/preflight-route'
import { Button } from '../../ui/Button'

/** 各层的中文/英文说法（面向作者；层名本身是内部概念）。 */
function layerText(locale: 'zh-CN' | 'en-US', route: PreflightRoute): string {
  const zh = route.layer === 'world' ? '世界观/设定'
    : route.layer === 'cast' ? '角色名单'
      : route.layer === 'outline' ? '细纲/粗纲'
        : route.layer === 'blueprint' ? '本章蓝图' : '已定稿正文'
  const en = route.layer === 'world' ? 'worldbuilding'
    : route.layer === 'cast' ? 'cast list'
      : route.layer === 'outline' ? 'outline'
        : route.layer === 'blueprint' ? 'this chapter’s blueprint' : 'finalized prose'
  return locale === 'en-US' ? en : zh
}

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
  /**
   * 「去这一层改」（issue #137）：把作者送到该提醒所属的那一层。
   *
   * 这条出口解决的是「作者自己判断每条该去哪一层」——13 条提醒原来要跨 5 个页面
   * 手工找 13 次。生成补丁与差异确认是它的下游（分批做）。
   *
   * ⚠️ **可选**：批量写作对话框（一次写多章）不传它——那里的提醒可能属于任意一章，
   * 「去哪一层」回答不了「哪一章」，给按钮反而误导。不传时该出口整段不渲染。
   */
  onOpenLayer?: (route: PreflightRoute) => void
  /**
   * 即将写的那一章（issue #137 第二维）：给了它，「可修」才按「问题章 ≥ 它」判。
   *
   * 不给时只看层——批量写作对话框（一次写多章）没有单一的「当前章」，
   * 那里给章号会把属于别章的提醒误标。
   */
  currentChapter?: number
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
  preflight, busy, onIgnoreOnce, onRerun, onSave, onRevoke, onAcknowledge, onUnacknowledge, onOpenLayer, currentChapter,
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
        // ⚠️ 两个维度都要传（issue #137）：只看层会把**旧章**的提醒标成可修，
        // 而旧章只能「新版本 + 重新定稿」，写前这一刻改不动。
        const route = preflightRouteOf(finding.stableFactKey, {
          ...(currentChapter === undefined ? {} : { currentChapter }),
          sourceChapter: finding.sourceChapter,
        })
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
              {/*
                issue #137：这条提醒该去哪一层改。
                ⚠️ 只有写前那一刻真能改的才给按钮：读已定稿正文的判据（`prose:*`）此刻
                改不了（本章正文还不存在），标注原因而不是给一个点了没反应的按钮。
              */}
              {onOpenLayer === undefined ? null : route.repairable ? (
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => onOpenLayer(route)}>
                  {text(`去${layerText(locale, route)}改`, `Open ${layerText(locale, route)}`)}
                </Button>
              ) : (
                <span className="stage-preflight-not-here">
                  {route.blockedBy === 'needs-finalized-prose'
                    ? text('这条落在已定稿的章上，要改正文就得新版本重定稿（本轮先放着）', 'This sits in a finalized chapter; fixing it means a new version and re-finalizing (later)')
                    : text('这条暂时没有可改的层', 'No editable layer for this one yet')}
                </span>
              )}
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
              {/*
               * issue #120：这里原来渲染的是 `item.stableFactKey`（`prop:revival:内襟` 这种内部键），
               * 作者挂起 16 条提醒后回看时认不出任何一条。改渲染 `title`（服务层用「当轮仍命中的
               * finding 原文」或封闭目录译出的人话补上）；键降级为 title 属性的悬浮说明，
               * 保留可定位性（支持排查用），但**不再直接显示**给作者。
               */}
              <span title={item.stableFactKey}>{item.title ? (locale === 'en-US' ? item.title.enUS : item.title.zhCN) : item.stableFactKey}</span>
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
