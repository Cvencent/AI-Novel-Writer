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
 *   8. 「AI 味」配额（#93）——比喻／生理反应／段尾总结（句长配额已按 issue #227 下线）
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
 *  20. 引号风格漂移（#118）——某章整章换了引号（“…” ↔ 「…」），与全书多数派不一致
 *  21. 陈旧状态时长（#115）——同一件事的用时在相邻章用了互斥的尺度（第 11 章「空了三天」→ 第 12 章「一个多月」仍说「三天」）
 *  22. 道具收进容器后容器离开、它又回到身上（#113）——位置换了却没有交接动作
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
  assertionReversalFindings,
  findClosingLabelConflicts,
  findPendingLandingConvergence,
  findUltimatumStreak,
  findUndeliveredForeshadowing,
  numberingFindings,
  declaredCharacterCountFindings,
} from './consistency-preflight'
// 「AI 味」的可机器判子集（issue #93）：超配额、段尾总结腔（句长按 issue #227 下线）。
// 文风判据拆成两半（用户 2026-11-05：内容判断交模型）：
// 句长是**形式**，留在这里；比喻/生理套话/段尾总结/意象是**内容**，交模型（见 prose-style-review.ts）。
// 段落起手（#94）与物件过手（#95）：同一类「跨章看同一种写法」的位置轴补位。
import { findOrdinalRegressionFindings, findTimeAnchorSelfContradictions, findUndatedStreakFindings, findUnmetTimeAnchorFindings } from './chapter-time-anchor'
// 字形断言（#99）：正文里「半个 X 字，Y 旁」把偏旁说错——单章可判，且是最容易机器判的一类。
import { glyphRadicalFindings } from './glyph-radical'
// 已登记角色名的同后缀异姓漂移（#102）：正文把「陆敬堂」写成「穆敬堂」。
import { findCastNameDriftFindings } from './cast-name-drift'
// 期限宣告未对账（#101）：期限「只写不读」——宣告了但下一章整章不再提。
// 同一项不可逆处境变更被宣告两次（#105）：账本记两遍、第一次从未落地。
import { findRepeatedRevocationFindings } from './repeated-revocation'
// 章节标题「同题加尾」复用（#110）：合同只判精确同名、且只管新生成的那一批。
import { findDuplicateChapterTitleFindings } from './chapter-title-uniqueness'
// 引号风格漂移（issue #118）：某章整章换了引号，与全书多数派不一致。
import { findQuoteStyleDriftFindings } from './quote-style'
// 陈旧状态时长（issue #115）：同一件事的「过了多久」在相邻章用了互斥的尺度。
// 道具收进容器→容器离开→又回到身上（issue #113）：位置换了却没有交接动作。
// 能力触发条件被绕过（#100）：世界观写死的硬限制在正文里被静默绕过、从未写成一次发现。
// 笔迹特征自相矛盾（#97）：同一个书写者被写成两套互斥特征（「稳、匀」vs「横折收得急」）。
// 清单件数对账（#133）：声明 N 件却只列/兑现 M 件。同章枚举 + 跨章清单两条。
import { findEnumerationCountMismatches, findInventoryShortfallFindings } from './inventory-count'
// 量具读数与换算（#136）：同一套刻度被写成两套比值。
import { findGaugeScaleMismatches } from './gauge-scale'
// 整句逐字跨章复用（#140）：与三族词表正交的字面比对。
import { findRepeatedSentenceFindings, findShortSentenceReuseFindings } from './repeated-sentence'
import { findUnreconcilableAgeFindings } from './character-age-ledger'
// 口头约定被复述反了（#142）：承诺句的极性比对。
// 标题点到的人本章没出场（#144）：标题与本章正文/蓝图比对。
import { findTitleBodyMismatchFindings } from './title-body-mismatch'
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

  const auditWindow = input.auditWindow ?? DEFAULT_AUDIT_WINDOW
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

  // 编号位数（#47）：单章自洽，逐章跑。
  const numbering = auditSample.flatMap(chapter => numberingFindings({
    chapterNumber: chapter.chapterNumber, content: chapter.content,
  }))
  // 能力上限（#51）原先是「用尽声明 + 成功使用」两张词表，按用户 2026-11-05 的定规
  // 已改由模型判（`ability-review.ts` 的第二类 `exhausted-then-reused`），作者主动触发。
  const ability: ConsistencyFinding[] = []
  // 自报「N 个字」与引出的实体不符（issue #131）：与编号位数同族，单章自洽，逐章跑。
  const declaredCount = auditSample.flatMap(chapter => declaredCharacterCountFindings({
    chapterNumber: chapter.chapterNumber, content: chapter.content,
  }))

  // 正文层跨章重复（#32/#33/#49）：原先是三族**短语表**（没动/没答/下舱底/蹲…）。
  // 用户 2026-11-05：内容判断不许词表 → 已改成模型判据（`content-review.ts`，
  // 轴 `repeated-reaction` / `repeated-device`），由作者在预检里主动触发。
  // 这里不再产出：规则侧不再对「这句话在说什么」下断言。
  const repetition: ConsistencyFinding[] = []

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

  // 「AI 味」配额（issue #93）：比喻／生理反应／段尾总结——已全部交模型判
  // （`prose-style-review.ts`，作者主动触发）。句长配额按用户 2026-11-06 定规
  // **全部下线**（issue #227）：「模型想怎么写怎么写」，多长算合适是文风判断，
  // 不归产品——上限/下限/跨章漂移三族判据与起草清单里的双边规则一并删除。
  const proseFlavor: ConsistencyFinding[] = []

  // 段落起手固定化（issue #94）与物件过手动作固定化（issue #95）：
  // 都是「跨章看同一种写法」的位置轴，与上面几项同一出口。
  // 窗口与登场句同值（16 章）：三者都是段落/动作粒度、都需要跨章分布。
  const positionalAxes: ConsistencyFinding[] = [
    // 段落起手固定化（#94）、物件过手动作固定化（#95）、道具换容器（#113）、
    // 陈旧时长（#115）：原先是题材短语表/动作表，已改由模型判（`content-review.ts` 的
    // `repeated-device` / `prop-moved` / `stale-duration` 轴），作者主动触发。
  ]

  // 章级时间推进（第 7 项之上的新增轴，issue #84）：连续多章没有任何跨日交代。
  // 窗口取**全部已定稿章**——「这一段从来没人交代过」本身就是累积证据，
  // 只看最近 12 章反而会把长段的开头切掉、报出「最近 12 章没交代」这种半句话。
  const undatedStreak = findUndatedStreakFindings(chapters, nextChapter)

  // 「蓝图声明了跨日、正文一字未提」（issue #132）：与上面那条**互不替代**——
  // 连胜判据按「连续 N 章」聚合，会把「有声明没落实」的章一并吞掉；
  // 这一条逐章比两侧（标注原文 vs 本章正文），提示直接指向要改的那一句。
  const blueprintByChapter = new Map(blueprints.map(item => [item.chapterNumber, item.keyEvents ?? '']))
  const timeAnchoredChapters = chapters.map(chapter => ({
    chapterNumber: chapter.chapterNumber, content: chapter.content,
    keyEvents: blueprintByChapter.get(chapter.chapterNumber) ?? '',
  }))
  const unmetTimeAnchor = findUnmetTimeAnchorFindings(timeAnchoredChapters)
  // 蓝图【时点】**自身**自相矛盾（#147 建议 3）：「第三天午后（紧接上一章）」——
  // 括注与日序不能同时成立。这类要先在蓝图侧定下来，否则起草无论怎么写都有一半错，
  // 也不该拿它去要求正文补日界。
  const timeAnchorSelfContradiction = findTimeAnchorSelfContradictions(timeAnchoredChapters)
  /**
   * 全书日序回退（issue #202）：本章标的日序比前面已经写到的那一天更早。
   * 与上面两条**正交**——不依赖括注、不依赖相邻，只比大小；删掉括注也看得见
   * （现场第 89 章把「紧接第88章次日」删掉后，自证矛盾那条 0 条，这条仍在）。
   */
  const ordinalRegression = findOrdinalRegressionFindings(timeAnchoredChapters)
  // 正文层年龄账本（issue #149）：本章写了年龄、却一处都归不到在册角色 → 这条年龄没有任何落点。
  // 用全量已定稿章：年龄声明稀疏（实测 69 章只有 2 处），窗口切小会把它们切出样本。
  const unreconcilableAge = findUnreconcilableAgeFindings(chapters, castNames)

  // 字形断言（issue #99）：正文里把「X 字」的偏旁说错。单章自洽、逐章可判，
  // 用全量已定稿章（字形是**已定稿只读**的内容，报出来作者才知道哪一章要重写）。
  const glyphRadical = glyphRadicalFindings(chapters)

  // 已登记角色名的同后缀异姓漂移（issue #102）：第 23 章把「陆敬堂」写成「穆敬堂」，
  // 错误已被事实账本继承。用全量已定稿章——名字漂移一旦进账本，越往后越难改，
  // 所以要在预检里点名「哪一章用了哪个写法」。名册由调用方传入。
  const castNameDrift = castNames.length === 0 ? [] : findCastNameDriftFindings({ chapters, castNames })

  // 期限宣告未对账（issue #101 / #163）：原先靠四张题材措辞表（天亮前/日落前/明早… +
  // 不许/别想/扣下… + 期限已过/逾期…）判，按用户 2026-11-05 的定规（内容判断不许词表、
  // 不许短语匹配）已改由模型判（deadline-review.ts + reviewDeadlines，作者主动触发）。
  // 「这句是不是期限、下一章有没有结算它」要读懂句子，不是位置判据。
  const deadlineSettlement: ConsistencyFinding[] = []

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

  // 能力触发条件被绕过（issue #100）：原先是 12 条**本书专属场所**的正则
  // （账房|售票亭|柜台|铺子…）+ 本书的能力表现（墨浮上来）。按用户 2026-11-05 的规则
  // 已改由模型判（`ability-review.ts` + `reviewAbilityLimits`），由作者主动触发。
  const abilityLimitBypass: ConsistencyFinding[] = []

  // 笔迹特征自相矛盾（issue #97 / #163）：原先靠四张书写质量词表（稳匀/急促/重笔/轻笔）
  // 判，按用户 2026-11-05 的定规（内容判断不许词表、不许短语匹配）已改由模型判
  // （`handwriting-review.ts` + `reviewHandwritingTraits`，作者主动触发）。
  // 判「这笔字什么质量」要读懂句子，不是位置/分布判据，所以不走这条自动审计。
  const handwritingConflicts: ConsistencyFinding[] = []

  // 引号风格漂移（issue #118）：某章整章换了引号（弯引号“…” ↔ 直角引号「…」）。
  // 起草要求写明「所有对话必须使用标准中文双引号」，模型仍可能整章违反——
  // 现有检测器都把三套引号写进字符类来兜住，**没有一处比较「本章风格是否与全书一致」**。
  // 用全量已定稿章（判据要按全书多数派归一）。
  const quoteStyleDrift = findQuoteStyleDriftFindings(chapters)

  // 陈旧状态时长（issue #115）：第 11 章「铺位空了三天」→ 第 12 章「重抄后一个多月」仍说「空了三天」。
  // 现有 `undated` 判的是「有没有交代跨日」，第 12 章写了「一个多月」恰好**达标**、躲过检查。
  const staleStateDuration: ConsistencyFinding[] = []

  // 道具位置断裂（issue #113）：第 14 章「纸角」收进册子衬页、册子被抽走，第 17/18 章它又在内衬里。
  // 需要名册（排除人名被当道具，同 #80）。
  const propContainerDeparture: ConsistencyFinding[] = []
  // 清单件数（#133）：同章「N 样…：A；B；C」项数不符 + 跨章清单合计与兑现项数不符。
  // 用全量已定稿章：清单与兑现常常跨章，窗口切小会把清单切出样本。
  const inventorySameChapter = auditSample.flatMap(chapter => findEnumerationCountMismatches(chapter))
  const inventoryShortfall = findInventoryShortfallFindings(chapters)
  // 量具换算（#136）：用全量已定稿章——换算句在远处、读数在近处，窗口切小会漏配。
  const gaugeScale = findGaugeScaleMismatches(chapters)
  // 整句复用（#140）：用全量已定稿章（相邻窗口在判据内部收，样本切小会漏掉首现章）。
  const repeatedSentences = findRepeatedSentenceFindings(chapters)
  // 短叙述句跨章复用（#145）：#140 只管 ≥12 字、相邻 3 章；那本书的「脑子里空了一块」
  // 只有 8 字、跨度 33 章 → 一次都命不中。这一档管 6–11 字的叙述短句，按**分布**判
  // （≥3 章且首末跨度 ≥8）。需要名册排除「人名 + 同一动作」这种正常写法（「周叙没动。」8 章）。
  const shortSentenceReuse = findShortSentenceReuseFindings(chapters, castNames)
  // 承诺极性（#142）：「约定方向被复述反」要读懂句子——按用户 2026-11-05 定规已改由模型判
  // （`promise-polarity-review.ts`，并进审稿深度检查 promise 维度），规则侧不再断言。
  const promiseReversals: ConsistencyFinding[] = []
  // 标题与本章比对（#144）：把本章蓝图标题接到对应章的正文上。
  const titleByChapter = new Map(blueprints.map(item => [item.chapterNumber, String(item.title ?? '')]))
  const keyEventsByChapter = new Map(blueprints.map(item => [item.chapterNumber, String(item.keyEvents ?? '')]))
  const titleMismatches = findTitleBodyMismatchFindings(chapters.map(chapter => ({
    chapterNumber: chapter.chapterNumber,
    title: titleByChapter.get(chapter.chapterNumber) ?? '',
    content: chapter.content,
    keyEvents: keyEventsByChapter.get(chapter.chapterNumber) ?? '',
    castNames,
  })))

  const findings: ConsistencyFinding[] = [...closingLabel, ...numbering, ...ability, ...declaredCount, ...repetition, ...undelivered,
    ...ultimatum, ...pendingLanding, ...reversal, ...undatedStreak, ...unmetTimeAnchor, ...timeAnchorSelfContradiction, ...ordinalRegression, ...unreconcilableAge, ...proseFlavor, ...positionalAxes, ...glyphRadical,
    ...castNameDrift, ...deadlineSettlement, ...repeatedRevocation, ...duplicateTitles,
    ...abilityLimitBypass, ...handwritingConflicts, ...quoteStyleDrift, ...staleStateDuration,
    ...propContainerDeparture, ...inventorySameChapter, ...inventoryShortfall, ...gaugeScale,
    ...repeatedSentences, ...shortSentenceReuse, ...promiseReversals, ...titleMismatches]
  // 「同一批 findings 的 key 必须唯一」（issue #164 建议 ③）。这条守卫很便宜，且覆盖所有判据族：
  // #153 的洞二（同章同部位两条 → 同 key → ack 埋掉没修的那条）与本条的洞一洞二都是它该抓的。
  // ⚠️ 这里不「去重」而是**报出来**：去重会静默吞掉一条内容不同的提醒，
  // 正确的修法在各自的判据侧（合并同章同轴的证据，例如 `contentReviewFindings`）。
  const seen = new Set<string>()
  const duplicated: string[] = []
  for (const finding of findings) {
    if (seen.has(finding.stableFactKey)) duplicated.push(finding.stableFactKey)
    seen.add(finding.stableFactKey)
  }
  if (duplicated.length) {
    // 开发期可见：这不是「多一条噪声」，而是 ack 会静默掉没修的那条。
    console.warn('[finalized-prose-audit] duplicate stableFactKey:', [...new Set(duplicated)].join(', '))
  }
  return findings
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