import { useEffect, useId, useRef, useState } from 'react'
import { ChevronRight, PenLine } from 'lucide-react'
import type { ConsistencyPreflightResult } from '../../../services/consistency-preflight'
import { readConsistencyPreflight } from '../../../services/consistency-preflight'
import { pluralEn } from '../../../shared/plural-en'
import { createCharacterCardForPreflight } from '../../../services/preflight-character-card'
import { CONTENT_AXES_FOR_BUTTON } from '../../../shared/content-review'
import { mergeModelFindings } from '../../../shared/merge-model-findings'
import { MEMORY_ANCHOR_TARGET_CHAPTERS } from '../../../shared/memory-anchor-review'
import { CONFIRMED_NO_ISSUE_REASON, type ConsistencyFinding } from '../../../shared/consistency-preflight'
import { ipc } from '../../../services/ipc-client'
import {
  chapterDefaultWordsTarget,
  chapterWriteFormFromPrefill,
  generationModelError,
  isGenerationModel,
  launchChapterWrite,
} from '../../../services/workflows/chapter-write-launch'
import { preferredFunctionModelId } from '../../../shared/function-models'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import type { ChapterWritePrefill } from '../../../stores/layout-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useStageStore } from '../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../stores/project-store'
import { useWorkflowStore, workflowResourceKey } from '../../../stores/workflow-store'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'
import { navigate } from '../../../stores/navigation/navigation-intents'
import { useAnchoredLayer } from '../../ui/use-anchored-layer'
import {
  appearanceContradictionFindings, appearanceUnusedMarkFindings, applyRepairDiffs, checkAppearanceAgainstCards,
  proposeLayerRepair, reviewAbilityLimits, reviewBlueprintAgainstProse, reviewBlueprintInternals, reviewEvidenceShapes, reviewDateConflicts, reviewDeadlines, reviewHandwritingTraits, reviewLossRestatements, reviewMemoryAnchors, reviewProseContent, reviewProseStyle,
  reviewSensoryChannels, sensoryVerdictFindings,
} from '../../../services/preflight-repair'
import { advanceRepairQueue, planRepairCalls, remainingRepairLayers, shouldContinueRepairChain } from '../../../shared/preflight-repair'
import { preflightRouteOf } from '../../../shared/preflight-route'
import { Button } from '../../ui/Button'
import SplitAction from './SplitAction'
import WritePreflight from './WritePreflight'
import type { RepairProposal } from './PreflightRepairPanel'

interface WriteChapterPopoverProps {
  chapterNumber: number
  /** 这一章的蓝图，按旧蓝图页「写作此章」的同一组字段（出场人物以顿号连接）。 */
  blueprint: ChapterWritePrefill
  /** 主按钮文字：蓝图页是「写第 N 章」，单章视图是「写作此章」。 */
  label: string
  /** 弹层与按钮哪边对齐：蓝图页按钮在右侧，弹层向左展开（end）；单章视图按钮在左侧，向右展开（start）。 */
  align?: 'start' | 'end'
}

/**
 * 写作此章：拆分主按钮加一个小弹层。主按钮直接按蓝图开始写；箭头打开弹层，只能改本次模型、作者微操指导和收在「更多」里的检索关键词。
 * 其余参数都取自蓝图，经 launchChapterWrite 启动。一致性预检有提醒、或前置条件不满足时，弹层自己打开说明原因。
 */
