/**
 * 字形断言核对：正文里「半个 X 字，Y 旁」这类**指认偏旁**的句子（issue #99）。
 *
 * 现象：那本 45 章的悬疑长篇，核心金手指是「溯读」——把票纸按在墨层上读出被覆盖的字，
 * 主角靠**认字**破案，于是「半个字 + 偏旁」是全书最高频的证据形态。但两处关键线索
 * 把汉字的偏旁写错了：
 *
 *   第 45 章：「半个“温”字。左边半边，**立人旁**。」   ← 温 = 氵（三点水）+ 日 + 皿
 *   第 43 章：「先露**走之底**，再往上——徐。」          ← 徐 = 彳（双人旁）+ 余
 *
 * 两处都是该章**唯一的身份判据**：读者跟着主角「认出这是谁」的那一步，靠的就是这个偏旁。
 * 正文出现具体偏旁名的地方全书只有三处，**两处指到具体字的断言，两处都错**。
 *
 * 为什么这是产品侧的问题：事实账本没记（`facts_json` 里 0 命中「立人旁」）、
 * 写前预检 10 项与审稿 5 维都不看字形。而它**恰恰是最容易机器判的一类**——
 * 康熙 214 部首是 1716 年刊定后封闭的数据（`glyph-radical-table.ts`），
 * 断言句式又是一个正则就能抽出来的形状，判据完全不需要模型。
 *
 * 判据刻意做得**窄**（本仓在 #30/#43/#70/#80/#93 反复吃过词表过拟合的亏）：
 *   - 被描述的汉字 X 必须是**引号里的单字**或**紧跟在破折号后**的单字
 *     （正文里只有「正在讨论这个字形」时才会这么写，正常叙述不会）；
 *   - 偏旁名必须是**封闭表的成员**（俗称，如「三点水／立人旁／走之底」）；
 *   - 两者必须落在同一个句子或紧邻句子里；
 *   - 只有**没有任何一个**相邻偏旁名与 X 的实际部首相符时才报（宁漏不误报）。
 */

import { RADICAL_CHARS_BY_INDEX } from './glyph-radical-table'

export interface GlyphRadicalFinding {
  chapterNumber: number
  /** 被描述的字。 */
  character: string
  /** 正文里写的偏旁名（原样）。 */
  claimedName: string
  /** 该字**实际**的康熙部首序号。 */
  actualRadical: number
  /** 该字实际的部首俗称 + 部首原型。 */
  actualLabel: string
  /** 承载这句话的整句，用于证据展示。 */
  excerpt: string
}

/** 一个偏旁俗称在正文里的写法（含部首原型与常见别称）。 */
interface RadicalEntry {
  index: number
  names: readonly string[]
  /** 给人看的「俗称（部首原型）」。 */
  label: string
}

/**
 * 封闭表：偏旁俗称 → 康熙部首序号。
 *
 * 只收**含义唯一**的俗称。「双耳旁」「月字旁」这类一个名字对应两个部的词**刻意不收**：
 * 判据宁可漏掉它们，也不能因为它们报出假阳性（#30 的教训：规则层输出全是假阳性等于零信息）。
 */
