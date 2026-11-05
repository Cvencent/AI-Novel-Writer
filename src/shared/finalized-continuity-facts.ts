import type { FinalizedCharacterContext, FinalizedContinuityFact, FinalizedContinuityFactCategory } from './finalized-continuity'

const CONTINUITY_FACT_LIMIT = 12

/**
 * 把要点正文切成候选事实条目。
 *
 * 直接按句末标点切会产出三类垃圾（issue #10 实测 12 条里 6 条是碎片）：
 *  1. 引号内的句号（对话「……账？”，温珩……」）把一条完整叙述切成两半，
 *     后半条以收引号 `”` 开头、前言不搭后语；
 *  2. Markdown 表格行（角色动态/伏笔表）整行混进 plot 事实；
 *  3. 碎片占掉 CONTINUITY_FACT_LIMIT 名额，把真正的设定与伏笔挤出账本。
 *
 * 规则：
 *  - 先剥离结构行：标题、表格（含分隔行）、空行——表格是结构化数据，不属于叙事事实；
 *  - 段内只在**引号外**的句末标点处切（逐字符扫描，进出 “…”「…」『…』"…" 时关闭切分）；
 *  - 兜底：仍以收引号/竖线/标点开头的残片并回上一条，不单独占名额。
 */
export function segmentChapterNotes(chapterNotes: string): string[] {
  const segments: string[] = []
  for (const rawLine of chapterNotes.split(/\n+/u)) {
    const line = rawLine.trim()
    if (!line) continue
    // Markdown 结构行：标题、表格行/分隔行。
    if (/^#{1,6}\s/u.test(line) || /^\|/u.test(line)) continue
    let current = ''
    let quoteDepth = 0
    for (const character of line) {
      if ('“「『"'.includes(character)) quoteDepth += 1
      else if ('”」』"'.includes(character)) quoteDepth = Math.max(0, quoteDepth - 1)
      const endsSentence = quoteDepth === 0 && /[。！？.!?]/u.test(character)
      if (endsSentence) {
        const finished = `${current}${character}`.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/u, '').trim()
        if (finished) segments.push(finished)
        current = ''
        continue
      }
      current += character
    }
    const tail = current.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/u, '').trim()
    if (tail) segments.push(tail)
  }
  // 残片兜底：以收引号/竖线/标点开头的段并回上一条（正常情况下引号感知切分不会产生，防御性）。
  const merged: string[] = []
  for (const segment of segments) {
    const isFragment = /^[”』」"’|，、；：!?]/u.test(segment)
    if (isFragment && merged.length > 0) merged[merged.length - 1] += segment
    else merged.push(segment)
  }
  return merged
}

/**
 * 章节要点**行首**的类型标记（issue #148）。
 *
 * 生成章节要点的提示词自己规定了这套标记（`builtin-prompt-templates.ts`：「剧情节点」用
 * `[触发]/[转折]/[结果]`，「伏笔与钩子」用 `[埋]/[钩]`），所以它是**封闭集合**、写在
 * 每一条的最前面——比叙述里碰巧出现的词可靠得多。实测那本书 438 条事实里 296 条带标记。
 *
 * ⚠️ 旧实现只认词（「伏笔」「未解」「线索」），而模型被要求写的是**标记**：两条通道
 * 完全没接上，于是 64 条 `[埋]` + 46 条 `[钩]` 全落成 `plot`，`open-thread` 全书只有 1 条。
 * 而 `open-thread` 是 12 条名额里**优先级最高**的一档（`CATEGORY_PRIORITY`）——
 * 那一档空着，等于每一章都在按一张残缺的权重表砍内容。
 */
const OPEN_THREAD_MARKERS = new Set(['埋', '钩', '伏笔', '悬念', '线索', '未解'])
/** 剧情节点标记：模型对「这一条是情节推进」的声明，不再走下面的词表判断。 */
const PLOT_MARKERS = new Set(['触发', '转折', '结果', '开端', '发展', '收束', '结局'])

/** 取行首标记；没有则返回空串。 */
function leadingMarker(statement: string): string {
  const match = /^\s*[\[【]([^\]】]{1,6})[\]】]/u.exec(String(statement ?? ''))
  return match ? match[1]!.trim() : ''
}

