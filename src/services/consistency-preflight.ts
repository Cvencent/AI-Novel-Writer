import type { ProjectSessionContext } from '../shared/ipc-channels'
import type { BlueprintForPreflight, ConsistencyAcknowledgement, ConsistencyExemption, ConsistencyFinding } from '../shared/consistency-preflight'
import { findAppearanceGaps, findBlueprintContinuityRisks, findExpandedContinuityRisks,
  findNearCastNameFindings, findOversizedBlueprintKeyEvents, findUnregisteredBlueprintCast,
  findDialogueOpenerConvergence, findOpeningShapeConvergence,
  findDesignTimelineConflicts, findMissingCastInArch,
  findLossRestatementFindings, findEntranceShotFindings } from '../shared/consistency-preflight'
import { DIALOGUE_OPENER_WINDOW_CHAPTERS, OPENING_SHAPE_WINDOW_CHAPTERS } from '../shared/chapter-opening'
import { ENTRANCE_WINDOW_CHAPTERS } from '../shared/entrance-shot'
import { findTitleShapeConvergenceFindings } from '../shared/title-shape'
import { auditFinalizedProse } from '../shared/finalized-prose-audit'
// issue #120：ack 区渲染人话（配不上当轮 finding 时用封闭目录翻译）。
import { acknowledgementTitleOf } from '../shared/acknowledgement-title'
import { DEFAULT_CHAPTER_WORDS_TARGET } from './workflows/chapter-creation-parameters'
import { ipc } from './ipc-client'

export interface ConsistencyPreflightResult {
  findings: ConsistencyFinding[]
  exemptions: ConsistencyExemption[]
  /** 已确认「我已知，稍后处理」的提醒（issue #79）：不再出现在 findings 里，但界面可列出。 */
  acknowledgements: ConsistencyAcknowledgement[]
  /** 在册角色名（retired=0）：细纲↔蓝图角色比对用（issue #27）。 */
  castNames: string[]
}

