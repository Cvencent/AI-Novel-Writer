import { splitProseSentences } from './finalized-continuity-facts'

/**
 * 章首形态与「揭示句式」的收敛检测（issue #71 / #72）。
 *
 * 前几轮补的是章末（#28 收束画面 / #65 标注比对 / #66 末句语用）与正文内部
 * （#32 装置 / #33 反应短句 / #49 配角重复）。**章首这一轴一直是空的**，
 * 而实测样本 28 章有 19 章以「时间/地点状语 + 主句」开篇，句式一次没变：
 *
 *   船离岸还有一袋烟的工夫，周叙已经在跳板口核完了三十二张票根。
 *   换班的梆子敲过两下，周叙把风灯挂上舱柱，走到船尾替温珩。
 *   天蒙蒙亮。 / 靠埠前一个时辰，货舱里只剩帆布缝里透进的一线灯。
 *
 * 另一条轴是**同一线索的投放句式**（#72）：隐藏主线的每一次推进都用
 * 「你爸当年也……」+ 立刻收口，5 章同一句式、后半句各不相同。
 *
 * 判据一律做成**结构性**的，不枚举词汇——本仓在 #30/#43/#70 反复吃过
 * 词表过拟合的亏：换一本书、换一批人物，结构判据仍然成立，词表立刻失效。
 */

/** 章首是以什么起手的。这是本模块唯一断言的分类。 */
export type OpeningShape =
  /** 环境/时间/地点起手，主句在后：状语在前，人物在后。 */
  | 'scene'
  /** 人物起手：第一个小句的主语就是在册角色（或人称代词）。 */
  | 'character'
  /** 判不出来（空章等）。 */
  | 'unknown'

export interface ChapterOpening {
  chapterNumber: number
  shape: OpeningShape
  /** 章首第一句的**第一个小句**（到第一个逗号/句末为止），用于证据展示。 */
  clause: string
  /** 该小句的收尾 2 字，用于识别「…时 / …前 / …工夫」这类时间从句尾。 */
  clauseTail: string
}

/** 人称代词：出现在句首时也算「人物起手」（样本里「他」开头的章同样是人先出场）。 */
const SUBJECT_PRONOUN = /^(?:他|她|我|他们|她们|我们|两人|两名|众人)/u

