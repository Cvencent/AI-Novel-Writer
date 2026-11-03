/**
 * 全书**引号风格**的一致性（issue #118）。
 *
 * 现象：那本 52 章的书里，前 51 章对白用弯引号 `“…”`，**第 52 章整章改用直角引号 `「…」`**；
 * 起草模板里其实**硬性要求**双引号（`builtin-prompt-templates.ts:871` 与 `:959` 都写了
 * 「所有对话必须使用标准中文双引号」），模型看得见仍然整章违反，而**后面没有任何一道关**。
 *
 * 为什么现有检测器都碰不到它：所有按引号切句/取引文的逻辑（`chapter-ending.ts` 的
 * `closesInsideDialogue`、`prose-flavor.ts` 的 `withoutQuotedDialogue`、`consistency-preflight.ts`
 * 的 `QUOTED_NAME`）都把三套引号**都写进字符类**来兜住——能跑对，但**没有任何一处比较
 * 「本章引号风格是否与全书一致」**。全量 `auditFinalizedProse` 跑本书 28 条 findings 里 0 条与此有关。
 *
 * 判据（**结构性，无词表**）：
 *   - 按**引号对**统计每章的「弯引号对数」与「直角引号对数」（不是字符数——半对也要算准）；
 *   - 全书**多数派**风格 = 覆盖章数多的那一套；
 *   - 某章的对白**几乎全用少数派**（该风格对数 ≥ `QUOTE_STYLE_MIN_PAIRS` 且有对白的章里
 *     少数派占绝大多数）→ 报「本章引号风格与全书不一致」。
 *
 * ⚠️ 边界（本仓 #30/#43/#70 的教训）：**只在整章换风格时报**，不在零星混用时报——
 * 实测那本书「混用（同一章两套并存）= 0 章」，是**整章切换**这种形态；零星出现的直角引号
 * （引用书名、术语）属于正常写法，报了就是噪声。
 * ⚠️ 直角引号也收 `『』`：那本书的蓝图层用过它，且它与 `「」` 同属「直角」这一族。
 */

/** 引号族：弯引号（`“…”`）与直角引号（`「…」`/`『…』`）。**封闭的标点类，不是词表**。 */
export const QUOTE_FAMILIES = Object.freeze([
  { name: 'curly', open: '“', close: '”' },
  { name: 'corner', open: '「『', close: '」』' },
] as const)

export type QuoteFamilyName = (typeof QUOTE_FAMILIES)[number]['name']

/** 一族**完整引号对**的数量（开合配对才算一对；遇到新的开引号前必须有闭引号）。 */
export function countQuotePairs(content: string, family: (typeof QUOTE_FAMILIES)[number]): number {
  const text = String(content ?? '')
  let depth = 0
  let pairs = 0
  for (const character of text) {
    if (family.open.includes(character)) {
      // 上一对没闭合就再开一对：不算一对（宁可少算，不把半对当整对）。
      depth = 1
    } else if (family.close.includes(character) && depth === 1) {
      depth = 0
      pairs += 1
    }
  }
  return pairs
}

/** 一章的引号风格画像。 */
export interface QuoteStyleProfile {
  chapterNumber: number
  curlyPairs: number
  cornerPairs: number
}

export function quoteStyleProfileOf(chapterNumber: number, content: string): QuoteStyleProfile {
  return {
    chapterNumber,
    curlyPairs: countQuotePairs(content, QUOTE_FAMILIES[0]),
    cornerPairs: countQuotePairs(content, QUOTE_FAMILIES[1]),
  }
}

/** 判定「少数派」所需的最少对白对数：低于它不判（半句引文不值得报）。 */
export const QUOTE_STYLE_MIN_PAIRS = 3

export interface QuoteStyleDriftHit {
  /** 全书多数派风格。 */
  majority: QuoteFamilyName
  /** 多数派覆盖的章数。 */
  majorityChapters: number[]
  /** 少数派风格。 */
  minority: QuoteFamilyName
  /** 用少数派风格的章（升序，只含「整章切换」的那些）。 */
  driftedChapters: number[]
}

export function quoteFamilyLabelOf(family: QuoteFamilyName): { zhCN: string, enUS: string } {
  return family === 'curly'
    ? { zhCN: '弯引号（“…”）', enUS: 'curly quotes (“…”)' }
    : { zhCN: '直角引号（「…」/『…』）', enUS: 'corner brackets (“…”/『…』)' }
}

/**
 * 找出「整章换了引号风格」的章（issue #118）。
 *
 * 「整章切换」的定义是：该章有对白（某族对数 ≥ `QUOTE_STYLE_MIN_PAIRS`），
 * 且**另一族的对数 < 该族的一半**——即这一章的对白基本上只用了这一套。
 * 只按**多数派 vs 少数派**报一条（归并成一条 finding，key 不带章号）。
 */
