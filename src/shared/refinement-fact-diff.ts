/**
 * 修稿「事实差分」：修稿新增了哪些**前文已确立的专名**（issue #123）。
 *
 * 现场：第 55 章跑「直接修稿」，作者一处都不采纳也能拿到被改过的正文——
 * 修稿把已被对手收进公文包的竹尺挂到了叶九腰里（「叶九站在那儿，竹尺别在腰里」），
 * 而这一步的唯一验收闸只查「格式完整 + 字数不少」（`refinement-completeness.ts`）。
 * 作者要发现它，只能逐段读完 11 处并自己记得第 52 章那把尺在谁包里。
 *
 * 本模块只做一件**能机器判**的事：**修稿里出现了、原稿里没有、而本章蓝图与前文
 * 都已经确立的专名**。它不是判对错，是把「这一处动了事实」摆到作者眼前
 * （issue 建议 1 的「新增实体出现」这一类）。
 *
 * 判据全部是结构性的，不写任何道具/名词表：
 * 1. 候选**从本章蓝图的 keyEvents 里取**——那是本章的权威计划，长度有限、
 *    且不会像「拿修稿全文枚举子串」那样产出成百上千个跨词碎片
 *    （实测：全文字串枚举 33–106 条，其中大半是「底下的」「出一」这类碎片）；
 * 2. 该候选必须**出现在修稿里、且完全不出现在原稿里**；
 * 3. 必须**在 ≥2 章前文正文里出现过**——只此一次的临时词不是「已确立的专名」；
 * 4. 排除纯功能字串（数词/量词/指示词/方位/趋向，与 #122 同一套封闭类）、
 *    以及含在册角色名的片段（那是人名短语，不是道具）；
 * 5. 最长匹配去重（「竹尺裂口」保留，不再单报「裂口」）。
 *
 * 刻意不做的（写在这里，免得下一轮误以为漏了）：
 * - **持有者变更**：需要「谁拿着什么」的账本，本仓还没有（`cs_key_items` 是自由文本、
 *   覆盖面只有 7/7 个角色且多数只写最近一件），做不成可判的判据；
 * - **状态词被删**（issue 的现场②「字都干着，不用蘸水」）：删除句本身在差异视图里
 *   已经可见，而「哪句是审稿结论的前提」需要审稿 finding 的锚点参与，属另一条链。
 */

export interface RefinementFactTerm {
  /** 修稿新增、原稿没有的专名。 */
  term: string
  /** 这个词在本章蓝图 keyEvents 里出现过（候选来源）。 */
  fromBlueprint: true
  /** 前文（已定稿章）里出现过多少章。 */
  historyChapters: number
}

export interface RefinementFactDiffInput {
  /** 修稿生成时冻结的原稿（草稿正文）。 */
  source: string
  /** 修稿正文。 */
  revision: string
  /** 本章蓝图的 keyEvents（含【时点】等标注；标注本身不参与判定）。 */
  blueprintKeyEvents: string
  /** 前文已定稿章正文（按章升序，只含本章之前的章）。 */
  history: readonly string[]
  /** 在册角色名。 */
  castNames?: readonly string[]
  /** 至少出现在多少章前文才算「已确立」。默认 2。 */
  minHistoryChapters?: number
  /** 候选长度上限。默认 6（覆盖「无编号薄本」这类复合专名）。 */
  maxTermChars?: number
}

const HAN_RUN = /[\u4e00-\u9fff]+/gu

/** 纯功能字（与 #122 同一套封闭类）：整串都是这些字时不可能是专名。 */
const FUNCTION_ONLY = new RegExp(
  '^[一二三四五六七八九十百千万亿两半几每各某这那其该此彼'
  + '张条只个块片根截支枝枚颗粒堆串副对双套件桩门页册篇份把'
  + '里中上下内外面边侧底前后左右旁来去过起开回]+$',
  'u',
)

/**
 * 语法功能字（封闭类）：结构助词、体标记、系词、否定、常用副词、介词/连词。
 * 专名里不会含这些字；含了就说明它是句子片段而不是一个名字。
 *
 * 实测这条过滤是本判据精度的关键：不加时「记得」「正是」「明远从」都会被当成
 * 「修稿新增的专名」（前者含结构助词「得」、次者含系词「是」、后者含介词「从」）。
 */
const GRAMMATICAL_CHARS = '的地得了着过是不没也就都还又才只很太更最和与及或但而却因为把被将给对向从到在于以之其那这哪某各每'
/** 代词或数量词开头的一律不是专名（「他一」「这儿」「一开口」）。 */
const PRONOUN_LEAD = /^[我你他她它们这那哪一二三四五六七八九十百千万亿两半几每各某]/u

function isGrammaticalFragment(term: string): boolean {
  if (PRONOUN_LEAD.test(term)) return true
  return [...term].some(character => GRAMMATICAL_CHARS.includes(character))
}

/** 把一段文本切成 2..maxTermChars 的汉字候选（按连续汉字串滑窗）。 */
function hanCandidates(text: string, maxTermChars: number): Set<string> {
  const out = new Set<string>()
  for (const run of text.match(HAN_RUN) ?? []) {
    for (let length = 2; length <= maxTermChars; length += 1) {
      for (let start = 0; start + length <= run.length; start += 1) out.add(run.slice(start, start + length))
    }
  }
  return out
}

function containsCastName(term: string, castNames: readonly string[]): boolean {
  return castNames.some(name => name.length > 0 && (term.includes(name) || name.includes(term)))
}

/**
 * 找出「修稿新增、原稿没有、本章蓝图与前文都已确立」的专名。
 *
 * 返回按「前文章数降序 + 长度降序」排列，供差异视图逐个段落标记。
 */
export function findRefinementFactTerms(input: RefinementFactDiffInput): RefinementFactTerm[] {
  const source = String(input.source ?? '')
  const revision = String(input.revision ?? '')
  const blueprint = String(input.blueprintKeyEvents ?? '')
  if (!source.trim() || !revision.trim() || !blueprint.trim()) return []
  const maxTermChars = input.maxTermChars ?? 6
  const minHistoryChapters = input.minHistoryChapters ?? 2
  const history = (input.history ?? []).map(text => String(text ?? '')).filter(text => text.trim())
  const castNames = (input.castNames ?? []).map(name => String(name ?? '').trim()).filter(Boolean)
  const candidates: RefinementFactTerm[] = []
  for (const term of hanCandidates(blueprint, maxTermChars)) {
    // 原稿里出现过 → 不是修稿新增的，跳过。
    if (source.includes(term)) continue
    // 修稿里没出现 → 与这次修稿无关。
    if (!revision.includes(term)) continue
    if (FUNCTION_ONLY.test(term)) continue
    if (isGrammaticalFragment(term)) continue
    if (containsCastName(term, castNames)) continue
    const historyChapters = history.filter(text => text.includes(term)).length
    if (historyChapters < minHistoryChapters) continue
    candidates.push({ term, fromBlueprint: true, historyChapters })
  }
  // 最长匹配去重：「竹尺裂口」命中后不再单报「裂口」「竹尺」。
  const terms = candidates.map(item => item.term)
  return candidates
    .filter(item => !terms.some(other => other !== item.term && other.includes(item.term)))
    .sort((left, right) => right.historyChapters - left.historyChapters
      || right.term.length - left.term.length
      || left.term.localeCompare(right.term))
}