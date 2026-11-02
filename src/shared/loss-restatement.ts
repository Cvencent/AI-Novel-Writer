import { splitProseSentences } from './finalized-continuity-facts'

/**
 * 同一笔遗忘被跨章重新宣告（issue #75）。
 *
 * 实测样本：金手指代价是「每溯读一次，墨吞掉主角一段记忆」，而同一笔记忆缺失
 * 被跨章重复宣告三遍，每次读起来都像新损失：
 *
 *   ch19  他记得自己开口要过这三个结，要它们做什么，那里空了。
 *   ch20  他记得让全叔打过这三个结，要它们做什么，脑子里空着。
 *   ch23  他记得让全叔打过这三个结，但为什么打，脑子里空着。
 *
 *   ch23  ……这他记得。……叮嘱了什么，却像被水洇开的墨，只剩一圈空壳。
 *   ch24  林棠托人递的那句话，他使劲想，还是空壳。
 *   ch25  他记得有人递过话，也记得是林棠递的。话里是什么，空的。……
 *
 * 金手指代价于是变成可重复计价，后面再写「他又忘了一件事」就没有分量。
 *
 * 已有判据都够不到：蓝图合同的「代价必须留账」（#36）只管**章内**；
 * `prose-repetition` 的两族词表是动作词（没动／蘸水）；`findCrossChapterAssertionReversals`
 * （#52）只比「是 X／不是 X」形态。报告里实测本书 29 章，三者对遗忘句 0 命中。
 *
 * 判据是**结构性**的，分两步，两步都不问剧情：
 *  ① 找「遗忘句」：同一处上下文里既有「记得」标记、又有缺失措辞；
 *  ② 找**同一件东西**：两个不同章都宣告缺失的短语，取它们在各章缺失句里的
 *     **公共子串**（长度 ≥3）。这才是「同一笔账」——不枚举「三个结」这类词，
 *     换一本书、换一个记忆对象仍然成立。
 */

/** 「记得」类措辞：记忆存在的标记。 */
const REMEMBER_MARKERS = ['他记得', '她记得', '我记得', '还记得', '记得起', '记得'] as const

/**
 * 「缺失／遗忘」措辞。
 *
 * 刻意**不含**单独的「空着」：它太常见（「铺位空着」「船舱空着」），会把正常的
 * 环境描写卷进来。这里只收与「记忆/认知缺失」直接绑定的说法。
 */
const FORGET_MARKERS = [
  '空了', '空着', '空壳', '摸不着', '想不起', '记不起', '答不上', '想不起来', '记不起来',
  '被水洇', '想不通', '记不真切',
] as const

/**
 * 「空着」单独出现时不算缺失标记（「铺位空着」「船舱空着」是环境描写）。
 * 只有跟在认知语境词后面才算——这是补回「空着」必须付出的代价，
 * 否则本样本第 20 章那句「脑子里空着」会被整组漏掉。
 */
const COGNITIVE_CONTEXT = /(?:脑子|心里|脑海|记忆|这里|那里|哪儿|哪儿|什么|为什么|答不上)/u

/**
 * 「仍然没想起来」式的承接短语。
 *
 * 判据要求**标记 + 未恢复**连读（「仍然没」「还是没」），而不是单独一个「还是」——
 * 报告里把 ch24 的「他使劲想，还是空壳」也算作重述三遍中的一遍，
 * 说明光有「还是」不足以说明读者读到的是延续而非重新宣告。
 */
const CARRY_OVER_PHRASES = [
  '仍然没', '仍旧没', '还是没', '依然没', '一直没', '始终没', '至今没', '照旧没',
] as const

/** 一句缺失句里，指称物至少 3 个汉字（比这短的不是名词）。 */
const REFERENT_MIN = 3
const REFERENT_MAX = 8

export interface ChapterProse {
  chapterNumber: number
  content: string
}

export interface LossRestatement {
  /** 被反复宣告缺失的那件东西（各章缺失句的公共子串）。 */
  referent: string
  /** 宣告它的章号（升序）。 */
  chapters: number[]
  /** 其中一章的原句（用于证据展示）。 */
  excerpt: string
}

/**
 * 一处的「遗忘句」文本。
 *
 * 用**两句窗口**而不是单句：报告里组二的关键句是「他记得有人递过话……（下一句）话里是什么，空的。」
 * ——「记得」与「空的」分在相邻两句里，按单句判会整组漏掉。
 * 反过来，窗口里出现「仍然没想起来」式承接短语时，这一处不算重新宣告。
 */
export function lossWindows(content: string): Array<{ text: string; sentence: string }> {
  const sentences = splitProseSentences(String(content ?? ''))
  const windows: Array<{ text: string; sentence: string }> = []
  for (let index = 0; index < sentences.length; index += 1) {
    for (const size of [1, 2]) {
      const window = sentences.slice(index, index + size)
      if (window.length < size) continue
      const text = window.join('')
      if (!REMEMBER_MARKERS.some(marker => text.includes(marker))) continue
      if (!forgetMarkerIn(text)) continue
      if (CARRY_OVER_PHRASES.some(phrase => text.includes(phrase))) continue
      // 优先记最短窗口：一句里同时有两者时不必把下一句也带进来。
      if (size === 2 && lossWindowsOfOne(window[0]!)) continue
      windows.push({ text, sentence: window.join('') })
    }
  }
  return windows
}

/**
 * 这段文字里有没有「缺失」标记。
 *
 * 「空着」需要认知语境的相邻词佐证：本样本里它是「脑子里空着」，
 * 而环境描写是「铺位空着」——两者的区别就在这些上下文词上。
 */
