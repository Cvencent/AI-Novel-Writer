/**
 * 已定稿正文的全章体检（issue #83）。
 *
 * 原来有 7 项**可机器判**的写作体检只接在「审稿」这一条路径上
 * （`electron/services/review-revision-context.ts`）。而审稿在真实环境里几乎不产出结果：
 * 实测那本悬疑长篇 32 章定稿，`reviews` 只有 19 行、覆盖章号只到第 9 章，
 * 此后 23 章全无报告——于是这 7 项检测**在任何一步都不会出现**。
 *
 * 本模块把其中**能在已定稿正文上独立判定**的 6 项收成一处，供写前预检调用：
 *
 *   1. 收束标注与正文落幅不符（#65）——需要蓝图 keyEvents 的标注
 *   2. 编号位数自相矛盾（#47）——只读单章正文
 *   3. 能力上限被自己作废（#51）——只读单章正文
 *   4. 正文层跨章重复（#32/#33/#49）——读多章正文的分布
 *   5. 伏笔承诺未在目标章落地（#68）——读承诺 + 目标章正文
 *   6. 连续多章通牒式收尾（#66）——读相邻多章正文
 *   7. 跨章断言反转（#52）——读前章 + 后章正文（历史回看）
 *   8. 「AI 味」配额（#93）——比喻／生理反应／段尾总结／平均句长，配额取自起草清单原文
 *   9. 段落起手固定化（#94）——每一段的第一个词是主角名/代词
 *  10. 物件过手动作固定化（#95）——折好→塞进某处 这一套三拍覆盖了多少章
 *  11. 字形断言（#99）——「半个 X 字，Y 旁」把偏旁说错（温写成立人旁、徐写成走之底）
 *  12. 角色名漂移（#102）——已登记角色在正文里被写成同后缀异姓（陆敬堂→穆敬堂），且已被账本继承
 *  13. 期限宣告未对账（#101）——上一章抛出的期限，下一章整章不再提（既未兑现也未逾期/延期）
 *  14. 重复宣告的不可逆处境变更（#105）——同一处境被记两遍不可逆，第一次从未落地
 *  15. 章节标题「同题加尾」复用（#110）——「压印」/「压印的」、「无人认领」/「无人认领，一并化浆」
 *  16. 能力触发条件被静默绕过（#100）——世界观写死的硬限制在正文里失效且从未写成一次发现
 *  17. 笔迹特征自相矛盾（#97）——同一个书写者被写成两套互斥特征
 *  18. 末句落点收敛（#111）——末句连续落在「物 + 未完结态 + 无人称」上（#66 管语用，本条管形态）
 *  19. 句长单向收敛（#114）——最近窗口的叙述句均长比开篇基准低一截（与 #93 的上限判据同层、方向相反）
 *
 * 与审稿路径的差别只有一处，而且是刻意的：审稿把**本章正文**也放进样本
 * （那正是审稿的对象），而写前预检喂进来的全是**已定稿章**——因为要写的那一章
 * 此刻还没有正文。于是这里报出的语义是「过去这几章已经存在这样的问题」，
 * 而不是「你正要写的这一章有问题」。对作者落笔前该知道什么而言，这是更有用的那一半。
 *
 * #52 的口径要说明白：审稿时它是「**本章**推翻了前章」；写前没有本章，
 * 所以这里改成**历史回看**——在已定稿章之间找「后一章否定了前一章的断言」。
 * 实测那本书确实存在一对（第 13 章正文断「是叶九的手」，第 19 章又断「不是叶九的手」，
 * 而第 19 章整章推理架在后一句上）。这与报告里「#52 = 0 条」不矛盾：报告只按
 * 单章对全样本比，没有做历史两两回看。
 */
