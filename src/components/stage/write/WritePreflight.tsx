import { useEffect, useState } from 'react'
import { Loader2, RotateCcw, ShieldAlert } from 'lucide-react'
import type { ConsistencyPreflightResult } from '../../../services/consistency-preflight'
import type { ConsistencyFinding } from '../../../shared/consistency-preflight'
import { useLocaleStore } from '../../../stores/locale-store'
import { preflightRouteOf, type PreflightRoute } from '../../../shared/preflight-route'
import { CONFIRMED_NO_ISSUE_REASON } from '../../../shared/consistency-preflight'
import PreflightRepairPanel, { type RepairProposal } from './PreflightRepairPanel'
import { stripEmphasis } from '../../../shared/author-visible-text'
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
  /** 「确认无误，不再提醒」（issue #228）：一键认可「这条是误报/不成立」，与「刻意为之」分开。 */
  onConfirmNoIssue: (stableFactKey: string) => void
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
  /**
   * 「修复」（issue #137）：请模型按这条提醒把该层字段改出来，改完先看差异。
   *
   * ⚠️ **可选**：只有具备字段级写通道的层才传得动（蓝图层/世界观层）。
   * 不传时该按钮不渲染——宁可少一个按钮，也不要给一个点了没反应的。
   */
  onRepair?: (findings: readonly ConsistencyFinding[]) => void
  /** 「全部修复」：把当前能修的所有提醒按层分组，每层一次调用。 */
  onRepairAll?: () => void
  /**
   * 「核对角色外观」（issue #153）：请模型判正文有没有与角色卡相悖的描写。
   * 不传时不渲染——那个调用只该由作者主动触发（一次模型调用，不该在预检里自动跑）。
   */
  onCheckAppearance?: () => void | Promise<void>
  /** 「核对感官通道」（issue #151 的规则修正）：同样请模型判，不传时不渲染。 */
  onCheckSensory?: () => void | Promise<void>
  /** 「核对文风」「核对跨章重复与状态」（用户 2026-11-05：内容判断交模型）。不传时不渲染。 */
  onCheckStyle?: () => void | Promise<void>
  onCheckContent?: () => void | Promise<void>
  /** 「核对能力限制」（#100）。不传时不渲染。 */
  onCheckAbility?: () => void | Promise<void>
  /** 「核对记忆回指」（#167）。不传时不渲染。 */
  onCheckMemory?: () => void | Promise<void>
  /**
   * 「核对蓝图与前文」（issue #157）：请模型判「蓝图是否把某件事说成一向如此，
   * 而前文已明写它没发生」。不传时不渲染——同样只该由作者主动触发。
   */
  onCheckBlueprintFacts?: () => void | Promise<void>
  /**
   * 「核对物证形态」（issue #156）：请模型判「被当作证据的物件在不同章里形态是否一致、
   * 它的形态与成因能不能同时成立」。不传时不渲染。
   */
  onCheckEvidence?: () => void | Promise<void>
  /**
   * 「核对笔迹特征」（issue #97 / #163）：请模型判「同一个书写者有没有被写成两套互斥的笔迹特征」。
   * 原先靠四张书写质量词表判，按用户定规改由模型判。不传时不渲染。
   */
  onCheckHandwriting?: () => void | Promise<void>
  /**
   * 「核对蓝图自洽」（issue #172）：请模型判「同一章蓝图内部对同一件事给了两套不能同时成立的值」。
   * 现场是第 79 章 notes 里既写「收完压一道」又写「结要压三道」，而正文照抄两处。
   * 不传时不渲染。
   */
  onCheckBlueprintInternal?: () => void | Promise<void>
  /**
   * 「核对代价重述」（issue #75 / #163）：请模型判「同一笔被丢掉的记忆有没有在后面又被当成新损失宣告一遍」。
   * 原先靠五张题材措辞表判，按用户定规改由模型判。不传时不渲染。
   */
  onCheckLossRestatement?: () => void | Promise<void>
  /**
   * 「核对期限结算」（issue #101 / #163）：请模型判「宣告的期限在下一章有没有结算或明确延续」。
   * 原先靠四张题材措辞表判，按用户定规改由模型判。不传时不渲染。
   */
  onCheckDeadline?: () => void | Promise<void>
  /**
   * 「去那一章出新版本」（issue #137 剩余那一半的**可做部分**）。
   *
   * 现场：一条提醒落在**已定稿的章**上时，卡片只写一句
   * 「先给那一章出新版本再重新定稿」——**没有任何按钮**。作者读完这句，
   * 只能自己记住章号、退出弹层、翻到那一章、找版本入口、出新版、再定稿。
   * 这正是 issue 说的「13 条提醒要手工跨 5 个页面改 13 次」里最贵的一种
   * （其它层至少有「去 X 改」按钮，这一档连按钮都没有）。
   *
   * 接上这个出口后，卡片多一颗「去第 N 章出新版本」，一键把作者送到那一章——
   * **只导航，不替他决定要不要修**（与「去修复定稿后处理」同一处置，issue #55）。
   *
   * ⚠️ **可选**：批量写作对话框（一次写多章）不传它。
   */
  onOpenFinalizedChapter?: (chapterNumber: number) => void
  /**
   * 「核对日期一致」（issue #216）：请模型判「同一件事的日期在不同章里是否一致」。
   * 现场是父亲沉船那夜在第 3–14 章写「七月十七」、第 95 章变成「九月十七」，错值还进了账本。
   * 不传时不渲染。
   */
  onCheckDateConflict?: () => void | Promise<void>

  /**
   * 「为「X」建卡」（issue #160）：提醒**自带**可执行动作时给这个出口。
   *
   * 现场：文案写着「就在角色名单里为「徐汐」建卡」，弹层里 `建卡` 两个字一次都点不到，
   * 那条提醒于是从第 64 章一路重报到第 70 章。这里把动作接上——一键按名建一张空卡并落库。
   *
   * ⚠️ **可选**：批量写作对话框（一次写多章）不传它——那里作者还没进到那一章的上下文。
   */
  onCreateCharacter?: (name: string) => void
  /** 模型给出的改写建议（差异面板）。null 表示当前没有待确认的改写。 */
  repairProposal?: RepairProposal | null
  onApplyRepairField?: (field: string) => void
  onApplyRepairAll?: () => void
  onDismissRepair?: () => void
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
  preflight, busy, onIgnoreOnce, onRerun, onSave, onConfirmNoIssue, onRevoke, onAcknowledge, onUnacknowledge, onOpenLayer, currentChapter,
  onRepair, onRepairAll, repairProposal, onApplyRepairField, onApplyRepairAll, onDismissRepair, onCheckAppearance, onCheckSensory, onCheckStyle, onCheckContent, onCheckAbility, onCheckMemory, onCheckBlueprintFacts, onCheckEvidence, onCheckHandwriting, onCheckBlueprintInternal, onCheckLossRestatement, onCheckDeadline, onCheckDateConflict, onCreateCharacter, onOpenFinalizedChapter,
}: WritePreflightProps) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const [reasons, setReasons] = useState<Record<string, string>>({})
  /**
   * 正在跑的那颗「核对…」（issue #192）。
   *
   * 现场：点下去 60–97 秒界面一字不变，唯一的信号是按钮变灰——而灰掉在语义上
   * 同时也是「这个按钮不可用」，作者无法区分「正在跑」和「坏了」。
   * 这里记住**哪一颗**在跑，好在弹层里写一行「正在核对物证形态… 已等 37 秒」。
   */
  const [runningCheck, setRunningCheck] = useState<{ id: string, label: string, startedAt: number } | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  useEffect(() => {
    if (runningCheck === null) return
    // 每秒刷新一次已等秒数：这是 60 秒级的等待，秒数在走本身就证明「还活着」。
    setElapsedSeconds(Math.floor((Date.now() - runningCheck.startedAt) / 1000))
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - runningCheck.startedAt) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [runningCheck])

  /**
   * 点「核对…」：先立进行中态，再发起调用，**等它真的返回**才撤掉。
   *
   * ⚠️ 不能用 `busy` 判断结束（issue #192）：`checkSensory` 这类调用要先读快照、
   * 再 setBusy(true)，中间有一段时间 busy 还是 false——按 busy 清状态会把刚点亮的那一行
   * 立刻抹掉。所以这里 await 调用本身。
   */
  const startCheck = async (id: string, label: string, run: (() => void | Promise<void>) | undefined) => {
    if (run === undefined || busy) return
    setRunningCheck({ id, label, startedAt: Date.now() })
    setElapsedSeconds(0)
    try {
      await run()
    } finally {
      setRunningCheck(null)
    }
  }
  const checkButton = (
    id: string,
    zh: string,
    en: string,
    run: (() => void | Promise<void>) | undefined,
  ) => run === undefined ? null : (
    <Button
      variant="text"
      size="sm"
      disabled={busy}
      aria-busy={runningCheck?.id === id ? true : undefined}
      onClick={() => void startCheck(id, locale === 'en-US' ? en : zh, run)}
    >
      {runningCheck?.id === id ? <Loader2 size={12} className="stage-preflight-spin" aria-hidden /> : null}
      {text(zh, en)}
    </Button>
  )
  const { findings } = preflight
  const saved = preflight.exemptions.filter(exemption => !exemption.revoked)
  const acknowledged = preflight.acknowledgements

  return (
    <section className="stage-preflight" aria-label={text('一致性预检', 'Consistency preflight')} aria-busy={runningCheck !== null || undefined}>
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
            {/*
              issue #154：判据文案里的 Markdown 粗体在界面是**纯文本渲染**，
              不剥就是满屏 `**`（实测 57%~81% 的提醒带它）。剥离只在作者可见的出口做，
              原字符串仍保留粗体给「发给模型的修复提示」与「起草约束」用。
            */}
            <p>{stripEmphasis(locale === 'en-US' ? finding.issue.enUS : finding.issue.zhCN)}</p>
            <p className="stage-preflight-source">{stripEmphasis(text(`来源：第${finding.sourceChapter}章 · ${finding.evidence}`, `Source: Chapter ${finding.sourceChapter} · ${finding.evidence}`))}</p>
            <p>{stripEmphasis(locale === 'en-US' ? finding.suggestion.enUS : finding.suggestion.zhCN)}</p>
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
              {/*
                issue #228：第三个出口——「我看过了，这条是对的/误报，不需要处理」。
                一键（不填原因；固定文案「确认无误」落 consistency_exemptions 的 reason），
                与「保存安排（我刻意这么写的）」「我已知（真问题回头改）」语义分开。
                假阳性的处理成本不该由作者每次重复支付。
              */}
              <Button variant="text" size="sm" disabled={busy} onClick={() => onConfirmNoIssue(finding.stableFactKey)}>
                {text('确认无误，不再提醒', 'Confirmed fine — stop reminding')}
              </Button>
              <Button variant="text" size="sm" disabled={busy} onClick={() => onAcknowledge(finding.stableFactKey)}>
                {text('我已知，稍后处理', 'Noted — deal with it later')}
              </Button>
              {/*
                issue #160：提醒**自带**动作时优先给这个出口。
                「为「徐汐」建卡」排在「我已知」之后但在「去角色名单改」之前——它是一条
                **真能一键做完**的事，而「去角色名单改」只是把人送过去还得手打。
                判据没有动作（绝大多数提醒）时这一段不渲染，作者的出口不变。
              */}
              {finding.action?.kind === 'create-character' && onCreateCharacter !== undefined ? (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  onClick={() => onCreateCharacter(finding.action!.name)}
                >
                  {text(`为「${finding.action.name}」建卡`, `Create a card for ${finding.action.name}`)}
                </Button>
              ) : null}
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
                  {route.blockedBy === 'needs-finalized-prose' && route.targetChapter !== undefined
                      && onOpenFinalizedChapter !== undefined
                    ? (
                      /*
                       * issue #137：这一档原来**只有一句说明、没有按钮** ——
                       * 而它说的动作（出新版本 → 重新定稿）在别的页面里是现成的。
                       * 这里补一个出口，让作者一键到那一章去办（只导航，不替他决定）。
                       */
                      <Button variant="secondary" size="sm" disabled={busy}
                        onClick={() => onOpenFinalizedChapter(route.targetChapter!)}>
                        {text(`去第 ${route.targetChapter} 章出新版本`, `Make a new version of Chapter ${route.targetChapter}`)}
                      </Button>
                    )
                    : route.blockedBy === 'needs-finalized-prose'
                    ? text(
                      // 点名**是哪一章**（issue #212）：一刀切的文案会让作者以为要重开「来源章」，
                      // 而区间型提醒（第 42–55 章连着没跨日）压根不是重开一章能解决的。
                      route.targetChapter === undefined
                        ? '这条落在已定稿的章上：要改得先把那一章出新版本再重新定稿'
                        : `这条要改的是第 ${route.targetChapter} 章（已定稿）：先给那一章出新版本再重新定稿。整段多章的形态问题（如「第 A–B 章连着没跨日」）无法靠改《本章蓝图》解决。`,
                      route.targetChapter === undefined
                        ? 'This sits in a finalized chapter; fixing it needs a new version of that chapter, re-finalized'
                        : `This needs chapter ${route.targetChapter} (already finalized): make a new version of that chapter and re-finalize. Multi-chapter shapes (e.g. "chapters A–B never state a day change") cannot be fixed by editing this chapter's blueprint.`)
                    : text('这条暂时没有可改的层', 'No editable layer for this one yet')}
                </span>
              )}
              {/*
                「修复」：请模型按这条提醒把**该层的字段**改出来，改完先给差异（issue #137）。
                ⚠️ 只对**能字段级改写**的层给按钮：角色层要走角色名单的 CAS 提交、
                正文层只能新版本重定稿——那些层的出口是「去 X 改」。
              */}
              {onRepair === undefined || !route.repairable ? null : (route.layer === 'blueprint' || route.layer === 'world') ? (
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => onRepair([finding])}>
                  {text('修复', 'Fix it')}
                </Button>
              ) : null}
            </div>
          </div>
        )
      })}
      {repairProposal ? (
        <PreflightRepairPanel
          proposal={repairProposal}
          busy={busy}
          onApplyOne={field => onApplyRepairField?.(field)}
          onApplyAll={() => onApplyRepairAll?.()}
          onDismiss={() => onDismissRepair?.()}
        />
      ) : null}
      {findings.length > 0 && (
        <>
        {/* issue #165：四个「核对…」是一次耗时模型调用（实测 61 秒），与
            「全部修复／带提醒继续写」这种即时动作不同类。原先挤在同一行，
            七个按钮合计 658px 而容器只有 288px，justify-content:flex-end
            把左侧那四个甩出弹层（stage-shell 又是 overflow:hidden，滚不过去）
            ——作者一个都点不到。现在拆成两行。 */}
        {/*
          issue #194 建议 ②：**物证链断裂自动预检查不出来，要说出来**。
          那一族（某件东西被交出/归档之后又在别处出现、或在同一章里换了持有者）
          由模型判据覆盖 —— 而模型调用**只由作者点按钮触发**（本仓既定规则：
          预检不自动跑模型，见本文件各 `onCheck*` 的注释）。所以这里给一句可见提示，
          让作者知道「这一档要点一下才会查」，而不是以为自动预检已经查过了。
        */}
        <p className="stage-preflight-checks-note">
          {text('下面这些要用模型逐章读一遍（每次一次调用，约 60–100 秒），不会自动跑。其中「跨章重复与状态」「物证形态」两档覆盖物证链：某件东西被交出、归档之后又在别处出现，或在同一章里换了持有者而没写交接——自动预检查不出这一类。',
            'These run a model pass over the chapters (one call each, roughly 60–100s) and never run on their own. “Repeated moves & status” and “Evidence objects” are the two that cover the prop chain: something handed in or filed away turning up again elsewhere, or changing hands within one chapter with no handover — the automatic pass cannot see those.')}
        </p>
        <div className="stage-preflight-checks">
          {checkButton('onCheckMemory', '核对记忆回指', 'Check remembered scenes', onCheckMemory)}
          {checkButton('onCheckAbility', '核对能力限制', 'Check ability limits', onCheckAbility)}
          {checkButton('onCheckStyle', '核对文风', 'Check prose style', onCheckStyle)}
          {checkButton('onCheckContent', '核对跨章重复与状态', 'Check repeated moves & status', onCheckContent)}
          {checkButton('onCheckSensory', '核对感官通道', 'Check sensory coverage', onCheckSensory)}
          {checkButton('onCheckAppearance', '核对角色外观', 'Check appearance vs cards', onCheckAppearance)}
          {checkButton('onCheckBlueprintFacts', '核对蓝图与前文', 'Check blueprint vs prose', onCheckBlueprintFacts)}
          {checkButton('onCheckEvidence', '核对物证形态', 'Check evidence objects', onCheckEvidence)}
          {checkButton('onCheckHandwriting', '核对笔迹特征', 'Check handwriting traits', onCheckHandwriting)}
          {checkButton('onCheckBlueprintInternal', '核对蓝图自洽', 'Check plan consistency', onCheckBlueprintInternal)}
          {checkButton('onCheckLossRestatement', '核对代价重述', 'Check re-charged costs', onCheckLossRestatement)}
          {checkButton('onCheckDeadline', '核对期限结算', 'Check deadline settlement', onCheckDeadline)}
          {checkButton('onCheckDateConflict', '核对日期一致', 'Check date consistency', onCheckDateConflict)}
        </div>
        {/*
          issue #192：这一行是**唯一的**进行中信号。原来 60–97 秒里弹层逐字不变，
          作者只能从「按钮变灰」推断状态——而灰掉同时意味着「不可用」，两者无法区分。
          秒数每秒在走，本身就是在证明「还活着」；把它做成 `aria-live="polite"`，
          屏幕阅读器用户在同样的 97 秒里也能拿到状态。
        */}
        {runningCheck === null ? null : (
          <p className="stage-preflight-running" role="status" aria-live="polite">
            <Loader2 size={13} className="stage-preflight-spin" aria-hidden />
            {text(
              `正在${runningCheck.label}… 已等 ${elapsedSeconds} 秒`,
              `Running ${runningCheck.label}… ${elapsedSeconds}s elapsed`,
            )}
          </p>
        )}
        <div className="stage-preflight-actions">
          {onRepairAll === undefined ? null : (
            <Button variant="secondary" size="sm" disabled={busy} onClick={onRepairAll}>
              {text('全部修复', 'Fix all')}
            </Button>
          )}
          <Button variant="text" size="sm" disabled={busy} onClick={onIgnoreOnce}>{text('带提醒继续写', 'Continue with reminders')}</Button>
          <Button variant="text" size="sm" disabled={busy} onClick={onRerun}>{text('改蓝图后重检', 'Recheck after editing')}</Button>
        </div>
        </>
      )}
      {(() => {
        // issue #228：「确认无误」类与「刻意为之」分开显示——误报的确认不该淹没
        // 真正刻意安排的台账，作者找「故意保留的设定」时不该翻一排「确认无误」。
        const confirmedFine = saved.filter(exemption => exemption.reason === CONFIRMED_NO_ISSUE_REASON)
        const intentional = saved.filter(exemption => exemption.reason !== CONFIRMED_NO_ISSUE_REASON)
        return (
          <>
            {intentional.length > 0 && (
              <details className="stage-preflight-saved">
                <summary>{text(`已保存安排（${intentional.length}）`, `Saved arrangements (${intentional.length})`)}</summary>
                {intentional.map(exemption => (
                  <div key={exemption.stableFactKey} className="stage-preflight-exemption">
                    <span title={exemption.stableFactKey}>{exemption.reason}</span>
                    <Button variant="text" size="sm" disabled={busy} onClick={() => onRevoke(exemption.stableFactKey)}>
                      <RotateCcw size={13} aria-hidden />{text('撤销', 'Revoke')}
                    </Button>
                  </div>
                ))}
              </details>
            )}
            {confirmedFine.length > 0 && (
              <details className="stage-preflight-saved">
                <summary>{text(`已确认无误（${confirmedFine.length}）`, `Confirmed fine (${confirmedFine.length})`)}</summary>
                {confirmedFine.map(exemption => (
                  <div key={exemption.stableFactKey} className="stage-preflight-exemption">
                    <span title={exemption.stableFactKey}>{text('我看过了，这条不成立', 'Reviewed — not an issue')}</span>
                    <Button variant="text" size="sm" disabled={busy} onClick={() => onRevoke(exemption.stableFactKey)}>
                      <RotateCcw size={13} aria-hidden />{text('恢复提醒', 'Show again')}
                    </Button>
                  </div>
                ))}
              </details>
            )}
          </>
        )
      })()}
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
