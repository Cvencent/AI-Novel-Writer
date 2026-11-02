import type { ProjectSessionContext } from '../shared/ipc-channels'
import type { BlueprintForPreflight, ConsistencyAcknowledgement, ConsistencyExemption, ConsistencyFinding } from '../shared/consistency-preflight'
import { findAppearanceGaps, findBlueprintContinuityRisks, findExpandedContinuityRisks,
  findNearCastNameFindings, findOversizedBlueprintKeyEvents, findUnregisteredBlueprintCast,
  findDialogueOpenerConvergence, findOpeningShapeConvergence,
  findDesignTimelineConflicts, findMissingCastInArch,
  findRepeatPropTerminationFindings, findLossRestatementFindings,
  findPropRevivalFindings } from '../shared/consistency-preflight'
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
  const unregisteredFindings = blueprints.flatMap(blueprint => findUnregisteredBlueprintCast({
    chapterNumber: blueprint.chapterNumber,
    blueprintCharacters: blueprint.characters,
    castNames,
  }))
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
  const recentProse = (await ipc.invokeWithProjectSession(
    session, 'db:draft-export-snapshot', session.projectPath,
  ).catch(() => [])) as Array<{ chapterNumber: number; content: string }>
  const proseSample = [
    ...recentProse
      .filter(row => Number.isSafeInteger(row.chapterNumber) && row.chapterNumber < currentChapter)
      .sort((left, right) => left.chapterNumber - right.chapterNumber)
      .slice(-6)
      .map(row => ({ chapterNumber: row.chapterNumber, content: String(row.content ?? '') })),
  ]
  const openingFindings = proseSample.length === 0 ? [] : [
    ...findOpeningShapeConvergence({ chapters: proseSample, castNames, currentChapter }),
    ...findDialogueOpenerConvergence({ chapters: proseSample, castNames, currentChapter }),
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
  // 同一件物证被终结两次（issue #73）：与 #71/#72 共用同一份最近定稿正文样本。
  const propTerminationFindings = proseSample.length === 0 ? [] : findRepeatPropTerminationFindings({
    chapters: proseSample,
    currentChapter,
  })
  // 同一笔遗忘被跨章重新宣告（issue #75）：同样读最近定稿正文。窗口比物证那条放宽
  // 到 8 章——报告里的两组分别跨了 4 章（19→23）与 2 章（23→25），只看最近 6 章
  // 会漏掉第一组。
  // 只取最近 12 章：判据是两两比较，全书拿进来对长篇是 O(n²)。
  // 12 章足够覆盖「最多三次宣告、每次间隔 ≤4 章」的最坏情况。
  // 已被写死的物证又回来（issue #78）：窗口要覆盖「消亡章 → 再现章」的跨度，
  // 实测样本是 21 章消亡、28/30 章再现，只看最近 6 章会漏掉。
  const propRevivalFindings = recentProse.length === 0 ? [] : findPropRevivalFindings({
    chapters: recentProse
      .filter(row => Number.isSafeInteger(row.chapterNumber) && row.chapterNumber < currentChapter)
      .sort((left, right) => left.chapterNumber - right.chapterNumber)
      .slice(-16)
      .map(row => ({ chapterNumber: row.chapterNumber, content: String(row.content ?? '') })),
    currentChapter,
    // 人不是道具（issue #80）：抽取器要名册才能排除角色名。
    castNames: (Array.isArray(roster?.entries) ? roster.entries : [])
      .map(entry => (typeof entry.name === 'string' ? entry.name.trim() : ''))
      .filter(Boolean),
  })
  const lossRestatementFindings = recentProse.length === 0 ? [] : findLossRestatementFindings({
    chapters: recentProse
      .filter(row => Number.isSafeInteger(row.chapterNumber) && row.chapterNumber < currentChapter)
      .sort((left, right) => left.chapterNumber - right.chapterNumber)
      .slice(-12)
      .map(row => ({ chapterNumber: row.chapterNumber, content: String(row.content ?? '') })),
    currentChapter,
  })
  return {
    findings: [...terminalFindings, ...expandedFindings, ...unregisteredFindings, ...appearanceGaps,
      ...nearNameFindings, ...keyEventsLengthFindings, ...openingFindings, ...timelineFindings,
      ...missingArchCastFindings, ...propTerminationFindings, ...lossRestatementFindings,
      ...propRevivalFindings]
      .filter(item => !activeExemptions.has(item.stableFactKey))
      .filter(item => !acknowledgedKeys.has(item.stableFactKey)),
    exemptions,
    acknowledgements,
    castNames,
  }
}