export default function WriteChapterPopover({ chapterNumber, blueprint, label, align = 'end' }: WriteChapterPopoverProps) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const models = useLLMStore(s => s.models)
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  const functionModels = useLLMStore(s => s.functionModels)
  const writeRequest = useStageStore(s => s.writeRequest)
  const layer = useAnchoredLayer(align)
  const { open, show, close } = layer
  const [modelId, setModelId] = useState<string | null>(null)
  const [guidance, setGuidance] = useState<string | null>(null)
  const [knowledgeHint, setKnowledgeHint] = useState('')
  const [preflight, setPreflight] = useState<ConsistencyPreflightResult | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  // 守卫阻断时要修的是哪一章（issue #55）：主按钮据此变成「去修复定稿」，
  // 否则弹层里一个按钮都没有，作者只能照脚注反复点同一个必然被拒绝的按钮。
  const [repairChapter, setRepairChapter] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  // 「修复」生成出来的字段改写建议（issue #137）：**作者确认差异后**才落库。
  const [repairProposal, setRepairProposal] = useState<RepairProposal | null>(null)
  const [repairSource, setRepairSource] = useState<{ layer: 'world' | 'cast' | 'outline' | 'blueprint' | 'prose'; chapterNumber: number | null } | null>(null)
  // 「全部修复」的跨层排队（issue #137）：一层一次确认，采纳后自动提出下一层。
  const [repairQueue, setRepairQueue] = useState<Array<{ layer: 'world' | 'cast' | 'outline' | 'blueprint' | 'prose'; findings: readonly ConsistencyFinding[] }>>([])
  /**
  * issue #241 ①：本轮**已采纳过修复**的提醒键（内存，弹层关掉清）。
  * 采纳后 start(false) 重检若该键仍在（判据命中的依据在被改字段之外，或模型 diff
  * 与判据抽取的名词片段未对齐），列表要**标注**而不是装没看见——否则作者看到
  * 「我采纳了、它还报、还能再点修复」，修复闭环的信任一次就没了。
  */
  const [appliedRepairKeys, setAppliedRepairKeys] = useState<Set<string>>(new Set())
  /** 本轮修复的目标键（提案生成时暂存；采纳后进 appliedRepairKeys）。 */
  const [repairTargetKeys, setRepairTargetKeys] = useState<Set<string>>(new Set())
  /**
  * issue #241 ②：修复按钮的 busy 计时——「正在按提醒生成修复… 已等 N 秒」。
  * 复用 startingSeconds 的 interval 模式（#210 修法）；模型 30–120s，
  * 没有它作者唯一能感知的是「所有按钮都灰了」。
  */
  const [repairSeconds, setRepairSeconds] = useState<number | null>(null)
  useEffect(() => {
    if (repairSeconds === null) return
    const timer = setInterval(() => setRepairSeconds(current => (current ?? 0) + 1), 1000)
    return () => clearInterval(timer)
  }, [repairSeconds !== null])

  const [starting, setStarting] = useState(false)
  /**
   * 本章已有未定稿草稿的簿记提示（issue #224）。
   *
   * 现场：同一章三轮「写第 N 章」各开一条全新管线（短纲 17889 tok×3 输入完全相同、
   * 产出 2832/9077/13948 漂移），弹层一个字没提「本章已有 2 版草稿」——作者不知道
   * 自己在重复花钱。打开弹层时读一次 draft-list，把版本数、字数、状态摆出来。
   */
  const [existingDrafts, setExistingDrafts] = useState<Array<{ version: number; status: string; wordCount: number }> | null>(null)
  /**
   * 「点下去」到「弹层出现」之间要有一段可读的状态（issue #210）。
   *
   * 现场：点「写第 31 章」后 10 分钟零反馈——没有弹层、没有 chapter-draft 运行、
   * 没有模型调用、界面一个字都没变。作者无从判断是坏了还是在等。
   * （根因可能是预检算得久，也可能是点了没生效；两者在用户看来一样，
   * 所以无论哪一种是主因，这一段都必须有反馈。）
   */
  const [startingSeconds, setStartingSeconds] = useState(0)
  useEffect(() => {
    if (!starting) { setStartingSeconds(0); return }
    setStartingSeconds(0)
    const startedAt = Date.now()
    const timer = setInterval(() => setStartingSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [starting])
  /**
   * `mergeFindings` 想给作者的那句「新增 N 条 / N 条已挂起」（issue #170）。
   * 用 ref 暂存、在 setState 之外落地——在 updater 里调另一个 setState 会触发
   * 「在更新期间更新另一个组件/state」的告警。
   */
  const mergeSummaryRef = useRef<string | null>(null)
  const modelFieldId = useId()
  const guidanceFieldId = useId()
  const hintFieldId = useId()

  const generationModels = models.filter(isGenerationModel)
  const selectedModelId = modelId ?? preferredFunctionModelId(models, functionModels, 'draft_generation', defaultModelId)
  const modelError = generationModelError(models, selectedModelId, text)
  const userGuidance = guidance ?? blueprint.userGuidance
  /**
   * 同章活动运行提示（issue #224 ②）：写稿工作流声明 `chapter:N` 写资源键，
   * 同章的旧 run 还在 running 时再点会被 `getResourceConflict` 拒——但那是
   * **点了之后**才报。这里在弹层里先说，作者不用撞一次拒绝才知道。
   * 僵尸 running（进程中断留下的）也在这里可见（issue #224 影响 4）。
   */
  const activeChapterRun = useWorkflowStore(s => s.activeRuns.find(run => run.status === 'running'
    && (run.resourceKeys ?? []).includes(workflowResourceKey('chapter', chapterNumber))))

  useEffect(() => {
    if (writeRequest?.chapterNumber !== chapterNumber) return
    useStageStore.setState({ writeRequest: null })
    show()
  }, [writeRequest, chapterNumber, show])

  // 与旧对话框一样，打开时列出已保存的一致性安排，作者可以在这里撤销。
  useEffect(() => {
    if (!open) return
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session) return
    void ipc.invokeWithProjectSession(session, 'db:consistency-exemption-list', session.projectPath).then(exemptions => {
      if (isProjectSessionCurrent(session) && exemptions.some(item => !item.revoked)) {
        setPreflight(current => current ?? { findings: [], exemptions, acknowledgements: [], castNames: [] })
      }
    }).catch(() => undefined)
    // issue #224：同章已有草稿的簿记信息，打开时读一次（读取失败静默——提示是增强，不是门槛）。
    void ipc.invokeWithProjectSession(session, 'db:draft-list', chapterNumber, session.projectPath).then(drafts => {
      if (!isProjectSessionCurrent(session)) return
      const metas = (Array.isArray(drafts) ? drafts : []) as Array<{ version?: unknown; status?: unknown; wordCount?: unknown }>
      setExistingDrafts(metas
        .filter(item => Number.isSafeInteger(item.version) && typeof item.status === 'string')
        .map(item => ({ version: item.version as number, status: item.status as string, wordCount: typeof item.wordCount === 'number' ? item.wordCount : 0 })))
    }).catch(() => undefined)
  }, [open, chapterNumber])

  /** expected 是发起时的那次打开：保存安排后接着开写时，作品已换就不写，蓝图与章号属于原来那部。 */
  const start = async (ignoreFindingsOnce: boolean, expected?: ProjectSessionContext) => {
    const project = useProjectStore.getState().currentProject
    const session = captureProjectSession(project)
    if (!session || busy || (expected && !isProjectSessionCurrent(expected))) return
    setBusy(true)
    setStarting(true)
    try {
      const wordsPerChapter = project?.novelConfig.wordsPerChapter
      const form = chapterWriteFormFromPrefill({ ...blueprint, userGuidance, chapterNumber }, chapterDefaultWordsTarget(wordsPerChapter))
      const outcome = await launchChapterWrite({
        session,
        form: { ...form, knowledgeHint },
        generationModelId: selectedModelId,
        wordsPerChapter,
        ignoreFindingsOnce,
        locale,
      })
      switch (outcome.kind) {
        case 'stale':
          return
        case 'started':
          // 这些选项只用于本次写作；写完后再打开弹层，回到蓝图里的指导与默认模型。
          setModelId(null)
          setGuidance(null)
          setKnowledgeHint('')
          setPreflight(null)
          setMessage(null)
          setRepairChapter(null)
          close(false)
          return
        case 'preflight':
          setMessage(null)
          setRepairChapter(null)
          setPreflight(outcome.preflight)
          {
            // issue #241 ①：本轮已采纳过修复、且重检后**仍命中的**条目要标注——
            // 作者看到的是「我采纳了、它还报」，不标注就是修复闭环失信。
            const stillReported = [...appliedRepairKeys].filter(key =>
              outcome.preflight.findings.some(finding => finding.stableFactKey === key))
            if (stillReported.length > 0) {
              const involved = stillReported.map(key => key.split(":").slice(0, 2).join(":")).join("；")
              setMessage(text(
                `你刚采纳过的修复，重检后仍有 ${stillReported.length} 条被继续报出——可能判据命中的依据在别的段落/字段。可改用「去 X 改」或「确认无误，不再提醒」。（涉及：${involved}）`,
                `You just applied fixes, but ${stillReported.length} of them were reported again after the recheck — the check may match text outside the fields you changed. Use "Go to X" or "Confirmed fine" instead.`))
            }
          }
          show()
          return
        default: {
          // authority-error 与 blocked 都走这里，但只有 blocked 可能带「该修哪一章」。
          const blocked = outcome.kind === 'blocked' ? outcome : null
          setMessage(outcome.message)
          setRepairChapter(blocked?.action === 'repair-finalize' ? blocked.chapterNumber ?? null : null)
          show()
          return
        }
      }
      } catch (error) {
        // issue #236：launch 链路里任何异常（守卫读库、参数持久化、IPC）原来都逃进
        // unhandled rejection——busy 复位、无弹层、无 message，正是「点了没反应」
        // 的「炸没反应」形态（#210 是「慢没反馈」，#224 是「重复没簿记」）。
        // 与同文件 changeArrangement 同型：异常时弹层必须出现并写明原因——
        // 「点了没反应」这一族的终点是**任何路径都以可见反馈收尾**。
        if (isProjectSessionCurrent(session)) {
          setMessage(error instanceof Error && error.message.trim() ? error.message : text('启动写作失败。', 'Could not start writing.'))
          show()
        }
      } finally {
        setBusy(false)
        setStarting(false)
      }
    }

  /** 保存或撤销一致性安排：进行中按钮不可再点，失败时在弹层里写明原因。成功时返回发起时的会话。 */
  const changeArrangement = async (failure: string, call: (session: ProjectSessionContext) => Promise<{ success: boolean; error?: string }>) => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || busy) return null
    setBusy(true)
    setMessage(null)
    try {
      const result = await call(session)
      if (!result.success) throw new Error(result.error || failure)
      return session
    } catch (error) {
      if (isProjectSessionCurrent(session)) setMessage(error instanceof Error ? error.message : String(error))
      return null
    } finally {
      setBusy(false)
    }
  }

  /** 「修复」：请模型按这批提醒改**该层字段**，拿到差异后交给作者确认（issue #137）。 */
  const requestRepair = async (targets: readonly ConsistencyFinding[]) => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || busy || targets.length === 0) return
    // 只修**写前真能改**的、且有字段级写通道的层。
    const fixable = targets.filter(finding => {
      const route = preflightRouteOf(finding.stableFactKey, { currentChapter: chapterNumber, sourceChapter: finding.sourceChapter })
      return route.repairable && (route.layer === 'blueprint' || route.layer === 'world')
    })
    if (fixable.length === 0) {
      /**
       * 一条都修不了时，**按原因分组说清楚**，不要用一句笼统的话盖住（issue #212 建议 ④）。
       *
       * 现场：46 条提醒点「全部修复」，44 条被标成「落在已定稿的章上」，
       * 而其中一大半其实是「要改的是第 42–55 章那一段」这种多章形态，重开一章也解决不了。
       * 作者从一句「都落在已定稿的章上」里读不出这个区别。
       */
      const reasons = new Map<string, number>()
      for (const finding of targets) {
        const route = preflightRouteOf(finding.stableFactKey, { currentChapter: chapterNumber, sourceChapter: finding.sourceChapter })
        const bucket = route.layer === 'prose' ? text('读的是已定稿正文，要改得先出那一章的新版本', 'they read finalized prose, so that chapter needs a new version first')
          : route.layer === 'cast' ? text('要改的是角色名单（本层没有字段级写通道）', 'they need the roster changed (no field-level channel here)')
            : route.blockedBy === 'unknown-layer' ? text('判据没有登记可改的层', 'the check has no writable layer registered')
              : text('要改的是别的章（不是本章蓝图）', 'they belong to other chapters, not this chapter’s blueprint')
        reasons.set(bucket, (reasons.get(bucket) ?? 0) + 1)
      }
      setMessage(text(
        `这 ${targets.length} 条一条都改不了，原因分三类：${[...reasons].map(([reason, count]) => `${reason} ${count} 条`).join('；')}。`,
        `None of the ${targets.length} ${pluralEn(targets.length, 'finding', 'findings')} can be fixed here: ${[...reasons].map(([reason, count]) => `${reason} (${count})`).join('; ')}.`,
      ))
      return
    }
    const calls = planRepairCalls(fixable.map(finding => ({
      ...finding,
      layer: preflightRouteOf(finding.stableFactKey, { currentChapter: chapterNumber, sourceChapter: finding.sourceChapter }).layer,
    })))
    const call = calls[0]
    if (!call) return
    // 其余层进队列：一层一次确认，不连跑。
    setRepairQueue(calls.slice(1))
    setBusy(true)
    setMessage(null)
    setRepairSeconds(0)
    try {
      const outcome = await proposeLayerRepair(session, call.layer, chapterNumber, call.findings, locale)
      if (!isProjectSessionCurrent(session)) return
      if (outcome.status === 'failed') { setMessage(outcome.error); return }
      if (outcome.status === 'unchanged') {
        setMessage(text('模型认为这几条不需要改这一层的字段。', 'The model found nothing to change in this layer.'))
        return
      }
      setRepairSource({ layer: call.layer, chapterNumber })
      // issue #241 ①：本轮修复目标键——采纳后 start(false) 重检若仍命中，要标注而不是装没看见。
      setRepairTargetKeys(new Set(call.findings.map(finding => finding.stableFactKey)))
      setRepairProposal({
        layerLabel: call.layer === 'world' ? text('世界观/设定', 'worldbuilding') : text('本章蓝图', 'this chapter’s blueprint'),
        chapterNumber,
        diffs: outcome.diffs,
        remainingLayers: calls.length - 1,
      })
      show()
      setRepairSeconds(null)
    } finally {
      setBusy(false)
    }
  }

  /** 共用：取最近已定稿章（各模型判据都用这一份）。 */
  const recentFinalized = async (session: ProjectSessionContext) => {
    const prose = (await ipc.invokeWithProjectSession(session, 'db:draft-export-snapshot', session.projectPath)
      .catch(() => [])) as Array<{ chapterNumber: number, content: string }>
    if (!isProjectSessionCurrent(session)) return []
    return prose
      .filter(row => Number.isSafeInteger(row.chapterNumber) && row.chapterNumber < chapterNumber)
      .map(row => ({ chapterNumber: row.chapterNumber, content: String(row.content ?? '') }))
  }

  /**
   * 把模型判出的问题并入当前提醒列表（作者已有的 ack/保存安排机制照常可用）。
   *
   * issue #170 的三处修正：
   * - **按 `stableFactKey` 合并**：连点两次同一个按钮会产出同章同轴的 key（`prose-flavor:motif:68`
   *   出现两次）→ React 列表拿重复 key、ack 一条会静默掉另一条。合并时把**同 key 的引文并进
   *   `evidence`**（与 `styleIssueFindings` 内部口径一致）。
   * - **合并前滤掉已 ack 的 key**：模型结论走的是渲染层直 push，从来没经过
   *   `readConsistencyPreflight` 里那道 ack 过滤——所以「挂起过的下次核对照样回来」（#86/#89/#98/#108 的老毛病，
   *   这次坏在渲染层）。
   * - **给作者一句可见说明**：条数变化要能看见，否则界面静默回到原样会让人以为「核完了、解决了」。
   */
  const mergeFindings = (found: ConsistencyFinding[]) => {
    if (found.length === 0) {
      setMessage(text('模型没有找到这一类问题（或章数太少，暂不判）。',
        'The model found nothing of this kind (or there are too few chapters to judge).'))
      return
    }
    // 合并/过滤是纯函数（`mergeModelFindings`），这样「同 key 不重复、已挂起不再列」能被断言。
    let summary: string | null = null
    setPreflight(current => {
      if (!current) return current
      const result = mergeModelFindings(current.findings, found, current.acknowledgements)
      // 条数变化要能看见（issue #170 建议 ④）——静默回到原样比报错更糟。
      if (result.added > 0 || result.droppedAcknowledged > 0) {
        summary = text(
          `本次核对新增 ${result.added} 条${result.droppedAcknowledged > 0 ? `；${result.droppedAcknowledged} 条此前已挂起，未再列出` : ''}。`,
          `${result.added} new finding(s)${result.droppedAcknowledged > 0 ? `; ${result.droppedAcknowledged} already set aside earlier and not listed again` : ''}.`)
        mergeSummaryRef.current = summary
      }
      return { ...current, findings: result.findings }
    })
    // 在 setState 之外落地提示：updater 里调另一个 setState 会触发「更新期间更新 state」的告警。
    if (mergeSummaryRef.current) {
      setMessage(mergeSummaryRef.current)
      mergeSummaryRef.current = null
    }
    show()
  }

  /**
   * 记忆回指锚点（#167）——**交给模型判**。
   * 规则取出本章的「记得/想起」句，把前文正文作为检索范围喂进去；
   * 「所指的事在前文有没有发生」是内容判断。
   */
  const checkMemory = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const prose = await recentFinalized(session)
      if (!isProjectSessionCurrent(session)) return
      /**
       * 被检查的章：**不只上一章**（issue #175 建议 ②）。
       *
       * 记忆回指可以指向任意前文，没理由只查 N-1——而原实现只取 N-1，于是「最近几章里
       * 有一章没回指句」时整次核对就是空转。取最近 MEMORY_ANCHOR_TARGET_CHAPTERS 章；
       * 前文检索范围仍是全量（`earlier`，内部有 12 万字符上限）。
       */
      const target = prose
        .filter(chapter => chapter.chapterNumber < chapterNumber
          && chapter.chapterNumber >= chapterNumber - MEMORY_ANCHOR_TARGET_CHAPTERS)
        .sort((left, right) => left.chapterNumber - right.chapterNumber)
      if (target.length === 0) {
        setMessage(text('还没有已定稿的正文可核对。', 'There is no finalized prose to check yet.'))
        return
      }
      const earliest = target[0]!.chapterNumber
      const earlier = prose.filter(chapter => chapter.chapterNumber < earliest)
      const outcome = await reviewMemoryAnchors(session, target, earlier, locale)
      if (!isProjectSessionCurrent(session)) return
      if (outcome.status === 'failed') { setMessage(outcome.error ?? text('核对失败。', 'The check failed.')); return }
      // issue #175：一次模型调用都没发时**明说**，不要伪装成「查过了没毛病」。
      if (outcome.skipped === 'no-callbacks') {
        setMessage(text(
          `这 ${target.length} 章里没有「记得／想起」这类回指句，未发起核对（不是「查过了没问题」）。`,
          `None of ${pluralEn(target.length, 'this chapter', 'these chapters')} contains a remembering sentence, so no check was sent — this is not "checked and clean".`))
        return
      }
      if (outcome.skipped === 'no-earlier-chapters') {
        setMessage(text('这几章之前没有更早的定稿正文，无从对照。', 'There is no earlier finalized prose to check against.'))
        return
      }
      mergeFindings(outcome.findings)
    } catch (error) {
      // issue #203：核对调用的失败要**说出来**。原来这 11 颗按钮只有 try/finally，
      // 异常被 finally 吃掉 → 进度行消失、卡片没变、弹层一个字都没多，
      // 与「点了、模型说没问题」完全无法区分（实测 305 秒 504 那次）。
      // 服务层（preflight-repair 的 askReviewModel）已经把模型异常转成 failed 返回值，
      // 这里兜住剩下的：读库失败、项目已切换、解析意外抛错。
      if (isProjectSessionCurrent(session)) {
        setMessage(error instanceof Error && error.message.trim() ? error.message : text('核对失败。', 'The check failed.'))
      }
    } finally {
      setBusy(false)
    }
  }

  /**
   * 蓝图把某件事写成「一向如此」，而前文已明写它没发生（issue #157）——**交给模型判**。
   *
   * 现场：第 25 章蓝图 `foreshadowing` 写「码头老位置每日一停」，而第 24 章定稿写
   * 「脚底下没慢，也没停」。规则只把蓝图的既有事实字段与前文摆在一起、校验引文可定位。
   */
  const checkBlueprintFacts = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const prose = await recentFinalized(session)
      if (!isProjectSessionCurrent(session)) return
      const earlier = prose.filter(chapter => chapter.chapterNumber < chapterNumber)
      if (earlier.length === 0) {
        setMessage(text('还没有已定稿的正文可供对照。', 'There is no finalized prose to compare against yet.'))
        return
      }
      const outcome = await reviewBlueprintAgainstProse(session, [{
        chapterNumber,
        claims: [blueprint.keyEvents, blueprint.foreshadowing ?? '', blueprint.costsAndTurns ?? '']
          .filter(Boolean).join('\n'),
      }], earlier, locale)
      if (!isProjectSessionCurrent(session)) return
      if (outcome.status === 'failed') { setMessage(outcome.error ?? text('核对失败。', 'The check failed.')); return }
      mergeFindings(outcome.findings)
    } catch (error) {
      // issue #203：核对调用的失败要**说出来**。原来这 11 颗按钮只有 try/finally，
      // 异常被 finally 吃掉 → 进度行消失、卡片没变、弹层一个字都没多，
      // 与「点了、模型说没问题」完全无法区分（实测 305 秒 504 那次）。
      // 服务层（preflight-repair 的 askReviewModel）已经把模型异常转成 failed 返回值，
      // 这里兜住剩下的：读库失败、项目已切换、解析意外抛错。
      if (isProjectSessionCurrent(session)) {
        setMessage(error instanceof Error && error.message.trim() ? error.message : text('核对失败。', 'The check failed.'))
      }
    } finally {
      setBusy(false)
    }
  }

  /**
   * 能力限制被绕过（#100）——**交给模型判**。
   * 限制句从世界观取（那是作者的声明），「正文有没有违反」由模型回答。
   */
  const checkAbility = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    const project = useProjectStore.getState().currentProject
    if (!session || busy || !project) return
    setBusy(true)
    setMessage(null)
    try {
      const core = await ipc.invokeWithProjectSession(session, 'db:project-core-get', session.projectPath).catch(() => null)
      if (!isProjectSessionCurrent(session)) return
      const worldbuilding = String((core as { worldbuilding?: string } | null)?.worldbuilding ?? '')
      const chapters = await recentFinalized(session)
      if (!isProjectSessionCurrent(session)) return
      // ⚠️ 世界观为空**不再**提前返回：这一档还查「同一章先说用尽、随后又成功」，
      // 那条不需要限制句（issue #163 第六批）。服务层只要求有已定稿章。
      if (chapters.length === 0) {
        setMessage(text('还没有已定稿的章可核对。', 'No finalized chapter to check yet.'))
        return
      }
      const outcome = await reviewAbilityLimits(session, worldbuilding, chapters, locale)
      if (!isProjectSessionCurrent(session)) return
      if (outcome.status === 'failed') { setMessage(outcome.error ?? text('核对失败。', 'The check failed.')); return }
      mergeFindings(outcome.findings)
    } catch (error) {
      // issue #203：核对调用的失败要**说出来**。原来这 11 颗按钮只有 try/finally，
      // 异常被 finally 吃掉 → 进度行消失、卡片没变、弹层一个字都没多，
      // 与「点了、模型说没问题」完全无法区分（实测 305 秒 504 那次）。
      // 服务层（preflight-repair 的 askReviewModel）已经把模型异常转成 failed 返回值，
      // 这里兜住剩下的：读库失败、项目已切换、解析意外抛错。
      if (isProjectSessionCurrent(session)) {
        setMessage(error instanceof Error && error.message.trim() ? error.message : text('核对失败。', 'The check failed.'))
      }
    } finally {
      setBusy(false)
    }
  }

  /**
   * 文风内容判据（比喻堆叠 / 生理套话 / 段尾总结 / 意象过载）——**交给模型判**。
   * 原先是三张题材短语表，按用户 2026-11-05 的规则全部交模型。
   */
  const checkStyle = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const chapters = await recentFinalized(session)
      if (!isProjectSessionCurrent(session)) return
      const outcome = await reviewProseStyle(session, chapters, locale)
      if (!isProjectSessionCurrent(session)) return
      if (outcome.status === 'failed') { setMessage(outcome.error ?? text('核对失败。', 'The check failed.')); return }
      mergeFindings(outcome.findings)
    } catch (error) {
      // issue #203：核对调用的失败要**说出来**。原来这 11 颗按钮只有 try/finally，
      // 异常被 finally 吃掉 → 进度行消失、卡片没变、弹层一个字都没多，
      // 与「点了、模型说没问题」完全无法区分（实测 305 秒 504 那次）。
      // 服务层（preflight-repair 的 askReviewModel）已经把模型异常转成 failed 返回值，
      // 这里兜住剩下的：读库失败、项目已切换、解析意外抛错。
      if (isProjectSessionCurrent(session)) {
        setMessage(error instanceof Error && error.message.trim() ? error.message : text('核对失败。', 'The check failed.'))
      }
    } finally {
      setBusy(false)
    }
  }

  /**
   * 跨章重复 / 道具链 / 陈旧时长——**交给模型判**（原先靠题材动作表）。
   */
  const checkContent = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const chapters = await recentFinalized(session)
      if (!isProjectSessionCurrent(session)) return
      // issue #219：轴清单**只从 content-review 取**（原来这里手写了一份，漏一个轴就静默失效）。
      const outcome = await reviewProseContent(session, chapters, CONTENT_AXES_FOR_BUTTON, locale)
      if (!isProjectSessionCurrent(session)) return
      if (outcome.status === 'failed') { setMessage(outcome.error ?? text('核对失败。', 'The check failed.')); return }
      mergeFindings(outcome.findings)
    } catch (error) {
      // issue #203：核对调用的失败要**说出来**。原来这 11 颗按钮只有 try/finally，
      // 异常被 finally 吃掉 → 进度行消失、卡片没变、弹层一个字都没多，
      // 与「点了、模型说没问题」完全无法区分（实测 305 秒 504 那次）。
      // 服务层（preflight-repair 的 askReviewModel）已经把模型异常转成 failed 返回值，
      // 这里兜住剩下的：读库失败、项目已切换、解析意外抛错。
      if (isProjectSessionCurrent(session)) {
        setMessage(error instanceof Error && error.message.trim() ? error.message : text('核对失败。', 'The check failed.'))
      }
    } finally {
      setBusy(false)
    }
  }

  /**
   * 感官通道覆盖（issue #151 的规则修正）——**交给模型判**，不由规则数词表。
   *
   * 与「核对角色外观」同一套：点一次 → 一次模型调用 → 结果并入提醒。
   */
  const checkSensory = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || busy) return
    const prose = (await ipc.invokeWithProjectSession(session, 'db:draft-export-snapshot', session.projectPath)
      .catch(() => [])) as Array<{ chapterNumber: number, content: string }>
    if (!isProjectSessionCurrent(session)) return
    const chapters = prose
      .filter(row => Number.isSafeInteger(row.chapterNumber) && row.chapterNumber < chapterNumber)
      .map(row => ({ chapterNumber: row.chapterNumber, content: String(row.content ?? '') }))
    setBusy(true)
    setMessage(null)
    try {
      const outcome = await reviewSensoryChannels(session, chapters, locale)
      if (!isProjectSessionCurrent(session)) return
      if (outcome.status === 'failed') { setMessage(outcome.error ?? text('核对失败。', 'The check failed.')); return }
      const found = sensoryVerdictFindings(outcome.summary)
      if (found.length === 0) {
        setMessage(text('模型判断这几章的感官通道够用（或章数太少，暂不判）。',
          'The model found the sensory coverage adequate (or there are too few chapters to judge).'))
        return
      }
      setPreflight(current => current ? { ...current, findings: [...current.findings, ...found] } : current)
      show()
    } catch (error) {
      // issue #203：核对调用的失败要**说出来**。原来这 11 颗按钮只有 try/finally，
      // 异常被 finally 吃掉 → 进度行消失、卡片没变、弹层一个字都没多，
      // 与「点了、模型说没问题」完全无法区分（实测 305 秒 504 那次）。
      // 服务层（preflight-repair 的 askReviewModel）已经把模型异常转成 failed 返回值，
      // 这里兜住剩下的：读库失败、项目已切换、解析意外抛错。
      if (isProjectSessionCurrent(session)) {
        setMessage(error instanceof Error && error.message.trim() ? error.message : text('核对失败。', 'The check failed.'))
      }
    } finally {
      setBusy(false)
    }
  }

  /**
   * 角色卡外观与正文的对账（issue #153）——**交给模型判**，不由规则扫词表。
   *
   * 与「修复」同一套交互：点一次 → 一次模型调用 → 结果进差异面板/提醒 → 作者决定。
   * 结果不落库：这条报的是「正文与卡上相悖」，改哪一侧由作者定。
   */
  const checkAppearance = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || busy) return
    const project = useProjectStore.getState().currentProject
    const roster = await ipc.invokeWithProjectSession(session, 'db:character-roster-read', session.projectPath).catch(() => null)
    const cards = (roster?.entries ?? []).flatMap(entry => {
      const name = String(entry.name ?? '').trim()
      const appearance = String(entry.appearance ?? '')
      const notes = String(entry.notes ?? '')
      return name && `${appearance}${notes}`.trim() ? [{ name, appearance, notes }] : []
    })
    if (!isProjectSessionCurrent(session)) return
    if (cards.length === 0 || !project) {
      setMessage(text('角色卡里还没有外观描述，无法核对。', 'No character card describes an appearance yet, so there is nothing to check.'))
      return
    }
    const prose = (await ipc.invokeWithProjectSession(session, 'db:draft-export-snapshot', session.projectPath)
      .catch(() => [])) as Array<{ chapterNumber: number, content: string }>
    if (!isProjectSessionCurrent(session)) return
    const chapters = prose
      .filter(row => Number.isSafeInteger(row.chapterNumber) && row.chapterNumber < chapterNumber)
      .map(row => ({ chapterNumber: row.chapterNumber, content: String(row.content ?? '') }))
    setBusy(true)
    setMessage(null)
    try {
      // issue #153 第一部分：同一次调用里顺便统计「卡上的显眼标志这几章用没用上」——
      // 那需要同一批章节已经在上下文里，再发一次一模一样的大请求是浪费。
      const outcome = await checkAppearanceAgainstCards(session, chapters, cards, locale, true)
      if (!isProjectSessionCurrent(session)) return
      if (outcome.status === 'failed') { setMessage(outcome.error ?? text('核对失败。', 'The check failed.')); return }
      const found = [
        ...appearanceContradictionFindings(outcome.contradictions),
        ...appearanceUnusedMarkFindings(outcome.unusedMarks),
      ]
      if (found.length === 0) {
        setMessage(text('模型没有找到正文与角色卡相悖的地方，也没有发现卡上标志一次没被用到。',
          'The model found neither a contradiction with a character card nor an unused card mark.'))
        return
      }
      // 两类结果一起并入提醒列表（作者已有的 ack/保存安排机制照常可用）。
      // 分开说清各有几条：相悖必须改，未使用只是提示。
      if (outcome.contradictions.length > 0 && outcome.unusedMarks.length > 0) {
        setMessage(text(
          `发现 ${outcome.contradictions.length} 处与角色卡相悖、${outcome.unusedMarks.length} 条卡上标志这几章没用上。`,
          `${outcome.contradictions.length} contradiction(s) with the cards; ${outcome.unusedMarks.length} card mark(s) never used.`))
      }
      setPreflight(current => current ? { ...current, findings: [...current.findings, ...found] } : current)
      show()
    } catch (error) {
      // issue #203：核对调用的失败要**说出来**。原来这 11 颗按钮只有 try/finally，
      // 异常被 finally 吃掉 → 进度行消失、卡片没变、弹层一个字都没多，
      // 与「点了、模型说没问题」完全无法区分（实测 305 秒 504 那次）。
      // 服务层（preflight-repair 的 askReviewModel）已经把模型异常转成 failed 返回值，
      // 这里兜住剩下的：读库失败、项目已切换、解析意外抛错。
      if (isProjectSessionCurrent(session)) {
        setMessage(error instanceof Error && error.message.trim() ? error.message : text('核对失败。', 'The check failed.'))
      }
    } finally {
      setBusy(false)
    }
  }

