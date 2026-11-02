import { splitProseSentences } from './finalized-continuity-facts'

/**
 * 同一件物证被终结两次（issue #73）。
 *
 * 实测样本：主线唯一的实物证据是绞盘下那圈绳上的三个结。
 *
 * - 第 27 章蓝图与正文都写「三个结被**一一解开**，绳头往滚筒底下一塞」——结没了。
 * - 第 29 章又写「露出底下压死的**三个结**。剪子伸进去，一下，一下，一下」——再剪一遍。
 *
 * 两次都被写成同一件事的后果（「全叔二十年装糊涂的护身壳破了」），等于同一件物证
 * 被终结了两次。这是蓝图层的 `【同章道具不得自相矛盾】`（#19）管不到的地方——
 * 那条只管**同一章内**，跨章的「已经没了的东西又被取出」从来没人看。
 *
 * 判据是**结构性的**，不枚举「解开 / 剪断 / 烧掉」这些词：
 * 对同一个名词，问「它是否在不同的章里各自被一个终结动作处理过」。
 * 终结动作本身用一小撮高通用度的动词（解/剪/烧/扔/交/埋/撕/砸/毁/丢/沉），
 * 但**判据的主体是同一个名词**——换一件物证、换一个动作，判据照样成立。
 */

/** 高通用度的「终结」动作：处理掉、毁掉、交出去。 */
const TERMINAL_ACTIONS = Object.freeze([
  '解开', '解下', '剪断', '剪掉', '剪开', '烧掉', '烧毁', '扔掉', '丢下', '丢掉',
  '埋掉', '埋下', '撕掉', '撕碎', '砸碎', '砸掉', '毁掉', '毁去', '沉掉', '沉了',
  '交还', '交回', '交出', '抄走', '收走', '夺走', '拿走', '塞进', '压死',
] as const)

const QUESTIONABLE_QUESTIONS = /[?？]/u

/**
 * 物证名词：连续 CJK 串里长度 3–5 的窗口。
 *
 * 取 3–5 而不是 2–4：2 字窗口（「绳圈」「滚筒」）会把大量日常名词卷进来，
 * 而本样本的锚点「三个结」是 3 字。上限 5 覆盖「靛蓝短褂」这类复合名词。
 */
const PROP_WINDOW = [3, 4, 5] as const

export interface ChapterProse {
  chapterNumber: number
  content: string
}

export interface PropTermination {
  prop: string
  /** 终结它的章号（升序）。 */
  chapters: number[]
  /** 每章里那句原文（用于证据展示）。 */
  excerpts: string[]
}

/** 一个名词在某章是否被终结动作处理过。 */
function terminatorsIn(content: string): Array<{ action: string; sentence: string }> {
  const found: Array<{ action: string; sentence: string }> = []
  for (const sentence of splitProseSentences(content)) {
    for (const action of TERMINAL_ACTIONS) {
      if (sentence.includes(action)) found.push({ action, sentence })
    }
  }
  return found
}

/** 某章里出现过、且同句或紧邻句带终结动作的名词片段。 */
function terminatedPropsInChapter(content: string): Map<string, string> {
  const props = new Map<string, string>()
  for (const { action, sentence } of terminatorsIn(content)) {
    const index = sentence.indexOf(action)
    // 只看动作**前面**的那一小段：中文里「解开三个结」的宾语在动词后，
    // 但「三个结被解开」在动词前。两种都要覆盖，所以整句都在窗口内。
    const span = sentence.slice(Math.max(0, index - 12), index + action.length + 6)
    for (const run of span.matchAll(/[\u4e00-\u9fa5]+/gu)) {
      for (const length of PROP_WINDOW) {
        for (let start = 0; start + length <= run[0].length; start += 1) {
          const token = run[0].slice(start, start + length)
          if (!props.has(token)) props.set(token, sentence)
        }
      }
    }
  }
  return props
}

/**
 * 找出「同一件物证在不同章里各自被终结过一次」的情况。
 *
 * 只报**跨章**（同一章内的矛盾由蓝图层 #19 与同章检测负责），
 * 且章号要相邻或接近（间隔 > 8 章时，读者早已不记得那件东西，「重新出现」更像
 * 是新引入而不是自相矛盾）。
 *
 * 反噪措施：
 * - 要求这个名词在**至少两章**里都带终结动作；
 * - 名词里不得含疑问句（「三个结是什么」不是终结）；
 * - 上限 4 条，按覆盖章数排序。
 */
export const PROP_TERMINATION_MAX_GAP = 8

export function findRepeatPropTermination(
  chapters: readonly ChapterProse[],
  options: { maxGap?: number } = {},
): PropTermination[] {
  const maxGap = options.maxGap ?? PROP_TERMINATION_MAX_GAP
  const byProp = new Map<string, { chapters: number[]; excerpts: string[] }>()
  const ordered = [...chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
  for (const chapter of ordered) {
    for (const [prop, sentence] of terminatedPropsInChapter(String(chapter.content))) {
      if (QUESTIONABLE_QUESTIONS.test(sentence)) continue
      const entry = byProp.get(prop) ?? { chapters: [], excerpts: [] }
      if (!entry.chapters.includes(chapter.chapterNumber)) {
        entry.chapters.push(chapter.chapterNumber)
        entry.excerpts.push(sentence.trim())
      }
      byProp.set(prop, entry)
    }
  }
  const candidates: PropTermination[] = []
  for (const [prop, entry] of byProp) {
    if (entry.chapters.length < 2) continue
    const chapters = [...entry.chapters].sort((left, right) => left - right)
    // 章号要相邻或接近：间隔太大时读者记不住，重新出现更像新引入。
    const contiguous = chapters.every((chapter, index) => (
      index === 0 || chapter - chapters[index - 1]! <= maxGap
    ))
    if (!contiguous) continue
    candidates.push({ prop, chapters, excerpts: entry.excerpts })
  }
  return candidates
    .sort((left, right) => right.chapters.length - left.chapters.length || left.prop.localeCompare(right.prop))
    // 只留「命名更具体」的锚点：4 字窗口常包含 3 字窗口（「三个结」⊂「下三个结」），
    // 全报出来同一件事会重复三遍。保留不在别人内部的那个。
    .filter((candidate, _index, all) => !all.some(other => (
      other !== candidate && other.chapters.join(',') === candidate.chapters.join(',')
      && other.prop.includes(candidate.prop) && other.prop !== candidate.prop
    )))
    .slice(0, 4)
}