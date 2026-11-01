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

function factCategory(statement: string): FinalizedContinuityFactCategory {
  if (/(?:角色|状态|持有|受伤|位于|死亡|身亡|牺牲|去世|character|holds?|injur|location|dead|died|deceased)/iu.test(statement)) return 'character-state'
  if (/(?:时间|当日|翌日|多年|之前|之后|timeline|before|after|years?)/iu.test(statement)) return 'timeline'
  if (/(?:伏笔|悬念|承诺|未解|线索|promise|unresolved|clue|mystery)/iu.test(statement)) return 'open-thread'
  return 'plot'
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

function evidenceExcerpt(content: string, statement: string, entities: readonly string[]): string {
  const sentences = content
    .split(/(?<=[。！？.!?])|\n+/u)
    .map(sentence => sentence.trim())
    .filter(Boolean)
  const factEntities = entities.filter(entity => statement.includes(entity))
  const statementWithoutEntities = [...factEntities]
    .sort((left, right) => right.length - left.length)
    .reduce((text, entity) => text.split(entity).join(' '), statement)
  const signals = textBigrams(statementWithoutEntities)
  const signalList = [...signals]
  const candidates = factEntities.length > 0
    ? sentences.filter(sentence => factEntities.some(entity => sentence.includes(entity)))
    : sentences
  const ranked = candidates
    .map((sentence) => {
      const sentenceSignals = textBigrams(sentence)
      const matchedIndexes = signalList
        .map((signal, index) => sentenceSignals.has(signal) ? index : -1)
        .filter(index => index >= 0)
      const independentlySupported = matchedIndexes.some((index, matchIndex) => (
        matchIndex > 0 && index - matchedIndexes[matchIndex - 1] > 1
      ))
      return {
        sentence,
        score: matchedIndexes.length,
        supported: matchedIndexes.length === signalList.length || independentlySupported,
      }
    })
    .sort((left, right) => right.score - left.score)
  const minimumScore = factEntities.length > 0 ? 1 : 2
  const matched = ranked.find(candidate => candidate.score >= minimumScore && candidate.supported)?.sentence
  return matched ?? ''
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
  const facts = statements.flatMap(statement => {
    const factEntities = entities.filter(entity => statement.includes(entity)).slice(0, 8)
    const evidence = evidenceExcerpt(finalizedContent, statement, factEntities)
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
  return dedupeContinuityFacts(facts).slice(0, CONTINUITY_FACT_LIMIT)
}