/**
 * 事实分类（issue #148）：**先看结构（行首标记），再看词（兜底）**。
 *
 * 两者是「先后」而不是「二选一」：带标记的按标记定，没带标记的仍按原来的词表判
 * （作者手写的要点、旧版本产物都没有标记）。
 */
/**
 * 记忆回指的形态（**功能类**，不是题材词表）：句子里出现记忆动词。
 *
 * ⚠️ 这一步只判「这一条是不是内部陈述」，**不判「所指的事有没有发生」**——
 * 后者必须读前文，属内容判断，交模型（`memory-anchor-review.ts`）。
 * 现场（#167）：第 78 章账本把「周叙记得…温珩摆手让他别停」当成 `plot` 收下，
 * 下一章起草就拿它当「最近发生的事」摘要注入。
 */
const MEMORY_CALLBACK_MARKER = /(?:记得|想起|回忆起|想起来|记不清|记不得|忘了|忘记)/u

function factCategory(statement: string): FinalizedContinuityFactCategory {
  // ⚠️ 记忆回指优先于行首标记：模型可能给这一条打 `[触发]`，但它的**性质**是回忆。
  if (MEMORY_CALLBACK_MARKER.test(statement)) return 'memory-callback'
  const marker = leadingMarker(statement)
  // ⚠️ 只认**封闭集合**里的标记。例外的方括号（作者自己写的 `[备注]`）原样落到词表兜底，
  // 不要因为「有个方括号」就当成伏笔——那会把未登记标记整类误判。
  if (OPEN_THREAD_MARKERS.has(marker)) return 'open-thread'
  if (PLOT_MARKERS.has(marker)) return 'plot'
  if (/(?:角色|状态|持有|受伤|位于|死亡|身亡|牺牲|去世|character|holds?|injur|location|dead|died|deceased)/iu.test(statement)) return 'character-state'
  if (/(?:时间|当日|翌日|多年|之前|之后|timeline|before|after|years?)/iu.test(statement)) return 'timeline'
  // 兜底词表也认「埋/钩」这一类单字标记之外的写法，但它必须在**没带标记**时才参与。
  if (/(?:伏笔|悬念|承诺|未解|线索|promise|unresolved|clue|mystery)/iu.test(statement)) return 'open-thread'
  return 'plot'
}

/**
 * 分类通道是否断了（issue #148 建议 3）：本章要点里有「伏笔与钩子」一节（非空），
 * 而落库事实里 `open-thread` 一条都没有。
 *
 * 为什么值得自检：`foreshadowing_json` 是另一条独立通道，界面上「伏笔与钩子」一节
 * 会正常显示（那是 `chapter_notes` 原文），所以**分类断链在界面上完全看不见**——
 * 只会表现为「事实账本里没有伏笔」，而作者无从知道该不该有。
 *
 * 返回警告文本（供调用方决定 console.warn 还是落库），没问题时返回 null。
 */
export function continuityCategoryBreakWarning(
  chapterNumber: number,
  chapterNotes: string,
  facts: readonly FinalizedContinuityFact[],
): string | null {
  const notes = String(chapterNotes ?? '')
  const openThreadSection = /##[^\n]*伏笔[^\n]*\n([\s\S]*?)(?:\n##|\n#\s|$)/u.exec(notes)?.[1] ?? ''
  const sectionHasItems = /^\s*(?:[-*•]|\d+[.)、])/mu.test(openThreadSection)
  if (!sectionHasItems) return null
  if (facts.some(fact => fact.category === 'open-thread')) return null
  return `[continuity-facts] chapter ${chapterNumber}: 要点里有「伏笔与钩子」一节，`
    + `但 ${facts.length} 条事实里 open-thread 为 0——分类通道可能断了（检查行首 [埋]/[钩] 标记）`
}

function textBigrams(value: string): Set<string> {
  const groups = value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return new Set(groups.flatMap((group) => {
    const characters = [...group]
    return characters.length < 2
      ? characters
      : characters.slice(0, -1).map((character, index) => character + characters[index + 1])
  }))
}

/**
 * 正文切句（issue #63）：与 `segmentChapterNotes` 同一套**引号感知**切分，只是用在正文上。
 *
 * 旧实现直接按 `(?<=[。！？.!?])|
+` 切，于是「”末页我名字旁边那格多着一个人。」这种
 * **以收引号开头的残片**也会成为候选，被选出来当作「出处」——出处在引号内部被截断了。
 * 这里逐字符扫描：进出 “…”「…」『…』"…" 时关闭切分；仍以收引号/标点开头的残片并回上一条。
 */
