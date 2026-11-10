/**
 * 设定层时间锚点冲突（issue #2）。
 *
 * 实测样本：同一套「故事前提 / 世界观 / 角色图谱」里，「父亲落水」这件事
 * 既在**十年前**（前提、周叙角色卡）又在**二十年前**（前提与世界观里说温珩
 * 二十年不换那件「父亲落水那夜穿走的」靛蓝短褂）。矛盾被原样复制进三份生成件。
 *
 * 这个矛盾发生在**架构阶段**，正是后续蓝图、正文、角色状态抽取的输入——
 * 会顺着链路往下传。而现有的一致性检查只抓「角色外貌/身体状态」这类可枚举属性。
 *
 * 判据刻意做成**结构性**的（本仓在 #30/#43/#70 反复吃过词表过拟合的亏）：
 * 不去枚举「落水/失踪/去世」，而是问——**同一个名词片段，是否在不同的句子里
 * 被配上了两个不同的时间量**。同一件事不可能既过去 10 年又过去 20 年。
 * 换一本书、换一个事件，判据照样成立。
 */

/** 中文数字与阿拉伯数字都接受。 */
const DURATION = /(\d{1,4}|[一二三四五六七八九十百千万零两]{1,4})\s*年/u

const CHINESE_DIGITS: Readonly<Record<string, number>> = Object.freeze({
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
})

/** 把中文数字或阿拉伯数字统一成数值；解析不出来时返回 null（不猜）。 */
export function durationValue(token: string): number | null {
  if (/^\d+$/u.test(token)) {
    const value = Number(token)
    return Number.isSafeInteger(value) && value > 0 && value <= 9999 ? value : null
  }
  // 只支持「十 / 二十 / 三十五 / 一百」这一类常见写法；更复杂的（「一百零二」）交给阿拉伯数字。
  let total = 0
  let section = 0
  let digit = 0
  for (const character of token) {
    const value = CHINESE_DIGITS[character]
    if (value !== undefined) { digit = value; continue }
    if (character === '十') {
      section += (digit === 0 ? 1 : digit) * 10
      digit = 0
      continue
    }
    if (character === '百') {
      section += (digit === 0 ? 1 : digit) * 100
      digit = 0
      continue
    }
    if (character === '千') {
      section += (digit === 0 ? 1 : digit) * 1000
      digit = 0
      continue
    }
    if (character === '万') {
      total += (section + digit) * 10000
      section = 0
      digit = 0
      continue
    }
    return null
  }
  const result = total + section + digit
  return result > 0 && result <= 9999 ? result : null
}

/** 按句末标点切句；不需要引号感知（这里只看时间量与被它修饰的词同句共现）。 */
function splitSentences(text: string): string[] {
  return String(text ?? '')
    .split(/(?<=[。！？!?；;\n])/u)
    .map(sentence => sentence.trim())
    .filter(Boolean)
}

/**
 * 抽取一篇文章里「名词片段 → 时间量」的共现。
 *
 * 「名词片段」= 连续 CJK 串里长度 2–4 的窗口。取所有窗口而不是只取一个，
 * 是因为真正的锚点（「落水」「父亲落水」）落在哪个长度上无法预知；
 * 后面按「冲突的时间量集合」归并，重复的锚点会自然合并成一条。
 *
 * 同一句里出现多个时间量时**全部计入**：样本中「二十年来在夜航船帮工……却是
 * 父亲落水那夜的靛蓝短褂」正是靠同句共现才把「落水」和「二十年」连起来。
 */
/**
 * 一条锚点的时间量观测：**哪个时间量、出自哪一句**。
 *
 * 带句子身份是这条判据成立的前提。判据文档写的是「同一个名词片段，是否在
 * **不同的句子里**被配上了两个不同的时间量」，而旧实现只记时间量、不记句子，
 * 于是一句长句里同时出现「2 年前」和「沿用 80 年」就把**这句的每一个窗口**
 * 都标成「同时配了 2 年和 80 年」（实测真库一句 80 字的话污染 201 个片段，
 * 报出来的锚点是「变遗留的」「的独立事」这类跨标点碎片，读者无法据此定位）。
 */
export interface DurationObservation {
  value: number
  /** 句子序号（同一篇文本内单调递增）；只有**不同句子**才构成「跨句冲突」。 */
  sentence: number
}