/**
   * 被当成证据的物件：跨章形态是否一致、形态与成因能不能同时成立（issue #156）。
   *
   * 现场：第 73 章「半个红指印，圆圆的」→ 第 74 章「缺口齐整，缺了半节的拇指按的」，
   * 而叶九缺的是右小指（第 45 章他用拇指压过页面）。这条推理是主线最高潮的证据。
   * 规则只摆样本与角色卡、校验两处引文可定位；「是不是同一枚印」「这个成因成不成立」交模型。
   */
  const checkEvidenceShapes = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const roster = await ipc.invokeWithProjectSession(session, 'db:character-roster-read', session.projectPath).catch(() => null)
      if (!isProjectSessionCurrent(session)) return
      // 角色卡只用来核「缺某部位」这类成因；没有卡也能判跨章形态漂移。
      const cards = ((roster?.entries ?? []) as Array<{ name?: string, appearance?: string, notes?: string }>).flatMap(entry => {
        const name = String(entry.name ?? '').trim()
        const appearance = String(entry.appearance ?? '')
        const notes = String(entry.notes ?? '')
        return name && `${appearance}${notes}`.trim() ? [{ name, appearance, notes }] : []
      })
      const chapters = await recentFinalized(session)
      if (!isProjectSessionCurrent(session)) return
      if (chapters.length === 0) {
        setMessage(text('还没有已定稿的正文可核对。', 'There is no finalized prose to check yet.'))
        return
      }
      const outcome = await reviewEvidenceShapes(session, chapters, cards, locale)
      if (!isProjectSessionCurrent(session)) return
      if (outcome.status === 'failed') { setMessage(outcome.error ?? text('核对失败。', 'The check failed.')); return }
      mergeFindings(outcome.findings)
    } catch (error) {
      // issue #203：核对调用的失败要**说出来**。原来这 11 颗按钮只有 try/finally，
      // 异常被 finally 吃掉 → 进度行消失、卡片没变、弹层一个字都没多，
      // 与「点了、模型说没问题」完全无法区分（实测 305 秒 504 那次）。
      // 服务层（preflight-repair 的 askReviewModel）已经把模型异常转成 failed 返回值，
      // 这里兜住剩下的：读库失败、项目已切换、解析意外抛错。
      if (isProjectSessionCurrent(session)) {
        setMessage(error instanceof Error && error.message.trim() ? error.message : text('核对失败。', 'The check failed.'))
      }
    } finally {
      setBusy(false)
    }
  }

  /**
   * 同一个书写者的笔迹被写成两套互斥特征（issue #97 / #163）——**交给模型判**。
   *
   * 旧实现用四张书写质量词表（稳匀/急促/重笔/轻笔）加归属句正则判；按用户 2026-11-05 的定规
   * （内容判断不许词表、不许短语匹配）改由模型判。规则只摆样本与名册、校验两处引文可定位。
   */
  const checkHandwriting = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const chapters = await recentFinalized(session)
      if (!isProjectSessionCurrent(session)) return
      if (chapters.length === 0) {
        setMessage(text('还没有已定稿的正文可核对。', 'There is no finalized prose to check yet.'))
        return
      }
      const roster = await ipc.invokeWithProjectSession(session, 'db:character-roster-read', session.projectPath).catch(() => null)
      if (!isProjectSessionCurrent(session)) return
      const castNames = ((roster?.entries ?? []) as Array<{ name?: string }>)
        .map(entry => String(entry.name ?? '').trim()).filter(Boolean)
      const outcome = await reviewHandwritingTraits(session, chapters, castNames, locale)
      if (!isProjectSessionCurrent(session)) return
      if (outcome.status === 'failed') { setMessage(outcome.error ?? text('核对失败。', 'The check failed.')); return }
      mergeFindings(outcome.findings)
    } catch (error) {
      // issue #203：核对调用的失败要**说出来**。原来这 11 颗按钮只有 try/finally，
      // 异常被 finally 吃掉 → 进度行消失、卡片没变、弹层一个字都没多，
      // 与「点了、模型说没问题」完全无法区分（实测 305 秒 504 那次）。
      // 服务层（preflight-repair 的 askReviewModel）已经把模型异常转成 failed 返回值，
      // 这里兜住剩下的：读库失败、项目已切换、解析意外抛错。
      if (isProjectSessionCurrent(session)) {
        setMessage(error instanceof Error && error.message.trim() ? error.message : text('核对失败。', 'The check failed.'))
      }
    } finally {
      setBusy(false)
    }
  }

  /**
   * 同一章蓝图**内部**自相矛盾（issue #172）——**交给模型判**。
   *
   * 现场：第 79 章 notes 同一条目先写「收完压一道」、后写「温珩的结要压三道」，正文照抄两处，
   * 而全章落幅正是「他打不成温珩的结法」。
   * 规则只把蓝图原文整段摆进去、校验两处引文可定位；「是不是同一件事」交模型。
   *
   * ⚠️ 必须从库里读整章蓝图：写作弹层拿到的 prefill 不含 notes，
   * 而本条现场的矛盾正好在 notes 里。
   */
  const checkBlueprintInternal = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const all = (await ipc.invokeWithProjectSession(session, 'db:blueprint-get-all', session.projectPath)
        .catch(() => [])) as Array<Record<string, unknown>>
      if (!isProjectSessionCurrent(session)) return
      const chapters = all.flatMap(row => {
        const number = Number(row.chapterNumber)
        if (!Number.isSafeInteger(number) || number > chapterNumber) return []
        const text = [row.notes, row.keyEvents, row.purpose, row.suspenseHook, row.costsAndTurns, row.foreshadowing]
          .map(value => String(value ?? '').trim()).filter(Boolean).join(String.fromCharCode(10))
        return text ? [{ chapterNumber: number, text }] : []
      })
      if (chapters.length === 0) {
        setMessage(text('蓝图里还没有可核对的文字。', 'The blueprints have no text to check yet.'))
        return
      }
      const outcome = await reviewBlueprintInternals(session, chapters, locale)
      if (!isProjectSessionCurrent(session)) return
      if (outcome.status === 'failed') { setMessage(outcome.error ?? text('核对失败。', 'The check failed.')); return }
      mergeFindings(outcome.findings)
    } catch (error) {
      // issue #203：核对调用的失败要**说出来**。原来这 11 颗按钮只有 try/finally，
      // 异常被 finally 吃掉 → 进度行消失、卡片没变、弹层一个字都没多，
      // 与「点了、模型说没问题」完全无法区分（实测 305 秒 504 那次）。
      // 服务层（preflight-repair 的 askReviewModel）已经把模型异常转成 failed 返回值，
      // 这里兜住剩下的：读库失败、项目已切换、解析意外抛错。
      if (isProjectSessionCurrent(session)) {
        setMessage(error instanceof Error && error.message.trim() ? error.message : text('核对失败。', 'The check failed.'))
      }
    } finally {
      setBusy(false)
    }
  }

  /**
   * 同一笔遗忘被跨章重新宣告（issue #75 / #163）——**交给模型判**。
   *
   * 旧实现是五张题材措辞表（记得/空了/空壳/被水洇/仍然没…），只对这本书的写法成立；
   * 按用户 2026-11-05 的定规改由模型判。规则只负责喂最近若干章、校验引文与章号。
   */
  const checkLossRestatement = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const chapters = await recentFinalized(session)
      if (!isProjectSessionCurrent(session)) return
      if (chapters.length < 2) {
        setMessage(text('至少要有两章已定稿正文才能判断「同一笔损失被重复宣告」。',
          'At least two finalized chapters are needed to judge a re-charged cost.'))
        return
      }
      const outcome = await reviewLossRestatements(session, chapters, locale)
      if (!isProjectSessionCurrent(session)) return
      if (outcome.status === 'failed') { setMessage(outcome.error ?? text('核对失败。', 'The check failed.')); return }
      mergeFindings(outcome.findings)
    } catch (error) {
      // issue #203：核对调用的失败要**说出来**。原来这 11 颗按钮只有 try/finally，
      // 异常被 finally 吃掉 → 进度行消失、卡片没变、弹层一个字都没多，
      // 与「点了、模型说没问题」完全无法区分（实测 305 秒 504 那次）。
      // 服务层（preflight-repair 的 askReviewModel）已经把模型异常转成 failed 返回值，
      // 这里兜住剩下的：读库失败、项目已切换、解析意外抛错。
      if (isProjectSessionCurrent(session)) {
        setMessage(error instanceof Error && error.message.trim() ? error.message : text('核对失败。', 'The check failed.'))
      }
    } finally {
      setBusy(false)
    }
  }

  /**
   * 期限宣告了却从不结算（issue #101 / #163）——**交给模型判**。
   *
   * 旧实现是四张题材措辞表（天亮前/日落前/明早… + 不许/别想/扣下… + 期限已过/逾期…），
   * 只对这本书的写法成立；按用户 2026-11-05 的定规改由模型判。
   */
  /**
   * 「核对日期一致」（issue #216）——**交给模型判**。
   *
   * 现场：父亲沉船那夜在第 3/7/12/13/14 章一律「七月十七」，第 95 章变成「九月十七」，
   * 而第 14 章已用对白锁死「这个日期 = 父亲出事那趟」。错值还进了蓝图 → 正文 → 事实账本。
   * 规则只取「X 月 Y 日」这种**写法**的句子，并校验两处引文都能逐字定位；
   * 「是不是同一件事、哪个对」由模型判。
   */
  const checkDateConflicts = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const chapters = await recentFinalized(session)
      if (!isProjectSessionCurrent(session)) return
      if (chapters.length < 2) {
        setMessage(text('至少要有两章已定稿正文才能比对跨章日期。',
          'At least two finalized chapters are needed to compare dates across chapters.'))
        return
      }
      const outcome = await reviewDateConflicts(session, chapters, locale)
      if (!isProjectSessionCurrent(session)) return
      if (outcome.status === 'failed') { setMessage(outcome.error ?? text('核对失败。', 'The check failed.')); return }
      mergeFindings(outcome.findings)
    } catch (error) {
      if (isProjectSessionCurrent(session)) {
        setMessage(error instanceof Error && error.message.trim() ? error.message : text('核对失败。', 'The check failed.'))
      }
    } finally {
      setBusy(false)
    }
  }

  const checkDeadlines = async () => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const chapters = await recentFinalized(session)
      if (!isProjectSessionCurrent(session)) return
      if (chapters.length < 2) {
        setMessage(text('至少要有两章已定稿正文才能判断「期限有没有结算」。',
          'At least two finalized chapters are needed to judge deadline settlement.'))
        return
      }
      const outcome = await reviewDeadlines(session, chapters, locale)
      if (!isProjectSessionCurrent(session)) return
      if (outcome.status === 'failed') { setMessage(outcome.error ?? text('核对失败。', 'The check failed.')); return }
      mergeFindings(outcome.findings)
    } catch (error) {
      // issue #203：核对调用的失败要**说出来**。原来这 11 颗按钮只有 try/finally，
      // 异常被 finally 吃掉 → 进度行消失、卡片没变、弹层一个字都没多，
      // 与「点了、模型说没问题」完全无法区分（实测 305 秒 504 那次）。
      // 服务层（preflight-repair 的 askReviewModel）已经把模型异常转成 failed 返回值，
      // 这里兜住剩下的：读库失败、项目已切换、解析意外抛错。
      if (isProjectSessionCurrent(session)) {
        setMessage(error instanceof Error && error.message.trim() ? error.message : text('核对失败。', 'The check failed.'))
      }
    } finally {
      setBusy(false)
    }
  }

  /** 作者勾选后落库（走现成写通道），然后重检刷新列表。 */
  const applyRepair = async (fields: readonly string[] | null) => {
    const diffs = repairProposal?.diffs.filter(diff => fields === null || fields.includes(diff.field)) ?? []
    if (!repairSource || diffs.length === 0) return
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await applyRepairDiffs(session, repairSource.layer, repairSource.chapterNumber, diffs)
      if (!result.success) { setMessage(result.error || text('写入失败', 'Write failed')); return }
      setRepairProposal(null)
      setRepairSource(null)
      // 跨层排队（issue #137）：这一层采纳了改动、且还有别的层 → 提出下一层。
      // ⚠️ 只在**真的采纳了改动**时继续：作者点「都不改」时不能推进，
      //    否则那几层的提醒会在没有任何改动的情况下被当作已处理。
      setAppliedRepairKeys(current => new Set([...current, ...repairTargetKeys]))
      const remaining = advanceRepairQueue(repairQueue, repairSource.layer)
      setRepairQueue(remaining)
      const next = remaining[0]
      if (shouldContinueRepairChain({ appliedChanges: true, hasOtherLayers: Boolean(next) }) && next) {
        // 先重检（这一层已落库），再按**最新**的提醒提出下一层。
        await start(false, session)
        if (!isProjectSessionCurrent(session)) return
        await proposeQueuedGroup(session, next)
        return
      }
      // 重检：改完的提醒应该消失，作者要能看到这一点。
      await start(false, session)
    } finally {
      setBusy(false)
    }
  }

  /** 提出队列里的下一层（与「修复」走同一条生成 + 差异确认路径）。 */
  const proposeQueuedGroup = async (
    session: ProjectSessionContext,
    group: { layer: 'world' | 'cast' | 'outline' | 'blueprint' | 'prose'; findings: readonly ConsistencyFinding[] },
  ) => {
    const outcome = await proposeLayerRepair(session, group.layer, chapterNumber, group.findings, locale)
    if (!isProjectSessionCurrent(session)) return
    if (outcome.status !== 'proposed') {
      // 这一层没成（模型认为不用改 / 失败）：队列已经把它移走，把原因说清楚就停。
      if (outcome.status === 'failed') setMessage(outcome.error)
      return
    }
    setRepairSource({ layer: group.layer, chapterNumber })
    setRepairProposal({
      layerLabel: group.layer === 'world' ? text('世界观/设定', 'worldbuilding') : text('本章蓝图', 'this chapter’s blueprint'),
      chapterNumber,
      diffs: outcome.diffs,
      remainingLayers: remainingRepairLayers(repairQueue).length,
    })
    show()
  }

  /**
   * 「保存安排」：落库后**只动这一条**（issue #170 建议 ③）。
   *
   * 旧实现是 `await start(false, saved)` —— 而 `start` 会重跑 `readConsistencyPreflight`
   * 并**整体替换** preflight 对象。那个函数不知道刚跑过哪几个模型判据（它不接收这些结果），
   * 所以重算的返回值天然不含它们 → 作者点一条无关旧账的「保存安排」，刚花 2 万 tok 核出来的
   * 10 条模型结论**静默清零**。这里改成与 `unacknowledgeFinding` 同一写法：只改这一条。
   */
  const saveArrangement = async (stableFactKey: string, reason: string) => {
    const saved = await changeArrangement(text('保存一致性安排失败', 'Could not save the consistency arrangement.'),
      session => ipc.invokeWithProjectSession(session, 'db:consistency-exemption-save', stableFactKey, reason, session.projectPath))
    if (!saved) return
    setPreflight(current => current ? {
      ...current,
      exemptions: [...current.exemptions.filter(item => item.stableFactKey !== stableFactKey),
        { stableFactKey, reason, revoked: false }],
      findings: current.findings.filter(item => item.stableFactKey !== stableFactKey),
    } : current)
  }

  const revokeArrangement = async (stableFactKey: string) => {
    const revoked = await changeArrangement(text('撤销一致性安排失败', 'Could not revoke the consistency arrangement.'),
      session => ipc.invokeWithProjectSession(session, 'db:consistency-exemption-revoke', stableFactKey, session.projectPath))
    if (!revoked) return
    setPreflight(current => current ? {
      ...current,
      exemptions: current.exemptions.map(item => item.stableFactKey === stableFactKey ? { ...item, revoked: true } : item),
    } : null)
  }

  /**
   * 「我已知，稍后处理」（issue #79）：与「保存安排」分开，不落 `consistency_exemptions`。
   * stable_fact_key 跨章稳定，所以 ack 一次就永久静音——这正是作者此前缺的第三个口径。
   * ack 后接着开写（与 saveArrangement 同一路径），作者不必再多点一次。
   */
  /**
   * 「我已知，稍后处理」：同样是**只动这一条**（issue #170 建议 ③）。
   *
   * 旧实现落库后调 `start(false, done)` 重算并整体替换 preflight —— 模型判据的结论不在
   * `readConsistencyPreflight` 的返回值里，于是一挂起旧账就把它们全清了（现场：60 → 50，
   * 模型条目 0 条，界面上没有任何提示）。挂起本来只该影响被挂起的那一条。
   */
  const acknowledgeFinding = async (stableFactKey: string) => {
    const done = await changeArrangement(text('标记稍后处理失败', 'Could not note it for later.'),
      session => ipc.invokeWithProjectSession(session, 'db:consistency-ack-save', stableFactKey, session.projectPath))
    if (!done) return
    setPreflight(current => current ? {
      ...current,
      findings: current.findings.filter(item => item.stableFactKey !== stableFactKey),
      acknowledgements: [...current.acknowledgements, { stableFactKey, acknowledgedAt: new Date().toISOString() }],
    } : current)
  }

  /**
   * 「为「X」建卡」（issue #160）：提醒自带动作时一键落一张空卡。
   *
   * 建成后把这一层重读一遍：卡在名册里，这条提醒（key 按名字，不含章号）自然消失。
   * 失败只报原因、不动预检——别在作者没弄清为什么失败时把提醒藏起来。
   */
  const createCharacterCard = async (name: string) => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!session || busy) return
    setBusy(true)
    setMessage(null)
    try {
      const outcome = await createCharacterCardForPreflight(session, {
        name,
        note: text(
          `由第 ${chapterNumber} 章的写前预检建卡（蓝图里连续出场但名册里没有）。内容待补。`,
          `Created by the Chapter ${chapterNumber} write preflight: cast in the blueprint but missing from the roster. Details to be filled in.`,
        ),
      })
      if (!isProjectSessionCurrent(session)) return
      if (outcome.status === 'failed') {
        setMessage(text(`建卡失败：${outcome.error}`, `Could not create the card: ${outcome.error}`))
        return
      }
      // 名册变了：这一层重读，免得作者照旧看到「没有这个人」。
      const refreshed = await readConsistencyPreflight(session, [{
        chapterNumber, title: blueprint.title, role: blueprint.role, purpose: blueprint.purpose,
        keyEvents: blueprint.keyEvents,
        characters: blueprint.characters.split(/[、,，]/u).map(value => value.trim()).filter(Boolean),
        suspenseHook: blueprint.suspenseHook ?? '', costsAndTurns: blueprint.costsAndTurns ?? '',
        foreshadowing: blueprint.foreshadowing, userGuidance: blueprint.userGuidance, notes: '',
      }], chapterDefaultWordsTarget(useProjectStore.getState().currentProject?.novelConfig.wordsPerChapter))
      if (!isProjectSessionCurrent(session)) return
      setPreflight(refreshed)
      setMessage(outcome.status === 'already-exists'
        ? text(`角色名单里已经有「${name}」，不需要再建。`, `The roster already has “${name}”.`)
        : text(`已为「${name}」建卡（姓名 + 定位）。接下来在角色名单里补身世、称呼与首次出场即可。`,
          `Created a card for “${name}” (name + role). Add their background, how they are addressed, and first appearance on the roster.`))
    } catch (error) {
      if (isProjectSessionCurrent(session)) setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const unacknowledgeFinding = async (stableFactKey: string) => {
    const done = await changeArrangement(text('恢复该提醒失败', 'Could not show this reminder again.'),
      session => ipc.invokeWithProjectSession(session, 'db:consistency-ack-revoke', stableFactKey, session.projectPath))
    if (!done) return
    setPreflight(current => current ? {
      ...current,
      acknowledgements: current.acknowledgements.filter(item => item.stableFactKey !== stableFactKey),
    } : null)
  }

  const showPreflight = preflight && (preflight.findings.length > 0 || preflight.exemptions.some(item => !item.revoked))
  // 预检提醒已经展示过一次后，主按钮再点就是「带提醒开写」：预检只是证据提示，
  // 不该让作者在同一个按钮上反复弹层（弹层页脚明明写着「点『写第 N 章』开始」）。
  const preflightSeen = !!preflight && preflight.findings.length > 0

  return (
    <SplitAction
      layer={layer}
      label={label}
      icon={<PenLine size={15} aria-hidden />}
      disabled={busy}
      busy={starting}
      busyLabel={text(`正在准备一致性预检… 已等 ${startingSeconds} 秒`, `Preparing the consistency check… ${startingSeconds}s`)}

      onRun={() => void start(preflightSeen)}
      optionsLabel={text('本次写作选项', 'Options for this run')}
      popoverClassName="stage-write-pop"
    >
      <div className="pi-field">
        {/*
          issue #224：两块簿记提示——同章活动运行与已有未定稿草稿。
          都在作者点「开始」**之前**出现，重复点击的费用与版本失控才有控制点。
        */}
        {activeChapterRun && (
          <div className="stage-write-error" role="alert">
            <p style={{ margin: 0 }}>
              {text(
                `上一次「${activeChapterRun.title}」还在运行中；同一章不能同时开两条管线。等它完成、或取消它再开始。`,
                `"${activeChapterRun.title}" is still running; two pipelines cannot write the same chapter at once. Wait for it to finish or cancel it first.`,
              )}
            </p>
            {/*
              issue #224 ②：旧 run 的**可见入口**——作者不用退出弹层去找运行侧页。
              只导航，不替他决定取消还是等待。
            */}
            <Button
              variant="text"
              size="sm"
              onClick={() => { close(false); useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }) }}
            >
              {text('去运行侧页查看', 'Open the run panel')}
            </Button>
          </div>
        )}
        {existingDrafts !== null && existingDrafts.filter(draft => draft.status !== 'finalized').length > 0 && (() => {
          const drafts = existingDrafts.filter(draft => draft.status !== 'finalized')
          const latest = drafts[drafts.length - 1]!
          return (
            <p className="stage-write-bookkeeping">
              {text(
                `本章已有 ${drafts.length} 个未定稿草稿（${drafts.map(draft => `v${draft.version} ${draft.wordCount} 字`).join('、')}）。重新生成会产生新版本 v${latest.version + 1}，且短纲会重新生成、内容可能与已有版本不同；已有草稿不受影响，之后仍可对比或审稿。`,
                `This chapter already has ${drafts.length} unfinalized draft(s) (${drafts.map(draft => `v${draft.version}, ${draft.wordCount} chars`).join('; ')}). Regenerating creates v${latest.version + 1} with a freshly generated outline that may differ; existing drafts stay available for comparison or review.`,
              )}
            </p>
          )
        })()}
        <label htmlFor={modelFieldId}>{text('本次模型', 'Model for this run')} <em>{text('只用于这一次', 'This run only')}</em></label>
        <select
          id={modelFieldId}
          className="pi-input"
          value={selectedModelId ?? ''}
          disabled={generationModels.length === 0}
          onChange={event => { setModelId(event.target.value || null); setMessage(null) }}
        >
          <option value="" disabled>{text('请选择可用生成模型', 'Select a generation model')}</option>
          {generationModels.map(model => (
            <option key={model.id} value={model.id}>
              {model.name || model.modelName}{model.id === defaultModelId ? text('（默认）', ' (default)') : ''}
            </option>
          ))}
        </select>
        {modelError && <p className="stage-write-error" role="alert">{modelError}</p>}
      </div>
      <div className="pi-field">
        <label htmlFor={guidanceFieldId}>{text('作者微操指导', 'Author guidance')} <em>{text('可选', 'Optional')}</em></label>
        <textarea
          id={guidanceFieldId}
          className="pi-input stage-write-textarea"
          rows={3}
          value={userGuidance}
          placeholder={text('比如：开头只写声音；结尾停在回头之前。', 'For example: open on sound only; end just before they turn around.')}
          onChange={event => setGuidance(event.target.value)}
        />
      </div>
      <details className="stage-write-more">
        <summary>
          <ChevronRight size={14} aria-hidden />
          {text('更多', 'More')}
          <small>{text('知识库检索关键词', 'Knowledge search terms')}</small>
        </summary>
        <div className="pi-field">
          <label htmlFor={hintFieldId}>{text('知识库检索关键词', 'Knowledge search terms')} <em>{text('可选', 'Optional')}</em></label>
          <input
            id={hintFieldId}
            className="pi-input"
            value={knowledgeHint}
            placeholder={text('如：剑法传承、草原地貌', 'e.g. sword inheritance, grassland terrain')}
            onChange={event => setKnowledgeHint(event.target.value)}
          />
        </div>
      </details>
      {showPreflight && (
        <WritePreflight
          preflight={preflight}
          busy={busy}
          onIgnoreOnce={() => void start(true)}
          onRerun={() => void start(false)}
          onSave={(key, reason) => void saveArrangement(key, reason)}
          onConfirmNoIssue={key => void saveArrangement(key, CONFIRMED_NO_ISSUE_REASON)}
          onRevoke={key => void revokeArrangement(key)}
          onAcknowledge={key => void acknowledgeFinding(key)}
          onUnacknowledge={key => void unacknowledgeFinding(key)}
          currentChapter={chapterNumber}
          onRepair={targets => void requestRepair(targets)}
          repairBusyLabel={repairSeconds !== null ? text(`正在按提醒生成修复… 已等 ${repairSeconds} 秒`, `Generating fix… s`) : undefined}
          onRepairAll={() => void requestRepair(preflight.findings)}
          onCheckAppearance={() => checkAppearance()}
          onCheckSensory={() => checkSensory()}
          onCheckStyle={() => checkStyle()}
          onCheckContent={() => checkContent()}
          onCheckAbility={() => checkAbility()}
          onCheckMemory={() => checkMemory()}
          onCheckBlueprintFacts={() => checkBlueprintFacts()}
          onCheckEvidence={() => checkEvidenceShapes()}
          onCheckHandwriting={() => checkHandwriting()}
          onCheckBlueprintInternal={() => checkBlueprintInternal()}
          onCheckLossRestatement={() => checkLossRestatement()}
          onCheckDeadline={() => checkDeadlines()}
          onCheckDateConflict={() => checkDateConflicts()}
          onCreateCharacter={name => void createCharacterCard(name)}
          repairProposal={repairProposal}
          onApplyRepairField={field => void applyRepair([field])}
          onApplyRepairAll={() => void applyRepair(null)}
          onDismissRepair={() => { setRepairProposal(null); setRepairSource(null); setRepairQueue([]) }}
          onOpenLayer={route => {
            // issue #137：把作者送到该提醒所属的那一层。先收起弹层，再导航——
            // 否则弹层会盖在目标页上（与「去修复定稿后处理」同一处理）。
            close(false)
            navigate(route.destination)
          }}
          /*
           * issue #137：「这条落在已定稿的章上」那一档原来**只有说明、没有出口** ——
           * 卡片让作者「先给那一章出新版本再重新定稿」，却不给任何按钮。
           * 这里把他送到那一章：版本入口与「应用为新版本」都在那一页
           * （ChapterActions）。**只导航，不替他决定要不要修。**
           */
          onOpenFinalizedChapter={target => {
            close(false)
            navigate({ kind: 'chapter', chapterNumber: target })
          }}
        />
      )}
      {message && <p className="stage-write-error" role="alert">{message}</p>}
      {repairChapter !== null && (
        <div className="stage-write-actions">
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={() => {
              // 去那一章的单章视图：定稿后处理面板与「修复定稿 / 重试失败步骤」都在那里
              // （ChapterActions → PostProcessSteps）。这里只导航，不替作者决定要不要修。
              close(false)
              navigate({ kind: 'chapter', chapterNumber: repairChapter })
            }}
          >
            {text(`去修复第 ${repairChapter} 章的定稿后处理`, `Fix Chapter ${repairChapter} finalization`)}
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => close(false)}>
            {text('留在蓝图', 'Stay on blueprints')}
          </Button>
        </div>
      )}
      <p className="stage-write-foot">{repairChapter !== null
        // 脚注不能承诺一个必然被拒绝的动作（issue #55）：正文让作者去修后处理，
        // 这里却写「点它开始」——按脚注做就会回到同一个阻断，被读成「点了没反应」。
        ? text(`这一步要先补完第 ${repairChapter} 章的定稿后处理才能继续写；补完后再点「${label}」。`, `Finish Chapter ${repairChapter} finalization post-processing before drafting; then choose “${label}” again.`)
        : preflightSeen
          ? text(`这些选项只用于本次写作。再点「${label}」将带提醒开始写；也可以在下方保存安排。`, `These options apply to this run only. Click “${label}” again to start with reminders, or save an arrangement below.`)
          : text(`这些选项只用于本次写作，点「${label}」开始。`, `These options apply to this run only. Choose “${label}” to start.`)}</p>
    </SplitAction>
  )
}