import type { ConsistencyFinding } from './consistency-preflight'
import {
  abilityBudgetFindings,
  assertionReversalFindings,
  findClosingLabelConflicts,
  findPendingLandingConvergence,
  findUltimatumStreak,
  findUndeliveredForeshadowing,
  numberingFindings,
} from './consistency-preflight'
import { proseRepetitionFindings } from './prose-repetition'
// 「AI 味」的可机器判子集（issue #93）：超配额、段尾总结腔、平均句长。
import { proseFlavorDriftFindings, proseFlavorFindings } from './prose-flavor'
// 段落起手（#94）与物件过手（#95）：同一类「跨章看同一种写法」的位置轴补位。
import { findParagraphOpenerFindings, findPropHandoverFindings } from './consistency-preflight'
import { findUndatedStreakFindings } from './chapter-time-anchor'
// 字形断言（#99）：正文里「半个 X 字，Y 旁」把偏旁说错——单章可判，且是最容易机器判的一类。
import { glyphRadicalFindings } from './glyph-radical'
// 已登记角色名的同后缀异姓漂移（#102）：正文把「陆敬堂」写成「穆敬堂」。
import { findCastNameDriftFindings } from './cast-name-drift'
// 期限宣告未对账（#101）：期限「只写不读」——宣告了但下一章整章不再提。
import { findUnsettledDeadlineFindings } from './deadline-settlement'
// 同一项不可逆处境变更被宣告两次（#105）：账本记两遍、第一次从未落地。
import { findRepeatedRevocationFindings } from './repeated-revocation'
// 章节标题「同题加尾」复用（#110）：合同只判精确同名、且只管新生成的那一批。
import { findDuplicateChapterTitleFindings } from './chapter-title-uniqueness'
// 能力触发条件被绕过（#100）：世界观写死的硬限制在正文里被静默绕过、从未写成一次发现。
import { findAbilityLimitBypassFindings } from './ability-limit-bypass'
// 笔迹特征自相矛盾（#97）：同一个书写者被写成两套互斥特征（「稳、匀」vs「横折收得急」）。
import { findHandwritingConflictFindings } from './handwriting-signature'
import { closingShotOf } from './blueprint-semantic-contract'
import { foreshadowingDueAt, parseForeshadowingCommitments } from './foreshadowing-commitments'

export interface FinalizedProseChapter {
  chapterNumber: number
  content: string
}

export interface FinalizedProseAuditInput {
  /** 已定稿章（按章号升序、只含要写的那一章之前的章）。 */
  chapters: readonly FinalizedProseChapter[]
  /** 在册角色名（#32/#33/#49 的「按角色归一」需要它）。 */
  castNames: readonly string[]
  /**
   * 世界观文本（issue #100）：能力触发条件的**限制句从它取**（源头那一层）。
   * 不给就跳过这一类判据——没有声明过的规则无所谓被绕过。
   */
  worldbuilding?: string
  /** 全书蓝图；收束标注取自 `keyEvents`，伏笔承诺取自 `foreshadowing`，重复宣告的代价取自 `costsAndTurns`（#105）。 */
  blueprints: ReadonlyArray<{ chapterNumber: number; title?: string; keyEvents?: string; foreshadowing?: string; costsAndTurns?: string }>
  /**
   * 跨章重复（#32/#33/#49）的样本窗口。
   *
   * 默认 12：分布判据的入参下限是 8 章（`findProseRepetition` 的 `minChapters`），
   * 而写前预检原来只有 6 章样本——接上去会是一条**永远返回空**的分支。
   * 12 章同时让「配角分母」（#49 的 `minCharacterChapters`＝4）有足够样本。
   */
  repetitionWindow?: number
  /** 编号／标注／能力上限的窗口。默认 12 章。 */
  auditWindow?: number
  /**
   * 伏笔落地复核的窗口。默认取「全部已定稿章」——
   * 承诺常常跨越十几章（实测第 14 章承诺留待第 15 章、第 13 章承诺指向第 22 章），
   * 窗口切小了会把兑现目标章切出样本，从而报出已经兑现过的旧账。
   */
  foreshadowingWindow?: number
}

const DEFAULT_REPETITION_WINDOW = 12
const DEFAULT_AUDIT_WINDOW = 12
/** 通牒连胜按「最近 4 章」——与审稿路径同一口径（`review-revision-context.ts`）。 */
const ULTIMATUM_WINDOW = 4

/**
 * 跑一遍「已定稿正文」的全章体检，返回可直接进预检/审稿的 findings。
 *
 * 顺序固定，便于调用方比对与快照；每项都自带 `stable_fact_key`，
 * 作者可以在一致性豁免或「我已知」里逐条消掉（#79）。
 */