function normalizeChapterBody(content: string): string {
  return String(content ?? '')
    .replace(/^#{0,4}\s*第\s*\d+\s*章[^\n]*\n/u, '')
    .trim()
}

/**
 * 章首第一个小句（到第一个逗号/句末标点为止）。
 *
 * 不用正则枚举标点：本仓在 #70 吃过「引号/全角字符写进字面量正则」的亏，
 * 这里用逐字扫描，同时跳过开头的引号（对白开篇的章不该被算成状语起手）。
 */
function firstClause(content: string): string {
  const body = normalizeChapterBody(content)
  const firstSentence = splitProseSentences(body)[0] ?? ''
  const start = firstSentence.search(/[“「『"]/u) === 0 ? 1 : 0
  const text = firstSentence.slice(start).trim()
  if (!text) return ''
  let clause = ''
  for (const character of text) {
    if ('，,'.includes(character)) break
    // 句末标点也算小句结束：整句只有一个主句时（「天蒙蒙亮。」）就是它本身。
    if ('。！？!?'.includes(character)) break
    clause += character
  }
  return clause.trim()
}

/**
 * 章首形态。
 *
 * 判据（结构性，不看词汇）：
 *  - 第一个小句里出现在册角色名 → 人物起手；
 *  - 以小句里的人称代词起头 → 人物起手；
 *  - 都没有 → 环境/时间/地点起手（scene）。
 *
 * 逗号不是必要条件：样本里「天蒙蒙亮。」这种单句同样是场景起手。
 */
export function chapterOpeningOf(
  chapterNumber: number,
  content: string,
  castNames: readonly string[] = [],
): ChapterOpening {
  const clause = firstClause(content)
  if (!clause) return { chapterNumber, shape: 'unknown', clause: '', clauseTail: '' }
  const cast = castNames.map(name => name.trim()).filter(name => name.length >= 2)
  const leadsWithCast = cast.some(name => clause.startsWith(name))
  const shape: OpeningShape = leadsWithCast || SUBJECT_PRONOUN.test(clause) ? 'character' : 'scene'
  return { chapterNumber, shape, clause, clauseTail: clause.slice(-2) }
}

/**
 * 章首收敛：最近窗口里 scene 起手占了绝大多数（issue #71）。
 *
 * 门槛取「窗口内 ≥4 章且 ≥80% 是 scene」：样本 28 章 19 章为 scene（68%），
 * 但**连续段落**里比例更高（第 19–28 章连续 8 章几乎全是）。用连续窗口而不是
 * 全书比例，是因为读者感到的是「这几章连着都这么开头」。
 */
export const OPENING_WINDOW = 6
export const OPENING_SCENE_RATIO = 0.8

export function openingConvergence(
  openings: readonly ChapterOpening[],
  window = OPENING_WINDOW,
): ChapterOpening[] {
  const usable = openings
    .filter(item => item.shape !== 'unknown')
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
  if (usable.length < window) return []
  const tail = usable.slice(-window)
  // 章号必须连续：中间夹着没导入的章不算一条链（与 #66 的连胜判据一致）。
  for (let index = 1; index < tail.length; index += 1) {
    if (tail[index]!.chapterNumber !== tail[index - 1]!.chapterNumber + 1) return []
  }
  const scene = tail.filter(item => item.shape === 'scene')
  // 命中时返回**整个窗口**：调用方要用它渲染章号区间与几句原文作证据，
  // 只回一个章号（原实现）在全窗口命中时会退化成同一章出现两次。
  return scene.length / tail.length >= OPENING_SCENE_RATIO ? [...tail] : []
}

/**
 * 同一「对话起手语」在多章重复（issue #72）。
 *
 * 判据：取每章对白行的**第一个小句**（到第一个逗号/句末为止），按首
 * `REVEAL_OPENER_GROUP_CHARS` 字分组；同一组覆盖 ≥3 章时，报告这一组的
 * **最长公共前缀**作为起手语。
 *
 * 这是结构性的，不是枚举词汇：把「你爸」换成「你母亲」、把账本换成别的线索，
 * 判据照样命中（长公共前缀会自己长成 `你母亲当年也`）。固定字符数窗口做不到
 * 这一点——`你爸当年` 恰好 4 字才碰巧通过，换个称谓就只剩 `你母亲当`。
 *
 * 只取对白第一小句而不是全文：揭示句式的固定感来自「长辈开口第一句就是这个」。
 */
export const REVEAL_OPENER_GROUP_CHARS = 3
export const REVEAL_OPENER_MIN_CHAPTERS = 3

export interface DialogueOpenerHit {
  /** 该组的最长公共前缀（起手语）。 */
  opener: string
  /** 命中该起手语的章号（升序）。 */
  chapters: number[]
}

/** 一章里所有对白行的第一个小句（去引号；同一章内去重）。 */
export function dialogueOpeners(content: string): string[] {
  const body = normalizeChapterBody(content)
  const openers = new Set<string>()
  for (const sentence of splitProseSentences(body)) {
    for (const match of String(sentence).matchAll(/[“「『"]([^”」』"]{2,200})[”」』"]/gu)) {
      const spoken = match[1]!.trim()
      let clause = ''
      for (const character of spoken) {
        if ('，,。！？!?；;'.includes(character)) break
        clause += character
      }
      if (clause.trim().length >= REVEAL_OPENER_GROUP_CHARS) openers.add(clause.trim())
    }
  }
  return [...openers]
}

/** 一组字符串的最长公共前缀。 */
function longestCommonPrefix(values: readonly string[]): string {
  if (values.length === 0) return ''
  let prefix = values[0]!
  for (const value of values.slice(1)) {
    let index = 0
    while (index < prefix.length && index < value.length && prefix[index] === value[index]) index += 1
    prefix = prefix.slice(0, index)
    if (!prefix) break
  }
  return prefix
}

export function findDialogueOpenerConvergence(
  chapters: ReadonlyArray<{ chapterNumber: number; content: string }>,
  options: { minChapters?: number; groupChars?: number } = {},
): DialogueOpenerHit[] {
  const groupChars = options.groupChars ?? REVEAL_OPENER_GROUP_CHARS
  const minChapters = options.minChapters ?? REVEAL_OPENER_MIN_CHAPTERS
  // 按「首 groupChars 字」归组；组内保留每章的一条原句，用于算最长公共前缀。
  const groups = new Map<string, { chapters: number[]; clauses: string[] }>()
  for (const chapter of chapters) {
    if (!Number.isSafeInteger(chapter.chapterNumber)) continue
    for (const clause of dialogueOpeners(chapter.content)) {
      if (clause.length < groupChars) continue
      const key = clause.slice(0, groupChars)
      const group = groups.get(key) ?? { chapters: [], clauses: [] }
      if (!group.chapters.includes(chapter.chapterNumber)) {
        group.chapters.push(chapter.chapterNumber)
        group.clauses.push(clause)
      }
      groups.set(key, group)
    }
  }
  return [...groups.values()]
    .filter(group => group.chapters.length >= minChapters)
    .map(group => ({
      opener: longestCommonPrefix(group.clauses),
      chapters: [...group.chapters].sort((left, right) => left - right),
    }))
    .filter(hit => hit.opener.length >= groupChars)
    // 覆盖章数多的优先；同数按起手语排序，保证输出稳定。
    .sort((left, right) => right.chapters.length - left.chapters.length || left.opener.localeCompare(right.opener))
}

/**
 * 「章首句式收敛」的样本窗口（issue #155 把窗口从服务层挪到这里）。
 *
 * 这一档的语义是**最近几章连续同构**，6 章合理——它与 `README` 里
 * `chapter-shape.ts` 的原意一致。
 */
export const OPENING_SHAPE_WINDOW_CHAPTERS = 6

/**
 * 「对白起手语」的样本窗口（issue #155）。
 *
 * `findDialogueOpenerConvergence` 的契约是「同一句起手语在**多章**重复，≥3 章即报」，
 * 它**没有相邻要求**——3 章可以散落在全书。旧实现把它和「章首句式」共用 6 章窗口，
 * 于是任何章号跨度 > 6 的组**结构上永远不可达**：实测 75 章的书 38 组里 **27 组（71%）**
 * 一次都不会报，包括 #72 的核心证据「你爸当年也」（落在 8 章、6 章窗里凑不出 3 章）。
 *
 * 取 `Infinity` = 全量已定稿章：这一档判的是「整本书反复用这一句起手」，
 * 它本来就该看整本书；与同文件里 `ENTRANCE_WINDOW_CHAPTERS` 那种「近期形态」不是一类。
 * ⚠️ 若将来确实要限窗，必须**同时**把范围写进文案——否则作者会以为整本都查过（issue #155 建议 4）。
 */
export const DIALOGUE_OPENER_WINDOW_CHAPTERS = Number.POSITIVE_INFINITY
