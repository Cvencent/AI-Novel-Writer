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
  findUltimatumStreak,
  findUndeliveredForeshadowing,
  numberingFindings,
} from './consistency-preflight'
import { proseRepetitionFindings } from './prose-repetition'
import { findUndatedStreakFindings } from './chapter-time-anchor'
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
  /** 全书蓝图；收束标注取自 `keyEvents`，伏笔承诺取自 `foreshadowing`。 */
  blueprints: ReadonlyArray<{ chapterNumber: number; keyEvents?: string; foreshadowing?: string }>
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
    }))

  // 通牒式收尾连胜（#66）：只报**尾部**连续段，所以样本取最近几章即可。
  const ultimatum = findUltimatumStreak({
    chapters: chapters.slice(-ULTIMATUM_WINDOW),
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

  // 章级时间推进（第 7 项之上的新增轴，issue #84）：连续多章没有任何跨日交代。
  // 窗口取**全部已定稿章**——「这一段从来没人交代过」本身就是累积证据，
  // 只看最近 12 章反而会把长段的开头切掉、报出「最近 12 章没交代」这种半句话。
  const undatedStreak = findUndatedStreakFindings(chapters, nextChapter)

  return [...closingLabel, ...numbering, ...ability, ...repetition, ...undelivered,
    ...ultimatum, ...reversal, ...undatedStreak]
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