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

export interface ChapterProse {
  chapterNumber: number
  content: string
}

/**
 * 「进场动作 + 穿戴」的实体登场标记（issue #87 的根因修复）。
 *
 * 为什么需要它：把「本章第一次提到该名字的段」当作登场段是**错的**——
 * 宿主章里「先提名、后到场」是常态（回忆、他人提及、点名喊人、档案里先出现），
 * 于是真正的登场段被整段跳过。实测那本书（36 章）：
 *
 *   ch7  第 9 段（回忆引述）「……温珩说"一直空着"。」 ← 旧判据取这一段
 *        第 16 段（实体登场）「温珩站在舱门口，赤脚，靛蓝短褂下摆垂着。」 ← 该取这一段
 *   ch9  第 13 段（全叔台词里点名）「"……原本不属于温珩。"」 ← 旧判据取这一段
 *        第 24 段（实体登场）「舱门口有赤脚踩木板的声响。温珩站在那儿，靛蓝短褂下摆往下滴。」
 *
 * 旧判据因此把 ch7↔ch14 比成「他手」（2 字、不报），而两段**实体登场**是 13 字。
 * 更糟的是它对「越复杂的写法越瞎」：越爱用回忆/他人提及的章，越命中不到。
 *
 * 判据是**结构**不是词表：段里同时出现 ①该角色名 ②进场动作（站/进来/走/蹲/靠/坐…）
 * ③穿戴或随身物（短褂/长衫/围裙/袖口/下摆/赤脚/公文包…）。三条缺一不可，
 * 免得「他记得温珩说过话」这种既无动作又无穿戴的段被误当成登场。
 */
const ENTRANCE_ACTION = /(?:站在|站定|站到|进来|走进|走入|走到|走在|进来|进舱|进来|踏进|跨进|迈|从[^，。]{0,6}走进|蹲在|蹲下|靠着|靠在|倚在|坐在|来到|赶到|出现|进了|推门|掀帘|上场|到了)/u
const ENTRANCE_DRESS = /(?:短褂|长衫|绸褂|围裙|袖口|袖子|下摆|领口|衣襟|赤脚|光脚|靴|鞋|帽|公文包|竹尺|烟盒|风灯|缆绳|手里的|手里攥|手里拿|捏着|抱着|肩上|胳膊上|手里)/u

/** 这一段是不是「实体登场」（角色名 + 进场动作 + 穿戴/随身物同段）。 */
export function isEntranceParagraph(paragraph: string, name: string): boolean {
  const text = String(paragraph ?? '')
  if (!text.includes(name)) return false
  return ENTRANCE_ACTION.test(text) && ENTRANCE_DRESS.test(text)
}

/**
 * 收集每章每个角色的**登场段**（优先取「实体登场」那一段，issue #87）。
 *
 * 取段顺序（同一章内）：
 *   ① 第一个「实体登场」段（角色名 + 进场动作 + 穿戴/随身物同段）—— 最准；
 *   ② 找不到时退回「第一个出现该名字的段」—— 保底，避免整章没有任何命中
 *      （有些章确实只靠对白/回忆交代一个角色，那也仍是本章给他的位置）。
 *
 * 用**段落**而不是单句：22 字逐字的那一对（ch9↔ch10）共有的
 * 「舱门口有赤脚踩木板的声响」在**前一句**里，角色名在第二句——
 * 按单句取会把那半句丢掉，22 字逐字就只剩 6 字、落不到门槛上。
 */
export function characterEntrances(
  chapters: readonly ChapterProse[],
  castNames: readonly string[],
): CharacterEntrance[] {
  const names = [...new Set(castNames.map(name => String(name ?? '').trim()).filter(Boolean))]
    // 长名优先：名册里同时有「全叔」与「全叔的旧油布围裙」这类时，先匹配长的那条更准。
    .sort((left, right) => right.length - left.length)
  if (names.length === 0) return []
  const entrances: CharacterEntrance[] = []
  const ordered = [...chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
  for (const chapter of ordered) {
    // 段落口径与 `closingParagraph` 一致：按空行切块。
    const paragraphs = String(chapter.content)
      .split(/\n\s*\n/u)
      .map(block => block.trim())
      .filter(Boolean)
    for (const name of names) {
      // ① 实体登场优先。
      let index = paragraphs.findIndex(paragraph => isEntranceParagraph(paragraph, name))
      // ② 退回「第一次出现」。
      if (index < 0) index = paragraphs.findIndex(paragraph => paragraph.includes(name))
      if (index < 0) continue
      entrances.push({
        character: name, chapterNumber: chapter.chapterNumber,
        sentence: paragraphs[index]!, sentenceIndex: index + 1,
      })
    }
  }
  return entrances
}

/**
 * 找出「同一个角色的登场句在多章几乎逐字相同」。
 *
 * 只比**同一角色**：不同角色的登场句相像是另一类问题，而且名册一长，跨角色比较
 * 会产生大量假阳性。按角色归一是这条的正确口径（与 #49 的结论一致）。
 */
export function findRepeatedEntranceShots(
  chapters: readonly ChapterProse[],
  options: { castNames?: readonly string[]; minCommon?: number; maxGap?: number } = {},
): EntranceRepetition[] {
  const minCommon = options.minCommon ?? ENTRANCE_COMMON_MIN
  const maxGap = options.maxGap ?? ENTRANCE_MAX_GAP
  const entrances = characterEntrances(chapters, options.castNames ?? [])
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