const RADICAL_ENTRIES: readonly RadicalEntry[] = [
  { index: 1, names: ['一字旁'], label: '一字旁（一）' },
  { index: 7, names: ['二字旁'], label: '二字旁（二）' },
  { index: 9, names: ['立人旁', '单人旁', '单立人', '立人儿', '人字旁', '单人旁儿'], label: '单人旁（亻）' },
  { index: 18, names: ['立刀旁', '立刀儿'], label: '立刀旁（刂）' },
  { index: 26, names: ['单耳旁', '单耳刀'], label: '单耳旁（卩）' },
  { index: 30, names: ['口字旁', '口字边'], label: '口字旁（口）' },
  { index: 31, names: ['国字框', '大口框', '国字框儿'], label: '国字框（囗）' },
  { index: 32, names: ['土字旁', '提土旁'], label: '提土旁（土）' },
  { index: 37, names: ['大字旁', '大字头'], label: '大字头（大）' },
  { index: 38, names: ['女字旁'], label: '女字旁（女）' },
  { index: 39, names: ['子字旁'], label: '子字旁（子）' },
  { index: 40, names: ['宝盖头', '宝盖儿', '宝盖'], label: '宝盖头（宀）' },
  { index: 41, names: ['寸字旁'], label: '寸字旁（寸）' },
  { index: 42, names: ['小字头'], label: '小字头（小）' },
  { index: 44, names: ['尸字头'], label: '尸字头（尸）' },
  { index: 46, names: ['山字旁', '山字头'], label: '山字旁（山）' },
  { index: 48, names: ['工字旁'], label: '工字旁（工）' },
  { index: 50, names: ['巾字旁'], label: '巾字旁（巾）' },
  { index: 53, names: ['广字头', '广字旁'], label: '广字头（广）' },
  { index: 57, names: ['弓字旁'], label: '弓字旁（弓）' },
  { index: 60, names: ['双人旁', '双立人', '双人旁儿'], label: '双人旁（彳）' },
  { index: 61, names: ['竖心旁', '竖心儿', '心字底'], label: '竖心旁（忄）/ 心字底（心）' },
  { index: 62, names: ['戈字旁'], label: '戈字旁（戈）' },
  { index: 63, names: ['户字头'], label: '户字头（戶）' },
  { index: 64, names: ['提手旁', '提手儿', '手字旁', '手字底'], label: '提手旁（扌）' },
  { index: 66, names: ['反文旁', '反文儿'], label: '反文旁（攵）' },
  { index: 70, names: ['方字旁'], label: '方字旁（方）' },
  { index: 72, names: ['日字旁', '日字头'], label: '日字旁（日）' },
  { index: 75, names: ['木字旁', '木字底'], label: '木字旁（木）' },
  { index: 85, names: ['三点水', '三点水旁', '三点水儿', '水字旁', '水字底'], label: '三点水（氵）' },
  { index: 86, names: ['火字旁', '火字底', '四点底', '四点水', '火字边'], label: '火字旁（火）/ 四点底（灬）' },
  { index: 94, names: ['反犬旁', '反犬儿'], label: '反犬旁（犭）' },
  { index: 96, names: ['王字旁', '斜玉旁', '玉字旁'], label: '王字旁（王）' },
  { index: 104, names: ['病字旁', '病字头', '病字框'], label: '病字旁（疒）' },
  { index: 106, names: ['白字旁'], label: '白字旁（白）' },
  { index: 108, names: ['皿字底'], label: '皿字底（皿）' },
  { index: 109, names: ['目字旁'], label: '目字旁（目）' },
  { index: 112, names: ['石字旁'], label: '石字旁（石）' },
  { index: 113, names: ['示字旁', '示补旁'], label: '示字旁（礻）' },
  { index: 115, names: ['禾木旁', '禾字旁'], label: '禾木旁（禾）' },
  { index: 116, names: ['穴宝盖', '穴宝盖儿'], label: '穴宝盖（穴）' },
  { index: 117, names: ['立字旁'], label: '立字旁（立）' },
  { index: 118, names: ['竹字头', '竹字头儿'], label: '竹字头（⺮）' },
  { index: 119, names: ['米字旁'], label: '米字旁（米）' },
  { index: 120, names: ['绞丝旁', '绞丝儿', '乱绞丝'], label: '绞丝旁（纟）' },
  { index: 123, names: ['羊字旁', '羊字头'], label: '羊字旁（羊）' },
  { index: 124, names: ['羽字旁', '羽字头'], label: '羽字旁（羽）' },
  { index: 128, names: ['耳字旁'], label: '耳字旁（耳）' },
  // 「肉（月）」与「月」同形：俗称「月字旁」两者都可能，**刻意不收**（含义不唯一）。
  { index: 135, names: ['舌字旁'], label: '舌字旁（舌）' },
  { index: 137, names: ['舟字旁'], label: '舟字旁（舟）' },
  { index: 140, names: ['草头', '草字头', '草头儿', '草字头儿'], label: '草字头（艹）' },
  { index: 142, names: ['虫字旁'], label: '虫字旁（虫）' },
  { index: 145, names: ['衣字旁', '衣补旁'], label: '衣字旁（衤）' },
  { index: 149, names: ['言字旁', '言字边', '言字旁儿'], label: '言字旁（讠）' },
  { index: 157, names: ['足字旁', '足字边'], label: '足字旁（足）' },
  { index: 159, names: ['车字旁'], label: '车字旁（车）' },
  { index: 162, names: ['走之底', '走之旁', '走之儿', '走之'], label: '走之底（辶）' },
  { index: 163, names: ['右耳旁', '右耳刀', '右耳'], label: '右耳旁（阝·邑）' },
  { index: 167, names: ['金字旁', '金字边'], label: '金字旁（钅）' },
  { index: 169, names: ['门字框', '门字框儿'], label: '门字框（门）' },
  { index: 170, names: ['左耳旁', '左耳刀', '左耳'], label: '左耳旁（阝·阜）' },
  { index: 173, names: ['雨字头'], label: '雨字头（雨）' },
  { index: 177, names: ['革字旁'], label: '革字旁（革）' },
  { index: 181, names: ['页字旁', '页字边'], label: '页字旁（页）' },
  { index: 184, names: ['食字旁', '食字边'], label: '食字旁（饣）' },
  { index: 187, names: ['马字旁'], label: '马字旁（马）' },
  { index: 188, names: ['骨字旁'], label: '骨字旁（骨）' },
  { index: 194, names: ['鬼字旁'], label: '鬼字旁（鬼）' },
  { index: 195, names: ['鱼字旁'], label: '鱼字旁（鱼）' },
  { index: 196, names: ['鸟字旁', '鸟字边'], label: '鸟字旁（鸟）' },
  { index: 203, names: ['黑字旁'], label: '黑字旁（黑）' },
  { index: 208, names: ['鼠字旁'], label: '鼠字旁（鼠）' },
  { index: 209, names: ['鼻字旁'], label: '鼻字旁（鼻）' },
  { index: 211, names: ['齿字旁'], label: '齿字旁（齿）' },
]