/**
 * 抽取一篇文章里「名词片段 → 时间量观测」的共现。
 *
 * 「名词片段」= 连续 CJK 串里长度 2–4 的窗口。取所有窗口而不是只取一个，
 * 是因为真正的锚点（「落水」「父亲落水」）落在哪个长度上无法预知；
 * 后面按「冲突的时间量集合」归并，重复的锚点会自然合并成一条。
 *
 * 同一句里的多个时间量**仍然全部计入**，但每个时间量只贴给**离它最近的那一段
 * 名词片段**，而不是撒给这句里的每一个窗口。
 * （旧实现是「撒」，于是一句同时提到 2 年和 80 年的长句会把这句的每个碎片都标成
 * 「既 2 年又 80 年」——真库实测一句 80 字的话污染 201 个片段，报出来的锚点是
 * 「变遗留的」「的独立事」这类跨标点碎片，作者无法据此定位要改哪里。
 * 而正确写法恰恰就是「其一…80 年…8 年…；其二…2 年…」，作者已经把时间绑在
 * 各自的事件上，撒给全句等于把这份区分抹掉。）
 */
export function durationAnchorsWithSentences(text: string): Map<string, DurationObservation[]> {
  const anchors = new Map<string, DurationObservation[]>()
  for (const [sentenceIndex, sentence] of splitSentences(text).entries()) {
    const matches = [...sentence.matchAll(new RegExp(DURATION, 'gu'))]
    if (matches.length === 0) continue
    // 时间量在句中的位置 → 值（同值去重由下游按句子号处理）。
    const durationSpans = matches.map(match => ({
      value: durationValue(match[1]!),
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    })).filter((span): span is { value: number; start: number; end: number } => span.value !== null)
    if (durationSpans.length === 0) continue
    // 锚点必须**先剥掉时间量本身**再取窗口：否则「十年」是「二十年」的子串，
    // 「父亲十年前落水失踪。温珩二十年不换短褂。」会因为锚点「十年」跨句同时
    // 沾上 10 和 20 而报出假冲突——真正冲突的是「同一件事」，不是数字词互为子串。
    // 剥掉后长度不变（用全角空格占位），所以窗口在句中的偏移可以直接用来算距离。
    const withoutDurations = sentence.replace(new RegExp(DURATION, 'gu'), '　')
    const runs = [...withoutDurations.matchAll(/[\u4e00-\u9fa5]+/gu)].map(match => ({ run: match[0], offset: match.index ?? 0 }))
    for (const { run, offset } of runs) {
      for (const length of [2, 3, 4]) {
        for (let start = 0; start + length <= run.length; start += 1) {
          const token = run.slice(start, start + length)
          const tokenStart = offset + start
          const tokenEnd = tokenStart + length
          // 只贴给最近的那个时间量：距离 = 词与时间量之间的字符间隔（0 表示贴着）。
          let nearest: { value: number; distance: number } | null = null
          for (const span of durationSpans) {
            const distance = tokenEnd <= span.start ? span.start - tokenEnd : Math.max(0, tokenStart - span.end)
            if (nearest === null || distance < nearest.distance
              || (distance === nearest.distance && span.value < nearest.value)) {
              nearest = { value: span.value, distance }
            }
          }
          if (nearest === null) continue
          const observations = anchors.get(token) ?? []
          observations.push({ value: nearest.value, sentence: sentenceIndex })
          anchors.set(token, observations)
        }
      }
    }
  }
  return anchors
}

/** 兼容旧调用方：只要「片段 → 时间量集合」（不带句子身份）。 */
export function durationAnchors(text: string): Map<string, Set<number>> {
  const anchors = new Map<string, Set<number>>()
  for (const [token, observations] of durationAnchorsWithSentences(text)) {
    anchors.set(token, new Set(observations.map(item => item.value)))
  }
  return anchors
}

export interface TimelineAnchorConflict {
  /** 同一件事在不同句子里的时间量（升序）。 */
  durations: number[]
  /** 触发这条冲突的名词片段（可能多个，取最长者作代表）。 */
  anchors: string[]
}

export interface TimelineSection {
  /** 这一段来自哪里（「故事前提」「世界观」「角色图谱·周叙」…），用于定位。 */
  label: string
  text: string
}

/**
 * 找出设定层「同一件事被配了两个时间量」的冲突。
 *
 * 只保留**最长**的那些锚点：短窗（「父亲」「落水」的外层）与长窗（「父亲落水」）
 * 会同时命中，全报出来只会刷屏。按「时间量集合」归并后，每条冲突取该集合下
 * 最长的锚点做代表，并附上出现的段落标签。
 */