export function auditFinalizedProse(input: FinalizedProseAuditInput): ConsistencyFinding[] {
  const chapters = [...input.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .map(chapter => ({ chapterNumber: chapter.chapterNumber, content: String(chapter.content) }))
  if (chapters.length === 0) return []
  const blueprints = Array.isArray(input.blueprints) ? input.blueprints : []
  const castNames = [...new Set((input.castNames ?? []).map(name => String(name ?? '').trim()).filter(Boolean))]
  // sourceChapter 用「下一章」：这些提示是给「即将落笔的这一次」看的，
  // 而本条样本里最新的定稿是上一章。用末章 + 1 与审稿路径的 currentChapter 口径一致。
  const nextChapter = chapters[chapters.length - 1]!.chapterNumber + 1

  const repetitionWindow = input.repetitionWindow ?? DEFAULT_REPETITION_WINDOW
  const auditWindow = input.auditWindow ?? DEFAULT_AUDIT_WINDOW
  const repetitionSample = chapters.slice(-repetitionWindow)
  const auditSample = chapters.slice(-auditWindow)
  const foreshadowingSample = input.foreshadowingWindow === undefined
    ? chapters : chapters.slice(-input.foreshadowingWindow)

  // 收束标注（#65）：标注来自**同一章的蓝图 keyEvents**，而正文来自定稿。
  const labelByChapter = new Map(blueprints.map(blueprint => [
    blueprint.chapterNumber,
    closingShotOf(String(blueprint.keyEvents ?? '')),
  ]))
  const closingLabel = findClosingLabelConflicts(auditSample.map(chapter => ({
    chapterNumber: chapter.chapterNumber,
    label: labelByChapter.get(chapter.chapterNumber) ?? '',
    content: chapter.content,
  })))

  // 编号位数（#47）与能力上限（#51）：单章自洽，逐章跑。
  const numbering = auditSample.flatMap(chapter => numberingFindings({
    chapterNumber: chapter.chapterNumber, content: chapter.content,
  }))
  const ability = auditSample.flatMap(chapter => abilityBudgetFindings({
    chapterNumber: chapter.chapterNumber, content: chapter.content,
  }))

  // 正文层跨章重复（#32/#33/#49）：分布判据，样本不足 8 章直接返回空。
  const repetition = repetitionSample.length < 8
    ? [] : proseRepetitionFindings(repetitionSample, nextChapter, castNames)

  // 伏笔承诺未落地（#68）：逐章问「曾承诺在本章兑现的，本章正文里有没有它的实体词」。
  const commitments = parseForeshadowingCommitments(blueprints.map(blueprint => ({
    chapterNumber: blueprint.chapterNumber,
    foreshadowing: String(blueprint.foreshadowing ?? ''),
  })))
  const undelivered = commitments.length === 0 ? [] : foreshadowingSample.flatMap(chapter =>
    findUndeliveredForeshadowing({
      chapterNumber: chapter.chapterNumber,
      content: chapter.content,
      // 不扣「已在上下文里的章」：这里就是要拿全部指向该章的承诺来核对。
      commitments: foreshadowingDueAt(commitments, chapter.chapterNumber, { alreadyInContextChapters: 0 }),
      // 全量已定稿正文当样本，量出检索词的可区分度（issue #88）：
      // 「名字」这类全书通用的词不该被当成「这件事被写到了」的证据。
      corpus: chapters.map(item => item.content),
    }))

  // 通牒式收尾连胜（#66）：只报**尾部**连续段，所以样本取最近几章即可。
  const ultimatum = findUltimatumStreak({
    chapters: chapters.slice(-ULTIMATUM_WINDOW),
    currentChapter: nextChapter,
  })

  // 末句落点收敛（issue #111）：末句连续落在「物 + 未完结态 + 无人称」上。
  // 与 #66 同一位置轴、不同维度（#66 语用 / 本条形态），窗口取 10 章（判据自带阈值）。
  const pendingLanding = findPendingLandingConvergence({
    chapters,
    castNames,
    currentChapter: nextChapter,
  })

  // 跨章断言反转（#52）：历史回看——在已定稿章之间找「后一章否定了前一章的结论」。
  // 逐对做是 O(n²)，所以只用**最近几章当「后章」**：久远的章对早已被作者接受，
  // 而且报告关心的正是「后面写的那一章有没有跟前面对不上」。
  // 用同一份 auditSample 当「前章池」不必要——断言反转的前章此前章的任意一章都可能，
  // 故前章池取全部已定稿章，后章只取最近 ULTIMATUM_WINDOW 章。
  const recentTail = chapters.slice(-ULTIMATUM_WINDOW)
  const reversal = recentTail.flatMap(chapter => {
    const before = chapters.filter(item => item.chapterNumber < chapter.chapterNumber)
    if (before.length === 0) return []
    return auditAssertionReversals(before, chapter, castNames)
  })

  // 「AI 味」配额（issue #93）：比喻／生理反应／段尾总结／句长。
  // 用的是**起草清单里那套配额原文**，于是起草侧禁的与审稿侧报的是同一件事。
  // 句长这一轴既有**章内**判据（quotaSample，配额是章内的），也有**跨章趋势**
  // （issue #114：单章读不出的单向收敛，需要全量已定稿章当基准序列）。
  const proseFlavor = [
    ...proseFlavorFindings(auditSample, nextChapter, castNames),
    ...proseFlavorDriftFindings(chapters),
  ]

  // 段落起手固定化（issue #94）与物件过手动作固定化（issue #95）：
  // 都是「跨章看同一种写法」的位置轴，与上面几项同一出口。
  // 窗口与登场句同值（16 章）：三者都是段落/动作粒度、都需要跨章分布。
  const positionalAxes = [
    ...findParagraphOpenerFindings({ chapters: chapters.slice(-12), castNames, currentChapter: nextChapter }),
    ...findPropHandoverFindings({ chapters, currentChapter: nextChapter }),
  ]

  // 章级时间推进（第 7 项之上的新增轴，issue #84）：连续多章没有任何跨日交代。
  // 窗口取**全部已定稿章**——「这一段从来没人交代过」本身就是累积证据，
  // 只看最近 12 章反而会把长段的开头切掉、报出「最近 12 章没交代」这种半句话。
  const undatedStreak = findUndatedStreakFindings(chapters, nextChapter)

  // 字形断言（issue #99）：正文里把「X 字」的偏旁说错。单章自洽、逐章可判，
  // 用全量已定稿章（字形是**已定稿只读**的内容，报出来作者才知道哪一章要重写）。
  const glyphRadical = glyphRadicalFindings(chapters)

  // 已登记角色名的同后缀异姓漂移（issue #102）：第 23 章把「陆敬堂」写成「穆敬堂」，
  // 错误已被事实账本继承。用全量已定稿章——名字漂移一旦进账本，越往后越难改，
  // 所以要在预检里点名「哪一章用了哪个写法」。名册由调用方传入。
  const castNameDrift = castNames.length === 0 ? [] : findCastNameDriftFindings({ chapters, castNames })

  // 期限宣告未对账（issue #101）：「只写不读」的期限装置——本书 79 处宣告、0 次到期。
  // 用全量已定稿章：期限的张力就在「下一章还没交代」时最大，报出来才知道哪一章该回头补。
  const deadlineSettlement = findUnsettledDeadlineFindings({ chapters, currentChapter: nextChapter })

  // 同一项不可逆处境变更被宣告两次（issue #105）：第 12 章把「售票口的位置」记为不可逆丧失，
  // 之后 34 章正文里她照常在柜台上，第 47 章又宣告一次。需要**两边证据**——蓝图账本
  // （两次「从此…」）+ 已定稿正文（其间该处境仍反复出现），所以这里同时喂两份。
  const repeatedRevocation = findRepeatedRevocationFindings({
    ledger: blueprints.map(blueprint => ({
      chapterNumber: blueprint.chapterNumber,
      costs: String(blueprint.costsAndTurns ?? ''),
    })),
    prose: chapters,
    castNames,
  })

  // 章节标题「同题加尾」复用（issue #110）：合同侧只判精确同名、且只在新生成那一批生效，
  // 已定稿的旧章节不会再过合同——所以这里用**全书蓝图 title** 再查一遍。
  const duplicateTitles = findDuplicateChapterTitleFindings({
    chapters: blueprints.map(blueprint => ({
      chapterNumber: blueprint.chapterNumber,
      title: String(blueprint.title ?? ''),
    })),
  })

  // 能力触发条件被绕过（issue #100）：限制句从世界观取，绕过形态 = 在受限场地 + 自造条件 +
  // 全书从未写成一次发现。没有世界观就不判。
  const abilityLimitBypass = input.worldbuilding
    ? findAbilityLimitBypassFindings({ worldbuilding: input.worldbuilding, chapters })
    : []

  // 笔迹特征自相矛盾（issue #97）：核心能力是「靠笔迹认人」时，同一个书写者不能有两套特征。
  const handwritingConflicts = castNames.length === 0 ? [] : findHandwritingConflictFindings({ chapters, castNames })

  return [...closingLabel, ...numbering, ...ability, ...repetition, ...undelivered,
    ...ultimatum, ...pendingLanding, ...reversal, ...undatedStreak, ...proseFlavor, ...positionalAxes, ...glyphRadical,
    ...castNameDrift, ...deadlineSettlement, ...repeatedRevocation, ...duplicateTitles,
    ...abilityLimitBypass, ...handwritingConflicts]
}

/**
 * 断言反转（#52）——需要「本章正文」，写前没有，故单独导出、由别的时点调用。
 *
 * 保留在 shared 里是为了与上面 6 项同一个出口：定了稿之后（或审稿时）拿到
 * 本章正文的调用方，可以直接用它复核「本章是否推翻了前面章节的结论」。
 */
export function auditAssertionReversals(
  earlier: readonly FinalizedProseChapter[],
  current: FinalizedProseChapter,
  castNames: readonly string[],
): ConsistencyFinding[] {
  return assertionReversalFindings(earlier, current, castNames)
}