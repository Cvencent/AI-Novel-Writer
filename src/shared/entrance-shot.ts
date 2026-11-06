/**
 * 人物登场句的跨章同构（issue #81）。
 *
 * 产品里查「同一套写法」的检测一共三组，**分别只看三个位置**：
 * 章首（#71/#72 的第一个小句）、章末（#65/#66 的最后一段）、正文核心戏
 * （#32/#33 的否定式反应与溯读装置）。**人物「怎么登场」的那一段落在章中间，
 * 三组都看不到**，而它恰恰是连载里同构最重的一处。
 *
 * 实测样本（32 章定稿）：温珩出场 30 章，其中 11 章的**首次出现那一段**直接带穿戴，
 * 三章只换一个虚词：
 *
 *   ch12  温珩站在梯口，赤脚，靛蓝短褂下摆还滴着水。
 *   ch13  温珩站在梯口，赤脚，短褂下摆滴水。
 *   ch14  温珩站在舱门口，赤脚，靛蓝短褂的下摆还湿着。
 *
 * 还有跨章**逐字**：ch9↔ch10 有 22 字逐字、ch7↔ch14 有 13 字逐字。
 *
 * 判据刻意做成**无词表**的（本仓在 #30/#43/#70/#80 反复吃过词表过拟合的亏）：
 * 不比「有哪些穿戴词」，而是直接问——**同一个角色在两章的登场句，字面有多像**。
 * 去标点后取最长公共子串，够长就是同一句换了个虚词。这正好对上报告里最硬的那几对证据，
 * 而且换一本书、换一批人物、换一套衣饰都照样成立。
 */

/** 登场段：某角色在某章**第一次**出现的那一段。 */
export interface CharacterEntrance {
  character: string
  chapterNumber: number
  /** 该角色本章首次出现的段落（已去首尾空白）。 */
  sentence: string
  /** 该段在本章所有段落里的序号（从 1 起，供作者定位）。 */
  sentenceIndex: number
}

export interface EntranceRepetition {
  character: string
  /** 命中的章号（升序）。 */
  chapters: number[]
  /** 每章对应的登场句。 */
  sentences: string[]
  /** 这几句去标点后的最长公共子串（供作者确认是不是同一句换了个虚词）。 */
  commonSubstring: string
}