/** 俗称 → 部首序号。同名按**最长优先**匹配（「走之底」不会退化成「走之」以外的误配）。 */
const NAME_TO_RADICAL = new Map<string, RadicalEntry>()
/** 部首序号 → 该部的规范标签（第一条 entry 的 label）。 */
const RADICAL_TO_LABEL = new Map<number, string>()
for (const entry of RADICAL_ENTRIES) {
  for (const name of entry.names) if (!NAME_TO_RADICAL.has(name)) NAME_TO_RADICAL.set(name, entry)
  if (!RADICAL_TO_LABEL.has(entry.index)) RADICAL_TO_LABEL.set(entry.index, entry.label)
}
/** 所有俗称，按长度降序（供扫描时最长优先）。 */
const RADICAL_NAMES_BY_LENGTH = [...NAME_TO_RADICAL.keys()].sort((left, right) => right.length - left.length)

/** 汉字 → 康熙部首序号的惰性索引。 */
let charToRadical: Map<string, number> | null = null
function radicalIndexOf(character: string): number | null {
  if (!charToRadical) {
    charToRadical = new Map()
    RADICAL_CHARS_BY_INDEX.forEach((chars, position) => {
      const index = position + 1
      for (const char of chars) charToRadical!.set(char, index)
    })
  }
  return charToRadical.get(character) ?? null
}

/** 部首序号给人看的标签（俗称表里没有的部退回康熙部首原型）。 */
export function radicalLabelOf(index: number): string {
  const known = RADICAL_TO_LABEL.get(index)
  if (known) return known
  if (index >= 1 && index <= 214) return `第 ${index} 部（${String.fromCodePoint(0x2f00 + index - 1)}）`
  return `第 ${index} 部`
}

/** 一句话里出现的偏旁俗称（最长优先、去重叠）。 */
export function radicalNamesIn(text: string): Array<{ name: string; index: number; at: number }> {
  const source = String(text ?? '')
  const found: Array<{ name: string; index: number; at: number }> = []
  const claimed: Array<[number, number]> = []
  for (const name of RADICAL_NAMES_BY_LENGTH) {
    let at = source.indexOf(name)
    while (at >= 0) {
      const end = at + name.length
      if (!claimed.some(([start, stop]) => at < stop && end > start)) {
        found.push({ name, index: NAME_TO_RADICAL.get(name)!.index, at })
        claimed.push([at, end])
      }
      at = source.indexOf(name, at + 1)
    }
  }
  return found.sort((left, right) => left.at - right.at)
}

/** 章首标题行（「## 第 12 章 …」）不含断言，先剥掉。 */
const HEADING = /^#{0,4}\s*第\s*\d+\s*章[^\n]*\n/u

function sentencesOf(content: string): string[] {
  return String(content ?? '')
    .replace(HEADING, '')
    .split(/(?<=[。！？…])|\n+/u)
    .map(sentence => sentence.trim())
    .filter(Boolean)
}

/**
 * 从一段文本里抽「正在被讨论的那个字」。
 *
 * 只认两种形态（都是正文里**只有谈字形时才会出现**的写法）：
 *   ① 引号里的单字：「温」/ “徐” / 『满』
 *   ② 破折号后的单字：——徐 / ——“温”
 * 正常叙述里的单字不会带引号、也不会被单独拖到破折号后面，所以这两种形态足够窄。
 *
 * 破折号那一条要求这个字**后面不是另一个汉字**：否则「底下一串数字残笔——一七四」
 * 会把「一」当成被描述的字（第一版就在这份语料上踩到，一问一答两处候选 → 判据沉默）。
 */