export function findQuoteStyleDrift(chapters: readonly QuoteStyleProfile[]): QuoteStyleDriftHit | null {
  const usable = chapters.filter(item => Number.isSafeInteger(item.chapterNumber))
  if (usable.length < 2) return null
  const curlyChapters = usable.filter(item => item.curlyPairs >= QUOTE_STYLE_MIN_PAIRS).map(item => item.chapterNumber)
  const cornerChapters = usable.filter(item => item.cornerPairs >= QUOTE_STYLE_MIN_PAIRS).map(item => item.chapterNumber)
  // 多数派 = 覆盖章数多的那一套（平手时以弯引号为准——中文出版的主流写法）。
  const majorityIsCurly = curlyChapters.length >= cornerChapters.length
  const majority = majorityIsCurly ? 'curly' : 'corner'
  const minority = majorityIsCurly ? 'corner' : 'curly'
  const majorityChapters = majorityIsCurly ? curlyChapters : cornerChapters
  const minorityChapters = majorityIsCurly ? cornerChapters : curlyChapters
  if (majorityChapters.length === 0 || minorityChapters.length === 0) return null
  // 只在**少数派章很少**（是漂移而不是「两套并行」）时报：占多数派章数 ≥ 一半时不报。
  if (minorityChapters.length * 2 >= majorityChapters.length) return null
  // 「整章切换」：少数派章的少数派对 ≥ 阈值，且该章自己的多数派族几乎没出现。
  const drifted = usable
    .filter(item => {
      const own = majorityIsCurly ? item.cornerPairs : item.curlyPairs
      const other = majorityIsCurly ? item.curlyPairs : item.cornerPairs
      return own >= QUOTE_STYLE_MIN_PAIRS && other * 2 < own
    })
    .map(item => item.chapterNumber)
  if (drifted.length === 0) return null
  return {
    majority, majorityChapters,
    minority, driftedChapters: drifted.sort((left, right) => left - right),
  }
}

/** 引号风格漂移 → 一致性发现（issue #118）。 */
export function findQuoteStyleDriftFindings(
  chapters: ReadonlyArray<{ chapterNumber: number; content: string }>,
): Array<{
  stableFactKey: string
  severity: 'warning'
  sourceChapter: number
  evidence: string
  issue: { zhCN: string; enUS: string }
  suggestion: { zhCN: string; enUS: string }
}> {
  const hit = findQuoteStyleDrift(chapters
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .map(chapter => quoteStyleProfileOf(chapter.chapterNumber, String(chapter.content))))
  if (!hit) return []
  const majorityLabel = quoteFamilyLabelOf(hit.majority)
  const minorityLabel = quoteFamilyLabelOf(hit.minority)
  const driftedList = hit.driftedChapters.join('、')
  return [{
    // key 锚在「哪一种引号风格漂了」上，**不带章号**（#86/#89/#98/#108/#111 的教训：
    // 带章号的 key 会随章滚动，作者点「我已知」永远关不掉）。
    stableFactKey: `quote-style:drift:${hit.minority}`,
    severity: 'warning' as const,
    // 证据落在**漂的那几章**里（issue #79 的口径：不写成正在写的这一章）。
    sourceChapter: hit.driftedChapters[0]!,
    evidence: `第 ${driftedList} 章的对白改用${minorityLabel.zhCN}，而全书其余 ${hit.majorityChapters.length} 章（第 ${hit.majorityChapters[0]}–${hit.majorityChapters[hit.majorityChapters.length - 1]} 章）都用${majorityLabel.zhCN}`,
    issue: {
      zhCN: `第 ${driftedList} 章的对白整章改用**${minorityLabel.zhCN}**，而全书其余 ${hit.majorityChapters.length} 章都用${majorityLabel.zhCN}。同一本书里两套引号风格并存，在成稿排版里是一眼可见的不一致（中文出版物通常全书统一一种引号）；读者读到这里会以为换了本书或文件串行。起草要求本来写明「所有对话必须使用标准中文双引号」，但模型仍可能整章违反——所以这一类需要在落库后核对，而不是只靠提示词。`,
      enUS: `Chapter(s) ${driftedList} switch the whole chapter's dialogue to ${minorityLabel.enUS}, while the other ${hit.majorityChapters.length} chapters use ${majorityLabel.enUS}. Two quote styles coexisting in one book is an obvious inconsistency in the finished typesetting (Chinese publications keep one style throughout), and readers will think the file changed or was mixed up. The drafting instruction does say all dialogue must use standard Chinese double quotes, but the model can still break it for a whole chapter — so this needs a post-save check rather than relying on the prompt alone.`,
    },
    suggestion: {
      zhCN: `把第 ${driftedList} 章的引号改回全书的多数派风格（${majorityLabel.zhCN}）——正文其余部分不用动，只换引号字符。若你确实想全书换成${minorityLabel.zhCN}，那就**整本一起改**（而不是只留这一章），并同步检查章节标题与引文的写法。改完记得让这一步进导出的归一化，避免以后又被模型换回去。`,
      enUS: `Change the quotes in chapter(s) ${driftedList} back to the book's majority style (${majorityLabel.enUS}) — nothing else in the prose needs to change, only the quote characters. If you genuinely want ${minorityLabel.enUS} throughout, convert the whole book (not just this chapter) and check titles and quotations at the same time. Then make this part of export normalisation so the model cannot switch it back later.`,
    },
  }]
}