function forgetMarkerIn(text: string): boolean {
  return FORGET_MARKERS.some(marker => (
    marker === '空着' ? COGNITIVE_CONTEXT.test(text) || text.includes('空着') && COGNITIVE_CONTEXT.test(text) : text.includes(marker)
  ))
}

function lossWindowsOfOne(sentence: string): boolean {
  return REMEMBER_MARKERS.some(marker => sentence.includes(marker))
    && forgetMarkerIn(sentence)
    && !CARRY_OVER_PHRASES.some(phrase => sentence.includes(phrase))
}

/** 去掉记忆框架词后剩下的 CJK 片段（框架词本身不是「那件东西」）。 */
export function contentRuns(text: string): string[] {
  let stripped = text
  for (const marker of [...REMEMBER_MARKERS, ...FORGET_MARKERS, ...CARRY_OVER_PHRASES]) {
    stripped = stripped.split(marker).join('　')
  }
  return [...stripped.matchAll(/[\u4e00-\u9fa5]+/gu)].map(match => match[0])
}

/** 两个字符串的最长公共子串（只在同一段 CJK 串内部算，不跨标点拼接）。 */
export function longestCommonSubstring(left: string, right: string): string {
  let best = ''
  for (let start = 0; start < left.length; start += 1) {
    for (let end = start + REFERENT_MIN; end <= left.length; end += 1) {
      const candidate = left.slice(start, end)
      if (candidate.length > REFERENT_MAX) break
      if (!right.includes(candidate)) break
      if (candidate.length > best.length) best = candidate
    }
  }
  return best
}

/**
 * 章号窗口：宣告要落在相邻或接近的章里才算「同一笔被重述」。
 * 隔得远时读者早已接受那是旧事，重新提起更像回指而不是新损失。
 */
export const LOSS_RESTATEMENT_MAX_GAP = 4

export function findLossRestatement(
  chapters: readonly ChapterProse[],
  options: { maxGap?: number } = {},
): LossRestatement[] {
  const maxGap = options.maxGap ?? LOSS_RESTATEMENT_MAX_GAP
  const perChapter = [...chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .map(chapter => ({ chapterNumber: chapter.chapterNumber, windows: lossWindows(String(chapter.content)) }))
    .filter(entry => entry.windows.length > 0)
  if (perChapter.length < 2) return []

  // 两两比较各章的缺失句片段，取公共子串：那才是「同一件东西」。
  const byReferent = new Map<string, { chapters: Set<number>; excerpts: Map<number, string> }>()
  for (let left = 0; left < perChapter.length; left += 1) {
    for (let right = left + 1; right < perChapter.length; right += 1) {
      const a = perChapter[left]!, b = perChapter[right]!
      const referents = new Set<string>()
      for (const windowA of a.windows) {
        for (const windowB of b.windows) {
          for (const runA of contentRuns(windowA.text)) {
            for (const runB of contentRuns(windowB.text)) {
              const shared = longestCommonSubstring(runA, runB)
              // 只留「最长」的那个：同一对窗口会产出大量互为子串的候选。
              if (shared.length >= REFERENT_MIN) referents.add(shared)
            }
          }
        }
      }
      for (const referent of referents) {
        const entry = byReferent.get(referent) ?? { chapters: new Set<number>(), excerpts: new Map<number, string>() }
        entry.chapters.add(a.chapterNumber)
        entry.chapters.add(b.chapterNumber)
        if (!entry.excerpts.has(a.chapterNumber)) entry.excerpts.set(a.chapterNumber, a.windows[0]!.sentence)
        if (!entry.excerpts.has(b.chapterNumber)) entry.excerpts.set(b.chapterNumber, b.windows[0]!.sentence)
        byReferent.set(referent, entry)
      }
    }
  }

  const candidates: LossRestatement[] = []
  for (const [referent, entry] of byReferent) {
    const chapters = [...entry.chapters].sort((left, right) => left - right)
    if (chapters.length < 2) continue
    const close = chapters.every((chapter, index) => (
      index === 0 || chapter - chapters[index - 1]! <= maxGap
    ))
    if (!close) continue
    candidates.push({
      referent: referent.replace(/^[的了在和与及把将过着这那]/u, ''),
      chapters,
      excerpt: entry.excerpts.get(chapters[0]!) ?? '',
    })
  }
  return candidates
    .sort((left, right) => right.chapters.length - left.chapters.length
      || right.referent.length - left.referent.length
      || left.referent.localeCompare(right.referent))
    // 「同一笔账」会产出多个互为子串的锚点，且它们的**章号集合高度重叠**
    // （「这三个结」[19,20,23] 与「让全叔打过这三个」[20,23] 是同一处的不同切法）。
    // 按「章号集合的较小方 ≥ 一半落在较大方里」归并，每组只留最长的一个做代表。
    // 用章号重叠而不是子串包含：两个锚点的文本可以完全不互相包含，却指向同一处上下文。
    .filter((candidate, index, all) => !all.slice(0, index).some(earlier => {
      const candidateSet = new Set(candidate.chapters)
      const earlierSet = new Set(earlier.chapters)
      // 甲包含乙（或乙包含甲）时是同一处上下文的不同切法，只留先出现的那个
      // （已按「章数降序、锚点降序」排过，先出现的就是更完整的那条）。
      const contained = [...candidateSet].every(chapter => earlierSet.has(chapter))
        || [...earlierSet].every(chapter => candidateSet.has(chapter))
      return contained
    }))
    .slice(0, 4)
}