export function splitProseSentences(content: string): string[] {
  const parts: string[] = []
  let current = ''
  let quoteDepth = 0
  for (const character of String(content ?? '')) {
    if ('“「『"'.includes(character)) quoteDepth += 1
    else if ('”」』"'.includes(character)) quoteDepth = Math.max(0, quoteDepth - 1)
    if (character === '\n') {
      if (current.trim()) parts.push(current.trim())
      current = ''
      continue
    }
    current += character
    if (quoteDepth === 0 && /[。！？.!?]/u.test(character)) {
      if (current.trim()) parts.push(current.trim())
      current = ''
    }
  }
  if (current.trim()) parts.push(current.trim())
  const merged: string[] = []
  for (const part of parts) {
    const isFragment = /^[”』」"’|，、；：!?]/u.test(part)
    if (isFragment && merged.length > 0) merged[merged.length - 1] += part
    else merged.push(part)
  }
  return merged
}

/**
 * 出处必须真的支撑陈述（issue #63）。
 *
 * 旧实现只要候选句里出现「角色名」就算合格（`minimumScore = 1`），于是
 * 「货舱伙计说短褂先生这两天夜夜在船尾写什么」被当成「夹缝里那截纸边」的出处——
 * 实测 26% 的条目指向了不相干的原文。
 *
 * 现在要求候选句与陈述（去掉角色名后的部分）共享足够多的二元组：
 * 至少 `max(2, 陈述信号数的四分之一)`，且必须是**独立支撑**（命中的信号在陈述里不连续成一段，
 * 否则只是碰巧共享一个短语）。
 */
const EVIDENCE_OVERLAP_FLOOR = 0.25
const EVIDENCE_MIN_MATCHED = 2
/** 覆盖率高于这个比例时不再要求「信号有间隔」：等长引文只差句首语气字也是同一句。 */
const EVIDENCE_COVERAGE_HIGH = 0.75

/**
 * 挑一句正文原句作为出处。
 *
 * `used` 用于**同章内不得复用同一句**（issue #63：旧实现 36% 的 evidence 在同章内重复，
 * 一句话被当成三条不同事实的出处）。优先选未被用过的句子；确实找不到就留空——
 * 出处不可定位的条目不该假装有出处（留空后该条不会成为事实，见 buildFinalizedContinuityFacts）。
 */
function evidenceExcerpt(content: string, statement: string, entities: readonly string[], used?: ReadonlySet<string>): string {
  const sentences = splitProseSentences(content)
  const factEntities = entities.filter(entity => statement.includes(entity))
  const statementWithoutEntities = [...factEntities]
    .sort((left, right) => right.length - left.length)
    .reduce((text, entity) => text.split(entity).join(' '), statement)
  const signals = textBigrams(statementWithoutEntities)
  const signalList = [...signals]
  const overlapFloor = Math.max(EVIDENCE_MIN_MATCHED, Math.ceil(signals.size * EVIDENCE_OVERLAP_FLOOR))
  // 同章内已经被别的陈述用掉的句子直接排除（issue #63）：出处一栏必须能反查，
  // 同一句话当多条事实的出处等于没有出处。找不到未用过的句子时宁可留空（该条不进事实）。
  const available = used ? sentences.filter(sentence => !used.has(sentence)) : sentences
  /**
   * 候选池**不再按角色名硬筛**（issue #76）。
   *
   * #63 收紧判据时用的是「只要陈述里出现角色名，候选池就只保留含该角色名的句子」。
   * 但中文小说最要紧的那句常常是**台词或省略主语的短句**，里面没有角色名：
   *
   *   陈述：邵德昌主张"手写原件有次级效力"……最终收手，说"同批的，都下船"
   *   正文：「手写原件有次级效力。这一格，得我们签。」   ← 16/38 信号，唯一合格的一句
   *        邵德昌两根手指压在页边。                      ← 0/38，含角色名
   *
   * 合格那句因为不含角色名被提前排除，于是整章 27 条要点只落库 1 条
   * （把角色名换成人称代词后立刻涨到 9 条，说明限制来自这道硬筛而不是重叠阈值）。
   *
   * 现在改成**两级**：含角色名的句子优先（更可能切题），一条都不合格时回退到全句池。
   * 两级都必须过同一套重叠/独立支撑判据——放宽的只是池子，不是标准。
   */
  const scoreSentence = (sentence: string) => {
      const sentenceSignals = textBigrams(sentence)
      const matchedIndexes = signalList
        .map((signal, index) => sentenceSignals.has(signal) ? index : -1)
        .filter(index => index >= 0)
      // 「独立支撑」= 命中的信号在陈述里不是连续挤在一处（否则只是碰巧共享一个短语）。
      const independentlySupported = matchedIndexes.some((index, matchIndex) => (
        matchIndex > 0 && index - matchedIndexes[matchIndex - 1] > 1
      ))
      // 覆盖面够高（≥ 3/4）同样算支撑：等长引文的唯一差别常常是句首一个语气字
      // （「周叙问“…”」里角色名被剥掉后只剩一个「问」），旧判据会因此整条丢弃。
      const coverage = signalList.length === 0 ? 0 : matchedIndexes.length / signalList.length
      return {
        sentence,
        score: matchedIndexes.length,
        supported: matchedIndexes.length === signalList.length || coverage >= EVIDENCE_COVERAGE_HIGH || independentlySupported,
      }
    }
  const qualifies = (candidate: { score: number; supported: boolean }) => (
    candidate.score >= overlapFloor && candidate.supported && candidate.score >= EVIDENCE_MIN_MATCHED
  )
  const pickBest = (pool: readonly string[]): string => {
    const ranked = pool.map(scoreSentence).sort((left, right) => right.score - left.score)
    return ranked.find(qualifies)?.sentence ?? ''
  }
  const entityPool = factEntities.length > 0
    ? available.filter(sentence => factEntities.some(entity => sentence.includes(entity)))
    : available
  const preferred = pickBest(entityPool)
  if (preferred) return preferred
  // 回退：含角色名的句子一条都不合格时，允许用不含角色名的句子（issue #76）。
  // 已经是同一个池子时不必重复排一遍。
  return entityPool.length === available.length ? '' : pickBest(available)
}

/**
 * 近重复判据（issue #41）：同一件事常被拆成多条记录——「本章目标」「转折与代价」「伏笔」
 * 各写一遍，`slice(0, 12)` 之前没有人比较过它们是否在说同一件事，12 条名额被同一事件占多次，
 * 真正独特的设定／伏笔／道具交接反而被截掉（实测第 9、10 章都是「刚好 12 条」且至少 5 对高度重合）。
 *
 * 判据用**二元组包含度**：较小一方至少 DUPLICATE_MIN_BIGRAMS 个二元组，且重合占比 ≥ 0.66。
 * 用「包含度」而不是 Jaccard，是因为近重复的典型形态是「一条短摘要 + 一条长叙述」——
 * Jaccard 会被长度差稀释，包含度才抓得住。
 */
const DUPLICATE_CONTAINMENT = 0.66
const DUPLICATE_MIN_BIGRAMS = 6

/** 类别优先级：伏笔／角色状态／时间线比泛泛的 plot 陈述更值得占名额（issue #41 建议 2）。 */
const CATEGORY_PRIORITY: Record<FinalizedContinuityFactCategory, number> = {
  'open-thread': 0,
  'character-state': 1,
  timeline: 2,
  // 记忆回指排在最末：它是「人物以为发生过什么」，比泛泛的情节陈述更**不该**占
  // 起草前摘要的名额（issue #167：一条没发生过的回忆被当成最近事件注入）。
  'memory-callback': 4,
  plot: 3,
}

function containmentOf(left: Set<string>, right: Set<string>): number {
  const smaller = Math.min(left.size, right.size)
  if (smaller < DUPLICATE_MIN_BIGRAMS) return 0
  let shared = 0
  for (const gram of left) if (right.has(gram)) shared += 1
  return shared / smaller
}

/**
 * 数字是判别性信息：「登记了七个编号」与「登记了八个编号」意思相反，
 * 只差一个数字的句子按二元组算重合度很高，但绝不能合并。
 * 只在**两边都有数字**且数字集合不同的时候否决合并；序号（「第二次」「第 7 份」）不算——
 * 那是叙述顺序，不是事实内容（否则「第 2 次催缴……九十九格」与「九十九格……」会被判成不同）。
 */
function numeralsDiffer(left: string, right: string): boolean {
  const numerals = (value: string) => new Set(
    [...value.matchAll(/(?<!第)(\d+|[零一二三四五六七八九十百千万]+)/gu)].map(match => match[1]),
  )
  const leftNumerals = numerals(left), rightNumerals = numerals(right)
  if (!leftNumerals.size || !rightNumerals.size) return false
  if (leftNumerals.size !== rightNumerals.size) return true
  for (const numeral of leftNumerals) if (!rightNumerals.has(numeral)) return true
  return false
}

/**
 * 去掉「同一件事说了好几遍」的事实（issue #41）。
 *
 * - 只与**已保留**的条目比较，保持原有先后顺序（账本顺序是作者读到的顺序）；
 * - 命中近重复时二选一：类别更硬者优先（伏笔 > 角色状态 > 时间线 > 情节），
 *   同类别保留更长（信息更完整）的那条；被替换的槽位沿用原位置。
 */
export function dedupeContinuityFacts(facts: readonly FinalizedContinuityFact[]): FinalizedContinuityFact[] {
  const kept: FinalizedContinuityFact[] = []
  const keptBigrams: Set<string>[] = []
  for (const fact of facts) {
    const bigrams = textBigrams(fact.statement)
    const duplicateIndex = kept.findIndex((existing, index) => (
      containmentOf(bigrams, keptBigrams[index]!) >= DUPLICATE_CONTAINMENT
      && !numeralsDiffer(fact.statement, existing.statement)
    ))
    if (duplicateIndex < 0) {
      kept.push(fact)
      keptBigrams.push(bigrams)
      continue
    }
    const existing = kept[duplicateIndex]!
    const preferred = CATEGORY_PRIORITY[fact.category] < CATEGORY_PRIORITY[existing.category]
      || (CATEGORY_PRIORITY[fact.category] === CATEGORY_PRIORITY[existing.category]
        && fact.statement.length > existing.statement.length)
    if (!preferred) continue
    kept[duplicateIndex] = fact
    keptBigrams[duplicateIndex] = bigrams
  }
  return kept
}

export function buildFinalizedContinuityFacts(
  chapterNumber: number,
  chapterNotes: string,
  finalizedContent: string,
  chapterEntities: readonly string[] = [],
  identityContext?: FinalizedCharacterContext,
): FinalizedContinuityFact[] {
  const entities = [...new Set([...chapterEntities, ...(identityContext?.characters.map(item => item.displayNameSnapshot) ?? [])].map(entity => entity.trim()).filter(Boolean))]
  const statements = segmentChapterNotes(chapterNotes)
  // 同一章内一句正文不得被复用为多条事实的出处（issue #63）：36% 的 evidence 曾重复。
  const usedEvidence = new Set<string>()
  const facts = statements.flatMap(statement => {
    const factEntities = entities.filter(entity => statement.includes(entity)).slice(0, 8)
    const evidence = evidenceExcerpt(finalizedContent, statement, factEntities, usedEvidence)
    if (evidence) usedEvidence.add(evidence)
    const characterRefs = identityContext ? factEntities.flatMap(entity => {
      const candidates = identityContext.characters.filter(item => item.displayNameSnapshot === entity)
      return candidates.length === 1 ? [{ characterId: candidates[0].characterId, displayNameSnapshot: candidates[0].displayNameSnapshot }] : []
    }) : undefined
    if (identityContext && factEntities.some(entity => identityContext.characters.filter(item => item.displayNameSnapshot === entity).length > 1)) return []
    return evidence
      ? [{
          category: factCategory(statement),
          entities: factEntities,
          statement,
          sourceChapter: chapterNumber,
          evidence,
          ...(characterRefs ? { characterRefs } : {}),
        }]
      : []
  })
  // 先去重再截断（issue #41）：重复项占满 12 条名额会把真正独特的事实挤出去。
  const kept = dedupeContinuityFacts(facts).slice(0, CONTINUITY_FACT_LIMIT)
  // 丢弃要留痕（issue #76）：实测第 14 章 27 条要点只剩 1 条，而全链路没有任何提示——
  // 作者只会觉得「这一章账本怎么这么少」。大比例丢弃时记一条 warn，
  // 让这类问题在下一次排查时看得见（界面侧的计数不在本函数职责内）。
  if (statements.length >= 8 && kept.length * 4 <= statements.length) {
    console.warn(
      `[continuity-facts] chapter ${chapterNumber}: ${statements.length} statements -> ${kept.length} facts`
      + ` (${facts.length} had evidence before dedupe/limit); check whether the prose really supports them`,
    )
  }
  // 分类断链要留痕（issue #148 建议 3）：界面上「伏笔与钩子」一节照常显示（那是要点原文），
  // 所以「伏笔一条都没进账本」在界面上完全看不见——不 warn 就永远查不到。
  const categoryBreak = continuityCategoryBreakWarning(chapterNumber, chapterNotes, kept)
  if (categoryBreak) console.warn(categoryBreak)
  return kept
}
/**
 * **存量事实的重新分类**（issue #173）。
 *
 * ## 现场
 *
 * `#148` 修好的是**判据**（`factCategory` 认得 `[埋]`/`[钩]` 了），但**分类是在落库那一刻
 * 算一次并写死的**，之后再没有任何地方重算。于是：
 *
 * ```
 * ch 1: [埋]/[钩] 2 条 → category = plot
 * ...
 * ch23: 全部 plot
 * ch25: 3 条 → open-thread      ← 只有修好之后写的那一章是对的
 * ```
 *
 * 全库 215 条事实里 209 条是 `plot`，而 `[埋]`/`[钩]` 共 52 条本该全是 `open-thread`。
 * `open-thread` 在 `CATEGORY_PRIORITY` 里排**最高档**（占起草前 12 条名额），
 * 被标成 `plot` 就等于那 52 条伏笔永远抢不到名额；`continuityCategoryBreakWarning`
 * 也因此从 1.5.135 起一直在误响（它警告的「分类断链」早就不存在了，只是数据没重算）。
 *
 * 这与 #125 的结论同形：「修复已生效」≠「问题不存在」，要分**根因**（已修）与
 * **存量**（不自愈）。
 *
 * ## 为什么是「重算 category」而不是「读取时重算」
 *
 * `category` 已经落库，且**有一处读取路径直接用它的值**：
 * `writing-intelligence-repository.ts:175` 把它映射成 `kind` 交给下游。
 * 改成读取时算会**悄悄改变已有下游数据**（那是另一类风险），而重算通道只动 `category`
 * 一个字段、可计数、可回退。
 *
 * ## 三条约束（issue 建议 ①）
 *
 * - **只改 `category`**：`statement` / `evidence` / `sourceChapter` 一个字节都不动
 *   （那几列已落库，动了会撞 #159 那类哈希问题）；
 * - **可计数**：返回「改了几条、从什么改成什么」，供作者在界面上先看差异；
 * - **幂等**：对已经正确的数据再跑一次，返回 0 条改动。
 */
export interface FactRecategorization {
  /** 需要改的那几条（原对象 + 新分类）；调用方据此写库并展示差异。 */
  changes: Array<{ fact: FinalizedContinuityFact, nextCategory: FinalizedContinuityFactCategory }>
  /** 从 → 到 的计数，例如 `{ 'plot→open-thread': 29 }`。 */
  counts: Record<string, number>
}

export function recategorizeFinalizedFacts(
  facts: readonly FinalizedContinuityFact[],
): FactRecategorization {
  const changes: FactRecategorization['changes'] = []
  const counts: Record<string, number> = {}
  for (const fact of facts) {
    const statement = String(fact.statement ?? '')
    if (!statement.trim()) continue
    const nextCategory = factCategory(statement)
    if (nextCategory === fact.category) continue
    changes.push({ fact, nextCategory })
    const key = `${fact.category}→${nextCategory}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return { changes, counts }
}

/** 把重算结果写成新的 facts 数组（只换 `category`，其余字段原样）。 */
export function applyFactRecategorization(
  facts: readonly FinalizedContinuityFact[],
  plan: FactRecategorization,
): FinalizedContinuityFact[] {
  const nextByStatement = new Map(plan.changes.map(change => [change.fact, change.nextCategory]))
  return facts.map(fact => {
    const nextCategory = nextByStatement.get(fact)
    return nextCategory === undefined || nextCategory === fact.category ? fact : { ...fact, category: nextCategory }
  })
}