export async function readConsistencyPreflight(
  session: ProjectSessionContext,
  blueprints: readonly BlueprintForPreflight[],
  /** 本章正文目标字数：蓝图「冲突与转折」的长度口径随它缩放（issue #64）。 */
  targetWordsPerChapter: number = DEFAULT_CHAPTER_WORDS_TARGET,
): Promise<ConsistencyPreflightResult> {
  const [exemptions, acknowledgements] = await Promise.all([
    ipc.invokeWithProjectSession(session, 'db:consistency-exemption-list', session.projectPath),
    // issue #79：ack 过的提醒不再重报。stable_fact_key 跨章稳定，所以点一次
    // 「我已知，稍后处理」就永久静音——这正是作者此前缺的那个非承诺性出口。
    ipc.invokeWithProjectSession(session, 'db:consistency-ack-list', session.projectPath).catch(() => []),
  ])
  const acknowledgedKeys = new Set(acknowledgements.map(item => item.stableFactKey))
  const [roster, allBlueprints, threads] = await Promise.all([
    ipc.invokeWithProjectSession(session, 'db:character-roster-read', session.projectPath).catch(() => null),
    ipc.invokeWithProjectSession(session, 'db:blueprint-get-all', session.projectPath).catch(() => []),
    ipc.invokeWithProjectSession(session, 'db:narrative-thread-list', session.projectPath).catch(() => []),
  ])
  const terminalFindings = (await Promise.all(blueprints.map(async blueprint => {
    const projections = await ipc.invokeWithProjectSession(
      session, 'db:continuity-list-before', blueprint.chapterNumber, session.projectPath,
    )
    return findBlueprintContinuityRisks(projections, blueprint, exemptions)
  }))).flat()
  const currentChapter = blueprints.reduce((max, blueprint) => Math.max(max, blueprint.chapterNumber), 0)
  // 已定稿正文快照：缺席监控要靠它量「这个角色读者见过几章」（issue #107），
  // 后面的章首/伏笔/物证等检测也用它。放在这里是因为 #107 需要它在 expandedFindings **之前**。
  const recentProse = (await ipc.invokeWithProjectSession(
    session, 'db:draft-export-snapshot', session.projectPath,
  ).catch(() => [])) as Array<{ chapterNumber: number; content: string }>
  // 每个在册角色在**已定稿正文**里出现过的章数（issue #107）：判定「读者记住过他」。
  // 只数已定稿章（本章可能还没写），与蓝图判定用的章号口径一致。
  const proseChaptersByCast = new Map<string, number>()
  for (const entry of (Array.isArray(roster?.entries) ? roster.entries : [])) {
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (!name) continue
    proseChaptersByCast.set(name, recentProse.filter(row =>
      Number.isSafeInteger(row.chapterNumber) && String(row.content ?? '').includes(name)).length)
  }
  const expandedFindings = currentChapter === 0 ? [] : findExpandedContinuityRisks({
    currentChapter,
    blueprints: (Array.isArray(allBlueprints) ? allBlueprints : []).map(blueprint => ({
      chapterNumber: blueprint.chapterNumber,
      characters: Array.isArray(blueprint.characters) ? blueprint.characters : [],
      // 出场判定也要看描述文本（issue #74）：只读 characters 数组会把
      // 「描述里有他、数组里没他」报成整章缺席。
      descriptionText: [
        blueprint.keyEvents, blueprint.purpose, blueprint.costsAndTurns ?? '',
        blueprint.suspenseHook, blueprint.foreshadowing ?? '',
      ].filter(Boolean).join(' '),
    })),
    cast: (Array.isArray(roster?.entries) ? roster.entries : []).map(entry => ({
      name: entry.name,
      role: entry.role,
      motivation: typeof entry.motivation === 'string' ? entry.motivation : '',
      // issue #107：把「读者见过他几章」交给判据，配角据此纳入缺席监控。
      seenChapters: proseChaptersByCast.get(typeof entry.name === 'string' ? entry.name.trim() : '') ?? 0,
    })),
    threads: (Array.isArray(threads) ? threads : []).map(thread => ({
      title: thread.title,
      status: thread.status,
      dormantChapters: thread.dormantChapters,
      overdue: thread.overdue,
      authorIntent: thread.authorIntent,
    })),
  })
  const activeExemptions = new Set(exemptions.filter(item => !item.revoked).map(item => item.stableFactKey))
  const castNames = (Array.isArray(roster?.entries) ? roster.entries : [])
    .map(entry => (typeof entry.name === 'string' ? entry.name.trim() : ''))
    .filter(Boolean)
  // 蓝图引入了不在名册里的角色（issue #42）：任九式。放在这里而不是只在起草命令里，
  // 是因为审稿与写前预检共用同一个结果，作者在定稿前也能看到。
  // issue #160：改成**按名字合并全书**——同一个人不再逐章重报（key 去掉章号），
  // 承重的（多章出场 / 有台词）排在前面，并带上「一键建卡」动作。
  const unregisteredFindings = findUnregisteredBlueprintCast({
    // 全书蓝图 + 调用方传进来的这一章（后者可能还没落库，或被作者刚改过）——
    // 同一章以调用方那份为准，否则「刚在弹层里加了一个名字」这条判据会看不见。
    schedules: [
      ...(Array.isArray(allBlueprints) ? allBlueprints : [])
        .filter(blueprint => !blueprints.some(current => current.chapterNumber === blueprint.chapterNumber))
        .map(blueprint => ({
          chapterNumber: blueprint.chapterNumber,
          characters: Array.isArray(blueprint.characters) ? blueprint.characters : [],
        })),
      ...blueprints.map(blueprint => ({
        chapterNumber: blueprint.chapterNumber,
        characters: Array.isArray(blueprint.characters) ? blueprint.characters : [],
      })),
    ],
    castNames,
    prose: recentProse.map(row => ({
      chapterNumber: row.chapterNumber,
      content: String(row.content ?? ''),
    })),
  })
  // 在册角色缺外貌锚点（issue #40）：与 #42 同一层——都是「角色卡不完整会让下游静默失明」。
  // 这里只在**还没写外貌**的角色上提示一次，作者补上后自然消失。
  const appearanceGaps = findAppearanceGaps({
    chapterNumber: currentChapter,
    cast: (Array.isArray(roster?.entries) ? roster.entries : []).map(entry => ({
      name: typeof entry.name === 'string' ? entry.name : '',
      role: typeof entry.role === 'string' ? entry.role : undefined,
      appearance: typeof entry.appearance === 'string' ? entry.appearance : '',
    })),
  })
  // 描述文字里「与在册角色仅一字之差」的名字（issue #58）：#42 只看 characters 数组，
  // 而「柯阅」这种写在 keyEvents 里的署名正好从那条通道底下走过去。
  // 这里把蓝图里除 characters 之外会写人名的字段一并纳入比对面。
  const nearNameFindings = castNames.length === 0 ? [] : blueprints.flatMap(blueprint => findNearCastNameFindings({
    chapterNumber: blueprint.chapterNumber,
    castNames,
    descriptionText: [
      blueprint.keyEvents, blueprint.purpose, blueprint.suspenseHook, blueprint.costsAndTurns ?? '',
      blueprint.foreshadowing ?? '',
    ].join('\n'),
  }))
  // 蓝图「冲突与转折」长成了准正文（issue #64）：只做可见性提示，不改写也不拦稿
  // （合同层写明作者指定事件为权威、不得删除，硬上限会推翻它）。
  const keyEventsLengthFindings = blueprints.flatMap(blueprint => findOversizedBlueprintKeyEvents({
    chapterNumber: blueprint.chapterNumber,
    keyEvents: blueprint.keyEvents,
    targetWordsPerChapter,
  }))
  // 章首句式收敛（issue #71）与同一线索的揭示句式（issue #72）：两者都读**已定稿正文**，
  // 而这里正是起草/写前能拿到最近定稿的位置。取最近若干章 + 本章正在写的这一章。
  // 原来 `chapter-shape.ts` 只在生成细纲时打一行日志，正文写作阶段完全没人看章首。
  // `recentProse` 已在上面取过（#107 的缺席监控也要用它），这里直接用。
  // 已定稿正文的规范视图：只留本章之前的章、按章号升序、content 归一成字符串。
  // 各检测按自己的窗口从这里切（与 prop-termination 的 PROP_WINDOW 同一做法）。
  const historyProse = recentProse
    .filter(row => Number.isSafeInteger(row.chapterNumber) && row.chapterNumber < currentChapter)
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .map(row => ({ chapterNumber: row.chapterNumber, content: String(row.content ?? '') }))
  /**
   * 两档章首判据的**样本必须分开**（issue #155）。
   *
   * - 章首句式收敛：语义是「最近几章**连续同构**」→ 6 章窗口合理；
   * - 对白起手语：契约是「同一句起手语在**多章**重复，≥3 章即报」——
   *   它自己**没有窗口概念**，3 章可以散落在全书。塞进 6 章窗口后，跨度大于 6 的组
   *   **结构上永远不可达**（实测 75 章的书 38 组里 27 组如此，包括 #72 的核心证据
   *   「你爸当年也」——它在 8 章分散出现，6 章窗里一次都凑不出 3 章）。
   *
   * 所以起手语这一档改用**全部已定稿章**：它是「出现次数/覆盖章数」语义，不需要相邻。
   * 窗口常量也随之收在判据侧（下面 DIALOGUE_OPENER_CHAPTERS），不再硬编码在服务层——
   * 两处漂开没有任何测试会红（这正是本条能潜伏这么久的原因）。
   */
  // 物证重复终结（#73）等判据沿用原来的「最近 6 章」样本——它们的语义是近期形态，
  // 与起手语「整本书反复出现」不是一类。
  const openingShapeSample = historyProse.slice(-OPENING_SHAPE_WINDOW_CHAPTERS)
  const dialogueOpenerSample = historyProse.slice(-DIALOGUE_OPENER_WINDOW_CHAPTERS)
  const openingFindings = historyProse.length === 0 ? [] : [
    ...(openingShapeSample.length === 0 ? [] : [findOpeningShapeConvergence({ chapters: openingShapeSample, castNames, currentChapter })]).flat(),
    ...(dialogueOpenerSample.length === 0 ? [] : [findDialogueOpenerConvergence({ chapters: dialogueOpenerSample, castNames, currentChapter })]).flat(),
  ]
  // 设定层时间锚点冲突（issue #2）：发生在架构阶段、会顺着链路往下传，
  // 所以放在起草/写前预检里——这是作者还来得及改设定的时候。
  const core = await ipc.invokeWithProjectSession(
    session, 'db:project-core-get', session.projectPath,
  ).catch(() => null)
  const timelineFindings = core
    ? findDesignTimelineConflicts({
        premise: String((core as { premise?: string }).premise ?? ''),
        worldbuilding: String((core as { worldbuilding?: string }).worldbuilding ?? ''),
        charactersArch: String((core as { charactersArch?: string }).charactersArch ?? ''),
      })
    : []
  // 角色名单里的角色没进「人物群像」（issue #3）：名单有、卡片有、群像没有，
  // 而群像才是作者在架构阶段真正会读会改的那份。与 #42/#58 同一形态——都是
  // 「下游可见性」，只是这一条的文档是架构层的群像而不是蓝图。
  const rosterEntries = (Array.isArray(roster?.entries) ? roster.entries : [])
    .map(entry => ({ name: typeof entry.name === 'string' ? entry.name : '',
      role: typeof entry.role === 'string' ? entry.role : undefined }))
    .filter(entry => entry.name.trim())
  const missingArchCastFindings = core
    ? findMissingCastInArch({
        charactersArch: String((core as { charactersArch?: string }).charactersArch ?? ''),
        cast: rosterEntries,
      })
    : []
  // 章节标题的句法同构（issue #106）：标题层此前**只有「不得重名」一条**（字面相等），
  // 而正文层已建五层位置轴（#71 章首 / #28#65#66 章末 / #81 登场句 / #94 段落起手 /
  // #95 物件过手）——标题层是第六层，完全空白。判据只看**章节标题**（蓝图 title），
  // 与已定稿正文无关，所以样本取全部蓝图（不是 historyProse）。
  const titleShapeFindings = findTitleShapeConvergenceFindings({
    chapters: (Array.isArray(allBlueprints) ? allBlueprints : []).map(blueprint => ({
      chapterNumber: blueprint.chapterNumber,
      title: typeof blueprint.title === 'string' ? blueprint.title : '',
    })),
  })
  // 同一件物证被终结两次（#73）原先是题材动作表判据（解开|剪断|烧掉…），
  // 已按用户 2026-11-05 的规则改由模型判（content-review.ts 的 prop-terminal 轴）。
  const propTerminationFindings: ConsistencyFinding[] = []
  // 同一笔遗忘被跨章重新宣告（issue #75）：同样读最近定稿正文。窗口比物证那条放宽
  // 到 8 章——报告里的两组分别跨了 4 章（19→23）与 2 章（23→25），只看最近 6 章
  // 会漏掉第一组。
  // 只取最近 12 章：判据是两两比较，全书拿进来对长篇是 O(n²)。
  // 12 章足够覆盖「最多三次宣告、每次间隔 ≤4 章」的最坏情况。
  // 已被写死的物证又回来（issue #78）：窗口要覆盖「消亡章 → 再现章」的跨度，
  // 实测样本是 21 章消亡、28/30 章再现，只看最近 6 章会漏掉。
  // 人物登场句同构（issue #81）：这一位置此前三组检测都看不到（章首/章末/核心戏）。
  // 窗口用判据自己导出的 `ENTRANCE_WINDOW_CHAPTERS`（issue #92）——原来这里硬编码 10，
  // 而判据允许相隔 8 章配对、链子还能更长：实测 39 章的书全书 7 组、10 章窗口 **0 组**，
  // 窗口一滑过去就永久静音，而预检标题仍显示正数条数（作者以为检查过了）。
  const entranceShotFindings = recentProse.length === 0 ? [] : findEntranceShotFindings({
    chapters: recentProse
      .filter(row => Number.isSafeInteger(row.chapterNumber) && row.chapterNumber < currentChapter)
      .sort((left, right) => left.chapterNumber - right.chapterNumber)
      .slice(-ENTRANCE_WINDOW_CHAPTERS)
      .map(row => ({ chapterNumber: row.chapterNumber, content: String(row.content ?? '') })),
    castNames: (Array.isArray(roster?.entries) ? roster.entries : [])
      .map(entry => (typeof entry.name === 'string' ? entry.name.trim() : ''))
      .filter(Boolean),
    currentChapter,
  })
  // 全章体检（issue #83）：收束标注（#65）／编号位数（#47）／能力上限（#51）／
  // 正文层跨章重复（#32/#33/#49）／伏笔未送达（#68）／通牒式收尾连胜（#66）／
  // 跨章断言反转（#52）——这 7 项原来**只接在审稿路径**上，而实测那本书 23 章
  // 没有审稿报告，于是它们在真实使用中一次都没露过面。写前预检已经有一份
  // 「已定稿正文 + 全书蓝图 + 名册」的输入，正好够跑（#71/#72 是同类先例）。
  //
  // 注意只喂**已定稿章**：要写的那一章此刻还没有正文，所以这里报出的语义是
  // 「过去这些章已经存在这样的问题」，而不是「你正要写的这一章有问题」。
  const finalizedProseAuditFindings = auditFinalizedProse({
    chapters: historyProse,
    castNames,
    // 能力触发条件被绕过（#100）：限制句从世界观取（源头那一层）。
    worldbuilding: String((core as { worldbuilding?: string } | null)?.worldbuilding ?? ''),
    blueprints: (Array.isArray(allBlueprints) ? allBlueprints : []).map(blueprint => ({
      chapterNumber: blueprint.chapterNumber,
      // 标题「同题加尾」复用（#110）需要 title。
      title: blueprint.title,
      keyEvents: blueprint.keyEvents,
      foreshadowing: blueprint.foreshadowing,
      // 重复宣告的不可逆代价（#105）取 costsAndTurns：账本把同一处境记了两遍不可逆。
      costsAndTurns: blueprint.costsAndTurns,
    })),
  })
  // 道具复活（#78）同样依赖终结动作表 → 已并入 content-review.ts 的 prop-terminal 轴。
  const propRevivalFindings: ConsistencyFinding[] = []
  const lossRestatementFindings = recentProse.length === 0 ? [] : findLossRestatementFindings({
    chapters: recentProse
      .filter(row => Number.isSafeInteger(row.chapterNumber) && row.chapterNumber < currentChapter)
      .sort((left, right) => left.chapterNumber - right.chapterNumber)
      .slice(-12)
      .map(row => ({ chapterNumber: row.chapterNumber, content: String(row.content ?? '') })),
    currentChapter,
  })
  // issue #120：ack 区要给作者看人话，而不是 `stableFactKey`。
  // 存储层只有「键 + 时间」两列，所以标题在这里补：**先按 key 与本轮全部 finding 配对**
  // （那条判据这一轮仍命中 → 用判据自己写的原话），配不上的用封闭目录译出人话并注明
  // 「已不再报出」。注意配对要拿**过滤 ack 之前**的完整清单。
  const allFindings = [...terminalFindings, ...expandedFindings, ...unregisteredFindings, ...appearanceGaps,
    ...nearNameFindings, ...keyEventsLengthFindings, ...openingFindings, ...timelineFindings,
    ...missingArchCastFindings, ...propTerminationFindings, ...lossRestatementFindings,
    ...propRevivalFindings, ...entranceShotFindings, ...titleShapeFindings,
    ...finalizedProseAuditFindings]
  const findingByKey = new Map(allFindings.map(item => [item.stableFactKey, item]))
  const acknowledgedWithTitles = acknowledgements.map(item => ({
    ...item,
    title: acknowledgementTitleOf(item.stableFactKey, findingByKey.get(item.stableFactKey) ?? null),
  }))
  return {
    findings: allFindings
      .filter(item => !activeExemptions.has(item.stableFactKey))
      .filter(item => !acknowledgedKeys.has(item.stableFactKey)),
    exemptions,
    acknowledgements: acknowledgedWithTitles,
    castNames,
  }
}