export function findTimelineAnchorConflicts(
  sections: readonly TimelineSection[],
): Array<TimelineAnchorConflict & { sources: string[] }> {
  // 全局累积：同一件事可能分散在不同段里（前提说十年、世界观说二十年）。
  // ⚠️ 必须按**句子身份**累积，这是判据原文的要求（「在**不同的句子里**被配上
  // 两个不同的时间量」）。旧实现把一句里的所有时间量摊给该句的每个窗口，长句
  // 一被切碎就产出成百上千个碎片锚点（真库实测 201 个，如「变遗留的」「的独立事」），
  // 报给作者的建议因此无法定位。现在只承认「跨句」的配对。
  const merged = new Map<string, { observations: DurationObservation[]; sources: Set<string> }>()
  // 句子号必须**跨段全局唯一**：否则「故事前提」的第 0 句与「世界观」的第 0 句
  // 会被当成同一句，跨段冲突（本判据的核心形态：前提说十年、世界观说二十年）
  // 就永远凑不出「两个不同句子」。逐段累加偏移量即可。
  let sentenceOffset = 0
  for (const section of sections) {
    const anchors = durationAnchorsWithSentences(section.text)
    // 本段一共几句，决定下一段的起始偏移。
    const sentenceCount = splitSentences(section.text).length
    for (const [anchor, observations] of anchors) {
      const entry = merged.get(anchor) ?? { observations: [], sources: new Set<string>() }
      for (const observation of observations) {
        entry.observations.push({ value: observation.value, sentence: observation.sentence + sentenceOffset })
      }
      if (observations.length > 0) entry.sources.add(section.label)
      merged.set(anchor, entry)
    }
    sentenceOffset += sentenceCount
  }

  // 按时间量集合归并：同一组冲突的多个锚点（「父亲」「落水」「父亲落水」）算一条。
  const bySignature = new Map<string, { durations: number[]; anchors: string[]; sources: Set<string> }>()
  for (const [anchor, entry] of merged) {
    // 冲突 = 同一片段在**两个不同句子**里被配上了**不同**的时间量。
    // 同一句里同时提到两个数字不算冲突（那正是作者在区分两件事的常见写法：
    // 「手环硬件沿用 80 年，但配发是 2 年前」）。
    const byValue = new Map<number, Set<number>>()
    for (const observation of entry.observations) {
      const sentences = byValue.get(observation.value) ?? new Set<number>()
      sentences.add(observation.sentence)
      byValue.set(observation.value, sentences)
    }
    if (byValue.size < 2) continue
    const values = [...byValue.keys()].sort((left, right) => left - right)
    // 必须存在**两个值来自不同句子**的配对：同一句说了 2 年和 80 年、别处只说 2 年，
    // 不足以构成「同一件事被写成两个时间」。
    const crossSentence = values.some(low => values.some(high => high > low
      && [...byValue.get(low)!].some(sentence => !byValue.get(high)!.has(sentence))))
    if (!crossSentence) continue
    const durations = values
    const signature = durations.join('/')
    const bucket = bySignature.get(signature) ?? { durations, anchors: [], sources: new Set<string>() }
    bucket.anchors.push(anchor)
    for (const source of entry.sources) bucket.sources.add(source)
    bySignature.set(signature, bucket)
  }

  return [...bySignature.values()].map(bucket => {
    // 只留互相不为子串的最长锚点，避免「父亲」「落水」「父亲落水」三重罗列。
    const longest = [...bucket.anchors]
      .sort((left, right) => right.length - left.length || left.localeCompare(right))
      .filter((anchor, _index, all) => !all.some(other => other !== anchor && other.includes(anchor) && other.length > anchor.length))
    return {
      durations: bucket.durations,
      anchors: longest.slice(0, 3),
      sources: [...bucket.sources].sort(),
    }
  }).sort((left, right) => right.durations.length - left.durations.length || left.durations[0]! - right.durations[0]!)
}

/**
 * 设定层各段 → findings 需要的段落列表。
 *
 * 只带**设定层**的文本：前提、世界观、角色图谱。正文/蓝图不在这里比——
 * 它们的时间表述天然会有「十年前那晚」这类指代，混进来会制造假阳性。
 */
export function designSections(input: {
  premise: string
  worldbuilding: string
  charactersArch: string
}): TimelineSection[] {
  const sections: TimelineSection[] = []
  if (input.premise?.trim()) sections.push({ label: '故事前提', text: input.premise })
  if (input.worldbuilding?.trim()) sections.push({ label: '世界观', text: input.worldbuilding })
  if (input.charactersArch?.trim()) sections.push({ label: '角色图谱', text: input.charactersArch })
  return sections
}