/** 去空白与中英标点，只留文字与数字——「逐字」的判定口径。 */
export function stripForComparison(text: string): string {
  return String(text ?? '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
}

/**
 * 最长公共子串（只保留**字面**信息，不做语义）。
 *
 * 用 DP 求；文本是单章一句的量级（≤ 数百字），O(n·m) 足够。
 */
export function longestCommonSubstring(left: string, right: string): string {
  if (!left || !right) return ''
  const rows = left.length + 1
  const cols = right.length + 1
  // 只留两行：内存够小，也不会在长句上抖动。
  let previous = new Uint16Array(cols)
  let current = new Uint16Array(cols)
  let bestLength = 0
  let bestEnd = 0
  for (let i = 1; i < rows; i += 1) {
    current.fill(0)
    for (let j = 1; j < cols; j += 1) {
      if (left[i - 1] !== right[j - 1]) continue
      const length = previous[j - 1]! + 1
      current[j] = length
      if (length > bestLength) { bestLength = length; bestEnd = i }
    }
    const swap = previous
    previous = current
    current = swap
  }
  return bestLength === 0 ? '' : left.slice(bestEnd - bestLength, bestEnd)
}

/**
 * 命中门槛：去标点后 **≥ 8 字**的公共子串。
 *
 * 报告里最短的一对是 12 字（邵广海），样本三章同构那组是 13 字起。
 * 取 8 是刻意留出的余量：短于此的公共子串更可能是「他站在门口」这类
 * 通用叙述而非同一句复写。
 */
export const ENTRANCE_COMMON_MIN = 8

/** 相邻命中之间允许的最大章距：隔太远时读者早已接受，不再读作同构。 */
export const ENTRANCE_MAX_GAP = 8

/**
 * 调用方（写前预检 / 审稿）**至少**要喂进来的章数（issue #92）。
 *
 * 为什么窗口要和判据放在一起：判据允许相隔 `ENTRANCE_MAX_GAP`(=8) 章的两章配对，
 * 而链子可以很长——「温珩」在样本里 7/12/14 三章同构、邵广海 4/6/12 三章同构，
 * 端到端跨度是 12 章。原来写前预检硬编码 `slice(-10)`：实测 39 章的书全书 7 组，
 * 而窗口 10 章时 **0 组** —— 窗口一滑过去，这一类就**永久静音**，而屏幕上那条
 * 「一致性预检 · N 条」仍在正数，作者看不出「登场句这次没参与比较」。
 *
 * 取 16 而不是「全书」：判据是两两比较，全书对长篇是 O(n²)；16 章能覆盖
 * 「最多三次同构、相邻间隔 ≤8」的最坏跨度，也与物证复活那条窗口同值。
 * **窗口大小改这里，判据常量也在这里，两处不会再漂开**（这正是 #92 建议 3）。
 */
export const ENTRANCE_WINDOW_CHAPTERS = 16

export interface ChapterProse {
  chapterNumber: number
  content: string
}




/**
 * 找出「同一个角色的登场句在多章几乎逐字相同」。
 *
 * 只比**同一角色**：不同角色的登场句相像是另一类问题，而且名册一长，跨角色比较
 * 会产生大量假阳性。按角色归一是这条的正确口径（与 #49 的结论一致）。
 */
export function findRepeatedEntranceShots(
  entrances: readonly CharacterEntrance[],
  options: { minCommon?: number; maxGap?: number } = {},
): EntranceRepetition[] {
  // issue #163 第八批：登场段由模型挑选（entrance-selection-review.ts），本函数只做跨章比对。
  const minCommon = options.minCommon ?? ENTRANCE_COMMON_MIN
  const maxGap = options.maxGap ?? ENTRANCE_MAX_GAP
  if (entrances.length === 0) return []

  // 按角色分组，组内按章号排序。
  const byCharacter = new Map<string, CharacterEntrance[]>()
  for (const entrance of entrances) {
    const list = byCharacter.get(entrance.character) ?? []
    list.push(entrance)
    byCharacter.set(entrance.character, list)
  }

  const results: EntranceRepetition[] = []
  for (const [character, list] of byCharacter) {
    if (list.length < 2) continue
    const ordered = [...list].sort((left, right) => left.chapterNumber - right.chapterNumber)
    // 以第一句为基准向后找足够像的章：同一句复写会形成一条链。
    const used = new Set<number>()
    for (let index = 0; index < ordered.length; index += 1) {
      if (used.has(index)) continue
      const base = ordered[index]!
      const group: CharacterEntrance[] = [base]
      for (let later = index + 1; later < ordered.length; later += 1) {
        const candidate = ordered[later]!
        if (candidate.chapterNumber - base.chapterNumber > maxGap) break
        const shared = longestCommonSubstring(
          stripForComparison(base.sentence), stripForComparison(candidate.sentence))
        if (shared.length >= minCommon) group.push(candidate)
      }
      if (group.length < 2) continue
      for (const member of group) used.add(ordered.indexOf(member))
      // 组内公共子串取「与基准那句」的：作者要确认的是「是不是同一句」。
      const common = group.slice(1)
        .map(member => longestCommonSubstring(
          stripForComparison(base.sentence), stripForComparison(member.sentence)))
        .sort((left, right) => right.length - left.length)[0] ?? ''
      results.push({
        character,
        chapters: group.map(member => member.chapterNumber),
        sentences: group.map(member => member.sentence),
        commonSubstring: common,
      })
    }
  }
  // 排序后**按角色分配名额**再封顶（issue #87）：直接 `.slice(0, 4)` 会让同一个角色的
  // 多组挤掉别的角色整组——实测全名册调用只出 4 组，而逐角色跑能出 7 组（林棠、
  // 邵广海第二组、温珩 ch12↔13 被挤掉）。写前预检传的就是**全部在册角色**，
  // 所以被挤掉的正好是「不主动去查就看不见」的那几组。
  const ranked = results.sort((left, right) => right.chapters.length - left.chapters.length
    || right.commonSubstring.length - left.commonSubstring.length
    || left.character.localeCompare(right.character))
  // 每个角色先各取一组（各自最重的那组），再按原顺序补第二组——保证角色覆盖面优先于
  // 单角色条数。上限是**条数**而不是「角色数」，与「最多报 N 条提醒」的既有口径一致。
  const MAX_RESULTS = 8
  const firstOfCharacter: EntranceRepetition[] = []
  const rest: EntranceRepetition[] = []
  const claimed = new Set<string>()
  for (const hit of ranked) {
    if (!claimed.has(hit.character)) {
      claimed.add(hit.character)
      firstOfCharacter.push(hit)
    } else rest.push(hit)
  }
  return [...firstOfCharacter, ...rest].slice(0, MAX_RESULTS)
}