function describedCharacters(text: string): Array<{ character: string; at: number }> {
  const source = String(text ?? '')
  const hits: Array<{ character: string; at: number }> = []
  for (const match of source.matchAll(/[「『“"]([\u3400-\u9fff])[」』”"]/gu)) {
    hits.push({ character: match[1]!, at: match.index! })
  }
  // 破折号后紧跟一个汉字、且其后不再接汉字（「——徐。」命中，「——一七四」不命中）。
  for (const match of source.matchAll(/[—–]{2,}[“「『"]?([\u3400-\u9fff])(?![\u3400-\u9fff])/gu)) {
    hits.push({ character: match[1]!, at: match.index! })
  }
  return hits
}

/**
 * 「偏旁名附近是否另有一个**部首相符**的字」的搜索跨度（句数，向前向后各取）。
 *
 * 取 4 而不是 2：issue #119 的实测样本里，真正被描述的字「柯」在偏旁名那一句之后
 * **第 3 句**才出现（「木字旁的起笔。」→「周叙盯着那道残笔。」→「裂口里那道起笔立在他脑子里。」
 * →「像“柯”字的第一笔。」）。跨度取 2 会漏掉它、照样误报。
 * 放宽的代价是**可能少报**（附近恰好有别的同部首字）——这正是 #99 定的方向：宁可漏，也不误报。
 */
const MATCHING_RADICAL_SPAN = 4

/**
 * 抽出本章所有**能判定**的字形断言（被描述的字 + 相邻偏旁名）。
 * 命中「偏旁名与这个字的实际部首相符」的**不返回**——它没有错。
 *
 * issue #119 修的一类**假阳性**：偏旁名所在句**自己没有被描述的字**时，判据会从
 * 相邻句借一个引号单字——可作者说的可能根本是**别的字**。实测第 52 章：
 * 「裂到「温」字刮去的那处停住……木字旁的起笔。」后几句才是「像『柯』字的第一笔」
 * ——「木字旁」说的是**柯**（柯＝木＋可，木字旁**正确**），判据却借了指上句的
 * 「温」（温＝三点水），报出「温是木字旁」这种张冠李戴。
 *
 * 修法（issue 建议 1）：
 *   ① 偏旁名所在句**自己有**被描述的字时只用本句，不从相邻句借；
 *   ② 借字之前，先在**较宽的跨度**（`MATCHING_RADICAL_SPAN`）里找有没有另一个字，
 *      其实际部首恰好等于本句的偏旁名——有就说明偏旁名八成在说那个字，**不报**。
 *
 * ⚠️ 刻意**不采用** issue 建议 2 的字面写法（「偏旁名所在句自身没有字且借来的字不符
 * 就判 unknown」）：那会把 #99 自己的两个真阳性一起判死——第 45 章
 * 「半个“温”字。左边半边，立人旁。」里，偏旁名那半句（「立人旁」）**自身就没有字**，
 * 它必须向上一句借「温」才判得出来。所以问题不在「借」，而在「借之前没找更合适的字」。
 */
export function glyphRadicalMismatches(
  chapterNumber: number,
  content: string,
): GlyphRadicalFinding[] {
  const sentences = sentencesOf(content)
  const findings: GlyphRadicalFinding[] = []
  const seen = new Set<string>()
  for (let index = 0; index < sentences.length; index += 1) {
    const names = radicalNamesIn(sentences[index]!)
    if (names.length === 0) continue
    // 校验②：较宽跨度内若存在「实际部首与偏旁名相符」的字，判为「偏旁名在说那个字」，不报。
    const matchingScan = sentences
      .slice(Math.max(0, index - MATCHING_RADICAL_SPAN), index + MATCHING_RADICAL_SPAN + 1)
      .join('')
    if (describedCharacters(matchingScan).some(hit => {
      const actual = radicalIndexOf(hit.character)
      return actual !== null && names.some(name => name.index === actual)
    })) continue
    // issue #119 校验①：**本句自己有被描述的字**时只用本句，不从相邻句借
    // （原来窗口一律取「本句 + 前后句」，借来的字可能与偏旁名无关）。
    const ownSentence = describedCharacters(sentences[index]!)
      .filter(hit => radicalIndexOf(hit.character) !== null)
    // 窗口 = 本句 + 紧邻的前后句：断言常被句号切开（「半个“温”字。左边半边，立人旁。」）。
    const window = [sentences[index - 1] ?? '', sentences[index]!, sentences[index + 1] ?? ''].join('')
    const candidates = ownSentence.length > 0
      ? ownSentence
      : describedCharacters(window).filter(hit => radicalIndexOf(hit.character) !== null)
    if (candidates.length === 0) continue
    // 窗口里有多个候选字时会牵连不清——宁可漏，也不猜（本仓 #30/#93 的教训）。
    if (new Set(candidates.map(hit => hit.character)).size > 1) continue
    const { character } = candidates[0]!
    const actual = radicalIndexOf(character)!
    // 只要**有一个**相邻偏旁名与这个字相符，就不算错（正文可能在并列交代同一个字的多个部件）。
    if (names.some(name => name.index === actual)) continue
    const claimed = names[0]!
    const key = `${character}:${claimed.name}`
    if (seen.has(key)) continue
    seen.add(key)
    findings.push({
      chapterNumber,
      character,
      claimedName: claimed.name,
      actualRadical: actual,
      actualLabel: radicalLabelOf(actual),
      excerpt: [sentences[index - 1] ?? '', sentences[index]!, sentences[index + 1] ?? ''].join('').slice(0, 120),
    })
  }
  return findings
}

/**
 * 字形断言与偏旁实际部首不符 → 一致性发现（issue #99）。
 *
 * 出路直接给出**正确的部首**（「温 = 三点水（氵），不是立人旁」），作者一眼能改；
 * 并提示这一类判据应当进事实账本，免得下游章节继承错误（issue 建议 3）。
 */
export function glyphRadicalFindings(
  chapters: ReadonlyArray<{ chapterNumber: number; content: string }>,
): Array<{
  stableFactKey: string
  severity: 'warning'
  sourceChapter: number
  evidence: string
  issue: { zhCN: string; enUS: string }
  suggestion: { zhCN: string; enUS: string }
}> {
  return chapters.flatMap(chapter => {
    if (!Number.isSafeInteger(chapter.chapterNumber)) return []
    return glyphRadicalMismatches(chapter.chapterNumber, chapter.content).map(hit => ({
      // key 锚在「这个字的这个偏旁断言」上，不带章号（#86/#89/#98 的教训）。
      stableFactKey: `glyph:radical-mismatch:${hit.character}:${hit.claimedName}`,
      severity: 'warning' as const,
      sourceChapter: hit.chapterNumber,
      evidence: `第${hit.chapterNumber}章：「${hit.excerpt}」——「${hit.character}」的部首是 ${hit.actualLabel}，不是「${hit.claimedName}」`,
      issue: {
        zhCN: `第${hit.chapterNumber}章把「${hit.character}」的偏旁说成「${hit.claimedName}」，但它实际上是 **${hit.actualLabel}**`
          + `（原文：「${hit.excerpt}」）。这不是文笔问题而是**事实错误**：中文读者对偏旁极度敏感，`
          + `而且当这句是本章**唯一的身份判据**时（「认字」类线索），偏旁一错，读者会先怀疑自己记错了字，整条推理也跟着塌。`
          + `这类断言最容易被机器判——康熙部首是封闭数据——所以它本该在落笔前就被拦住。`,
        enUS: `Chapter ${hit.chapterNumber} describes “${hit.character}” as having the radical “${hit.claimedName}”, but its actual radical is **${hit.actualLabel}** (source: “${hit.excerpt}”). This is a factual error, not a style issue: Chinese readers are acutely sensitive to radicals, and when this is the chapter's only identity cue (a “recognise the handwriting/character” thread), a wrong radical makes readers doubt their own memory of the character and undermines the whole deduction.`,
      },
      suggestion: {
        zhCN: `改成正确的偏旁：把「${hit.claimedName}」改成「${hit.actualLabel}」`
          + `（「${hit.character}」= ${hit.actualLabel} + 其余部件）。若这半页本来就是线索的关键，`
          + `顺手把这条**字形判据**写进事实账本（「半个${hit.character}字 = ${hit.actualLabel}」），`
          + `这样后续章节引用它时不会继承错误、也不会另编一套特征。`,
        enUS: `Use the correct radical: replace “${hit.claimedName}” with “${hit.actualLabel}” (${hit.character} = ${hit.actualLabel} + the remaining component). If this fragment is a key clue, also record the glyph fact in the fact ledger so later chapters inherit the correct form instead of inventing a new one.`,
      },
    }))
  })
}
