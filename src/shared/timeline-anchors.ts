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
export function durationAnchors(text: string): Map<string, Set<number>> {
  const anchors = new Map<string, Set<number>>()
  for (const sentence of splitSentences(text)) {
    const durations = [...sentence.matchAll(new RegExp(DURATION, 'gu'))]
      .map(match => durationValue(match[1]!))
      .filter((value): value is number => value !== null)
    if (durations.length === 0) continue
    const unique = new Set(durations)
    // 锚点必须**先剥掉时间量本身**再取窗口：否则「十年」是「二十年」的子串，
    // 「父亲十年前落水失踪。温珩二十年不换短褂。」会因为锚点「十年」跨句同时
    // 沾上 10 和 20 而报出假冲突——真正冲突的是「同一件事」，不是数字词互为子串。
    const withoutDurations = sentence.replace(new RegExp(DURATION, 'gu'), '　')
    // 每个偏移都生成 2/3/4 三种长度：只看贪婪的 4 字（或短窗只在序列末尾出现）
    // 会让「大火」这类锚点在长序列里根本不存在，「那场大火发生在三年前 /
    // 村落被大火焚毁已有三十年」就找不到共同的锚点。
    const runs = [...withoutDurations.matchAll(/[\u4e00-\u9fa5]+/gu)].map(match => match[0])
    for (const run of runs) {
      for (const length of [2, 3, 4]) {
        for (let start = 0; start + length <= run.length; start += 1) {
          const token = run.slice(start, start + length)
          const set = anchors.get(token) ?? new Set<number>()
          for (const value of unique) set.add(value)
          anchors.set(token, set)
        }
      }
    }
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
  const merged = new Map<string, { durations: Set<number>; sources: Set<string> }>()
  for (const section of sections) {
    for (const [anchor, durations] of durationAnchors(section.text)) {
      const entry = merged.get(anchor) ?? { durations: new Set<number>(), sources: new Set<string>() }
      for (const value of durations) entry.durations.add(value)
      if (durations.size > 0) entry.sources.add(section.label)
      merged.set(anchor, entry)
    }
  }

  // 按时间量集合归并：同一组冲突的多个锚点（「父亲」「落水」「父亲落水」）算一条。
  const bySignature = new Map<string, { durations: number[]; anchors: string[]; sources: Set<string> }>()
  for (const [anchor, entry] of merged) {
    if (entry.durations.size < 2) continue
    const durations = [...entry.durations].sort((left, right) => left - right)
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