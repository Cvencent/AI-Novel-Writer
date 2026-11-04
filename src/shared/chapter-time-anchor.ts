/**
 * 章级时间推进（issue #84）。
 *
 * 现象：那本 34 章的悬疑长篇**全书没有一次跨日或时间间隔交代**——
 * 「次日／翌日／第二天／隔天／三天后／半个月」合计 **0 次**；8/34 章正文里
 * 连一个时间词都没有；其余章只靠「天亮 7 章 / 昨夜 11 章 / 下午 2 章」三个词互相循环。
 * 第 28 章写「他记得**昨夜**全叔蹲在缆桩边」，而那句指的是**第 26 章**的场景，
 * 中间只隔一章、且没有任何日界——读者无从判断这个「昨夜」是哪一夜。
 *
 * 根因不是模型偷懒，而是**这一层从没被提供过**：
 *
 *   1. `src/shared/chapter-time-continuity.ts` 把「同一天紧接」设为**默认**
 *      （「作者没有写明跨日或时间间隔时，视为同一天内的紧接发展」），
 *      而它又把责任推给「蓝图/正文里有没有写明」——链路里没有任何一处**产出**时点。
 *   2. 蓝图合同（`blueprint-semantic-contract.ts`）的必填字段里**没有「本章时点」**，
 *      `blueprints` 表也没有对应列。
 *   3. 唯一的检测器 `timeline-anchors.ts`（#2）只比**设定层**，明确不碰正文/蓝图。
 *
 * 所以本模块给两端各补一块：
 *
 *   - **产出**：蓝图 `keyEvents` 末尾增加「【时点：…】」标注
 *     （`timeAnchorOf` 读它，与 #28 的【收束】、#32 的【装置】同一形态）；
 *     蓝图生成与起草提示词都能带上**上一章的时点**，让推进可见。
 *   - **判定**：`findUndatedStreak` 扫已定稿正文，报「连续 N 章没有任何跨日或
 *     时间间隔交代」——判据是**这一类词的缺席**，不是词表匹配。
 *
 * 与 #2（`timeline-anchors.ts`）不重叠：#2 比的是**设定层**同一件事配了两个时间量
 * （三年前 vs 十年），输入是前提/世界观/角色图谱；本条比的是**章与章之间过了多久**，
 * 输入是定稿正文序列。两个判据的输入与位置都不同。
 */
import type { ConsistencyFinding } from './consistency-preflight'

/**
 * 跨日或时间间隔的交代**形态**（封闭的语法，不是开放词表）。
 *
 * 组成：
 *   ① 序数日界词 —— 次日／翌日／隔天／第二天／转天…
 *   ② 「数量 + 时间单位 + 过去/之后」—— 三天后／半个月后／两周以后／一年之后…
 *      数量用中文数字或阿拉伯数字都算（`[一二三四五六七八九十百千两数几]+`）。
 *   ③ 明说「过了一些时间」的短语 —— 过了几天／几天过去了／又过了两周…
 *
 * ⚠️ 两条实测踩过的反面教训，都写进测试：
 *   a) **不能只枚举「N天后」的固定组合**：我第一版列了「三天后」却漏了「三日后」，
 *      于是正文里明明写了日界仍被判成「没有交代」（假阳性方向）。
 *      用 `数字 + (天|日|周|月|年) + 后/之后` 的**模式**才能覆盖任意数量与单位。
 *   b) **前缀不能可接任意量词**：「过了两」会命中「过了**两息**」（两口气的停顿，
 *      当天内），把一段连续无日界硬生生断开（假阴性方向）。所以「过了 N」后面
 *      必须跟**时间单位**，不能是「息」「步」「抬眼」这类当天内的短促动作量词。
 */
const CHINESE_NUMERAL = '[一二三四五六七八九十百千万两数几半]+'
/**
 * ⚠️ 单位要**长词在前**：正则交替是**先匹配先赢**，把「月」放在「个」前面时
 * 「半个月后」会先在「月」处匹配、而前面的「个」不满足 `数量+单位` 的形态 → 整条漏判。
 * 「礼拜」「星期」同理必须排在「周」之前。数量与单位之间允许一个「个」。
 */
const TIME_UNIT = '(?:个?(?:礼拜|星期)|个?月|天|日|周|年)'
const DAY_BOUNDARY_PATTERN = new RegExp(
  // ① 序数日界词。⚠️「第二天」后必须不是「性／次／个」——否则会命中「第二天性」
  //   （天性）、「第二次见面」这类普通词组，实测「他第二天性使然」假阳性。
  '(?:次日|翌日|隔天|隔日|第二天(?![性次个])|转天|改天'
  + '|到了第二|到第二天'    // 「到了第二天夜里」
  + '|当晚过去|一夜过去|这一夜过去'
  // 蓝图标注里会把「跨日」直接写出来（实测「次日天亮前至上午（紧接上一章，跨日）」），
  // 也可能单独只标这一个词。它是封闭术语、语义唯一，收进来（issue #132）。
  + '|跨日)'
  // ② 数量 + 时间单位 + 过去/之后：「三天后」「半个月后」「两个礼拜以后」
  + `|(?:${CHINESE_NUMERAL}|[0-9]+)\\s*${TIME_UNIT}\\s*(?:后|之后|以后|过去|过去了)`
  // ③ 序数 + 时间单位（不带「后」）：「第二年春天」「第三天夜里」
  + `|第[一二三四五六七八九十${'百千万'}]+(?:天|日|夜|年|个?月|周|个?(?:礼拜|星期))(?![性次个])`
  // ④ 明说「过了一些时间」：「过了几天」「数日过去」「又过了两周」
  + `|(?:又?过了|经过了|过去了)\\s*(?:(?:${CHINESE_NUMERAL}\\s*${TIME_UNIT})|几天|几日|数日|些日子|一段日子|些天|好些天|一阵子)`,
  'u',
)

/**
 * 这一章有没有**明确写出**跨日或时间间隔。
 *
 * 这是「**有没有提到时间在走**」这个较弱问题的唯一入口：`findUndatedStreak` 只问它
 * 「本章交代了没有」，不自己去数词——这样形态的覆盖范围只在一处维护，也就只在一处出错。
 *
 * ⚠️ 它**不回答**「本章开头有没有交代日界」那个更强的问题（issue #146）：本函数只看
 * 全文有没有命中，**不看在哪个位置**、也不管那一句是不是在说将来的期限
 * （「公司回话三日后到」在它眼里同样是 true）。强问题的入口是
 * `chapterBoundaryHits` / `openingDayBoundary`。
 */
export function statesDayBoundaryText(content: string): boolean {
  return DAY_BOUNDARY_PATTERN.test(String(content ?? ''))
}

/** 句子边界字符（句末标点与换行）。 */
const SENTENCE_TERMINATORS = '。！？；…\n'
/** 句子开头允许出现的**非实词**标记：各种开引号/括号/破折号/空白。 */
const SENTENCE_LEAD_MARKERS = /^[「『“‘（(【—–\-·\s]*$/u

function sentenceStartOf(text: string, at: number): number {
  for (let index = at - 1; index >= 0; index -= 1) {
    if (SENTENCE_TERMINATORS.includes(text[index]!)) return index + 1
  }
  return 0
}

/** 这一处记号是否**位于句首**（前面只有空白与开引号/括号/破折号）。 */
function isSentenceInitial(text: string, at: number): boolean {
  return SENTENCE_LEAD_MARKERS.test(text.slice(sentenceStartOf(text, at), at))
}

/** 取记号所在的那一句（截断到 40 字，供证据引用）。 */
function sentenceAround(text: string, at: number): string {
  const start = sentenceStartOf(text, at)
  let end = text.length
  for (let index = at; index < text.length; index += 1) {
    if (SENTENCE_TERMINATORS.includes(text[index]!)) { end = index; break }
  }
  return text.slice(start, end).trim().slice(0, 40)
}

/**
 * 「数量 + 时间单位 + 后/之后/以后」这一族——它**既能**交代本章从上一章过了多久，
 * **也能**修饰一个将来的事件（「公司回话三日后到」）。区分它们不靠词表，靠**句法位置**：
 * 交代日界的写法是把时间状语放在句首（「两日后，送检结案日」「三天后，船靠了埠」）；
 * 而作将来期限用时它前面一定还有一个主语/宾语（「公司回话三日后到」「他三天后走」）。
 *
 * 所以：这一族只有**落在句首**才算本章日界（issue #146 的「朝前看」排除）。
 * 其余族（次日/翌日/第三天/过了几天）本身就是对「已经过了多久」的陈述，不看位置。
 */
const DURATIVE_FUTURE_FORM = new RegExp(
  `^(?:${CHINESE_NUMERAL}|[0-9]+)\\s*${TIME_UNIT}\\s*(?:后|之后|以后)$`,
  'u',
)

export interface ChapterBoundaryHit {
  /** 在文本中的偏移量（用于取最早出现的那一处）。 */
  at: number
  /** 隔了几天；读不出确定天数时为 null（如「过了几天」）。 */
  days: number | null
  /** 记号所在的那一句（证据引用）。 */
  quote: string
}

/**
 * 一段文字里**算作本章日界**的记号，按出现位置排序（issue #146）。
 *
 * 与 `statesDayBoundaryText` 的区别只有一条：本函数会剔除「数量 + 单位 + 后」
 * 这类**不在句首**的写法（那是朝前看的期限，不是本章的日界）。
 */
export function chapterBoundaryHits(text: string): ChapterBoundaryHit[] {
  const value = String(text ?? '')
  const global = new RegExp(DAY_BOUNDARY_PATTERN.source, 'gu')
  const hits: ChapterBoundaryHit[] = []
  for (const match of value.matchAll(global)) {
    const raw = match[0]
    const at = match.index ?? 0
    if (DURATIVE_FUTURE_FORM.test(raw) && !isSentenceInitial(value, at)) continue
    hits.push({ at, days: dayGapOf(raw), quote: sentenceAround(value, at) })
  }
  return hits.sort((left, right) => left.at - right.at)
}

/**
 * 一章**开头**（场景初起）交代的日界：取最早的那一处（issue #146）。
 *
 * ⚠️ 窗口大小与「朝前看」的排除必须**分成两件事**（这正是 #143 改坏的根因）：
 * - 旧实现用「窗口只有 2 段」**间接**排除章内的期限，于是把写在**第 3–4 段**的真日界
 *   一起漏掉了（实测第 20 章首段台词、次段动作、三段交代案头，**第 4 段才是
 *   「第三日了」**，而蓝图【时点】正是「第三日」→ 判成「正文没有日界」，反向假阳性）；
 * - 现在窗口放宽到**场景初起**（人物在哪、正在做什么也算开头），期限由
 *   `DURATIVE_FUTURE_FORM` + 句首位置单独排除，两者不再互相牵制。
 */
export const DAY_BOUNDARY_OPENING_PARAGRAPHS = 6

export function openingWindow(content: string): string {
  const paragraphs = String(content ?? '')
    .split(/\n+/u)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
  return paragraphs.slice(0, DAY_BOUNDARY_OPENING_PARAGRAPHS).join('\n')
}

/** 章首窗口里的第一处日界；没有就返回 null（正文没写日界）。 */
export function openingDayBoundary(content: string): ChapterBoundaryHit | null {
  const scope = openingWindow(content)
  const hits = chapterBoundaryHits(scope)
  return hits[0] ?? null
}

/**
 * 时段词：能标出一个**当天内的时点**，但不表示「过了多久」。
 *
 * 单独列出来是为了**证据**：报告要能指给作者看「你只在这几个词之间循环」
 * （实测那本书就是 天亮 / 昨夜 / 下午 三词循环）。判定本身不靠它——
 * 有时段词而没有跨日词，恰恰是「一直在同一天附近打转」的形态。
 */
export const TIME_OF_DAY_PHRASES = Object.freeze([
  '天亮', '天光', '今早', '早上', '清晨', '上午', '中午', '正午', '下午', '傍晚',
  '黄昏', '入夜', '夜里', '晚上', '当晚', '今夜', '夜里', '深夜', '半夜',
  '昨夜', '昨晚', '昨天', '前一天', '那晚', '当夜',
] as const)

export interface TimeProseChapter {
  chapterNumber: number
  content: string
}

export interface UndatedStreakOptions {
  /**
   * 连续多少章没有任何跨日交代才报。默认 8。
   *
   * 8 是刻意保守的：一本 800 字一章的连载里，连着 8 章都发生在同一夜且没有任何
   * 日界说明，读者已经无法判断故事推进了多久（那本书 34 章是 0 次）。
   * 更短的窗口会给「一场长夜戏拆成几章」的正常写法刷噪声。
   */
  minStreak?: number
  /** 参与判定的最少章数：样本不足不判（与 prose-repetition 的门槛同一考虑）。 */
  minChapters?: number
}

export interface UndatedStreak {
  /** 这一段连续无跨日交代的章号（升序）。 */
  chapters: number[]
  /** 这段里实际出现过那些时段词（供作者核对「是不是只在几个词之间循环」）。 */
  timeOfDayWords: Array<{ phrase: string; chapters: number[] }>
}

/**
 * 找出「连续多章都没有任何跨日或时间间隔交代」的段。
 *
 * 判据是**这一类词的缺席**：某章正文里不出现 `DAY_BOUNDARY_PHRASES` 任何一条，
 * 就算「没有交代时间推进」。断在哪一章就重新起一段——只要有一章写了跨日，
 * 链条就断开（与 #66 通牒连胜、#71 章首链同一口径：**章号必须相邻**）。
 *
 * 为什么这是结构判据而不是词表匹配：它在问「**这件事有没有被做**」，
 * 而「做过」的证据是一个**封闭、可穷举**的集合（跨日说法就那几个）。
 * 反过来「没做」的误报风险来自「真的整本书发生在同一夜」——对长篇不成立，
 * 且 minStreak=8 已经足够保守。
 */
export function findUndatedStreak(
  chapters: readonly TimeProseChapter[],
  options: UndatedStreakOptions = {},
): UndatedStreak[] {
  const minStreak = options.minStreak ?? 8
  const minChapters = options.minChapters ?? 8
  const ordered = [...chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .map(chapter => ({ chapterNumber: chapter.chapterNumber, content: String(chapter.content) }))
  if (ordered.length < minChapters) return []
  if (minStreak <= 0) return []

  const streaks: Array<TimeProseChapter[]> = []
  let current: TimeProseChapter[] = []
  for (const chapter of ordered) {
    const statesDayBoundary = statesDayBoundaryText(chapter.content)
    if (statesDayBoundary) {
      // 有跨日交代 → 链条断开，把这之前的连续段收掉。
      if (current.length >= minStreak) streaks.push(current)
      current = []
      continue
    }
    // 章号必须相邻：断号说明中间缺章，不算同一段连续推进。
    const previous = current.at(-1)
    if (previous && chapter.chapterNumber !== previous.chapterNumber + 1) {
      if (current.length >= minStreak) streaks.push(current)
      current = []
    }
    current.push(chapter)
  }
  if (current.length >= minStreak) streaks.push(current)

  return streaks.map(streak => ({
    chapters: streak.map(chapter => chapter.chapterNumber),
    timeOfDayWords: TIME_OF_DAY_PHRASES
      .map(phrase => ({
        phrase,
        chapters: streak.filter(chapter => chapter.content.includes(phrase)).map(chapter => chapter.chapterNumber),
      }))
      .filter(item => item.chapters.length > 0)
      .sort((left, right) => right.chapters.length - left.chapters.length),
  }))
}

/**
 * 章节蓝图的时点标注（「…【时点：次日清晨】」）。
 *
 * 与 #28 的【收束】、#32 的【装置】同一形态：写在 `keyEvents` 末尾，
 * 由合同要求、由下游读取（`timeAnchorOf`），作者在界面上以只读 chip 看到。
 *
 * 为什么必须落进蓝图而不是靠正文自觉：链路上**没有任何一处产出时点**
 * （见本文件头部），而 `chapter-time-continuity.ts` 的默认是「同一天紧接」——
 * 没有时点，那个默认就永远生效，跨日永远写不出来。
 */
export function timeAnchorOf(keyEvents: string): string {
  const matches = [...String(keyEvents ?? '').matchAll(/【\s*时点\s*[:：]\s*([^】]{1,40})】/gu)]
  return matches.at(-1)?.[1]?.trim() ?? ''
}

/** 机器读的时间标注形态（`splitBlueprintLabels` 用它把标注从可编辑正文里拆出来）。 */
export const BLUEPRINT_TIME_ANCHOR_LABEL_PATTERN = /【\s*时点\s*[:：][^】]{0,60}】/gu

/**
 * 「蓝图声明了跨日，正文一字未提」→ 一致性发现（issue #132）。
 *
 * #84 补的是两端：产出端（蓝图合同要求标【时点】）与判定端（连续 N 章没有跨日交代）。
 * 缺的是**两侧比对**——`statesDayBoundaryText` 只看正文自己有没有日界词，从不看
 * 本章蓝图声明了什么。实测那本书 24 章带标注、5 章声明跨日，**4 章正文一字未提**
 * （ch45 次日清晨 / ch49 次日天亮前（跨日）/ ch52 次日午后 / ch55 次日上午），
 * 只有 ch57 落实（「两日后，送检结案日。」）。
 *
 * 为什么不能靠连胜判据兜住：`findUndatedStreak` 按「连续 N 章」聚合，ch45/ch49
 * 恰好夹在一段连胜里被一并吞掉，提示不指向真正要改的那一句；而这两类的处置完全不同
 * （「有声明没落实」= 回去补一句日界；「没声明」= 先在蓝图里想清时间）。
 *
 * 判据是**同一套形态在两侧各跑一遍**（不新增词表）：
 * - 蓝图侧：`statesDayBoundaryText(标注原文)` 为真 → 它声明了跨日；
 * - 正文侧：`statesDayBoundaryText(本章正文)` 为假 → 正文没写出日界；
 * - 两者同时成立即报。第 1 章没有上一章可跨，跳过。
 */
export interface TimeAnchoredChapter extends TimeProseChapter {
  /** 本章蓝图 `keyEvents`（含【时点：…】标注）；没有蓝图就不判。 */
  keyEvents?: string
}

export function findUnmetTimeAnchorFindings(
  chapters: readonly TimeAnchoredChapter[],
): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = []
  const ordered = [...chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
  for (const chapter of ordered) {
    const anchor = timeAnchorOf(chapter.keyEvents ?? '')
    if (!anchor) continue
    // 蓝图自己没声明跨日（「同日夜」「紧接上章当夜」）→ 不是这一条要管的事。
    if (!statesDayBoundaryText(anchor)) continue
    // 第 1 章没有上一章，跨日无从谈起。
    if (chapter.chapterNumber <= 1) continue
    // ⚠️ 只认**章首窗口**里的日界，且剔除朝前看的期限（issue #143 → #146）：
    // 日界是本章开头对上一章的交代，章内「公司回话三日后到」不是本章日界。
    //
    // 有两件事必须分开表达（#146 的教训）：**窗口多宽** 与 **期限怎么排除**。
    // 窗口按「场景初起」算（人物在哪、正在做什么——实测第 20 章的日界在第 4 段），
    // 期限靠 `DURATIVE_FUTURE_FORM` + 句首位置排除，不再靠「把窗口调小」间接实现。
    //
    // 但有一类章**本来就写在章内跨日**：蓝图【时点】自己声明了这次推进发生在
    // 本章之内（形态「…至/到…次日/翌日…」，如「当晚开航至次日靠埠」）。对这类章，
    // 跨日写在章内某处才对（实测第 59 章把「靠埠是次日晌午」写在章中、章首只写起点），
    // 所以这一类的「已落实」判定要放开到整章。
    const anchorSpansWithinChapter = /(?:至|到|直到)\s*[^。！？\n]{0,6}(?:次日|翌日|第二天|隔天|隔日)/u.test(anchor)
    const proseScope = anchorSpansWithinChapter ? String(chapter.content) : openingWindow(chapter.content)
    const proseBoundary = chapterBoundaryHits(proseScope)[0] ?? null
    const proseStates = proseBoundary !== null
    const opening = (String(chapter.content).trim().split(/\n+/u)[0] ?? '').trim().slice(0, 40)

    // 两侧都说了日界，但**隔的天数不一样**（issue #134）：第 57 章蓝图标「次日」、
    // 正文写「两日后」——#132 的布尔判据当时判成「已落实」。这里补上数值比对。
    // 只有两侧都读得出确定的日数、且确实不等时才报；读不出来（null）一律放过。
    const anchorGap = dayGapOf(anchor)
    const proseGap = proseBoundary?.days ?? null
    if (proseStates && anchorGap !== null && proseGap !== null && anchorGap !== proseGap) {
      findings.push({
        // 章号是既成事实，不随写作推进而变（#86/#89/#98/#108）。
        stableFactKey: `chapter-time:anchor-gap-mismatch:${chapter.chapterNumber}`,
        severity: 'warning' as const,
        sourceChapter: chapter.chapterNumber,
        evidence: `第${chapter.chapterNumber}章：蓝图【时点：${anchor}】（隔 ${anchorGap} 天），正文写的是「${opening}」（隔 ${proseGap} 天）`,
        issue: {
          zhCN: `时间推进对不上：蓝图声明这一章发生在「${anchor}」，也就是上一章之后第 ${anchorGap} 天；正文却写成 ${proseGap} 天之后（开头「${opening}」）。差 ${Math.abs(anchorGap - proseGap)} 天会顺着后面所有「N 日后」「N 日内」的期限一起漂。`,
          enUS: `The time jump disagrees: the blueprint places this chapter on day ${anchorGap} after the previous one (【时点: ${anchor}】), but the prose opens with a ${proseGap}-day gap (“${opening}”). A difference of ${Math.abs(anchorGap - proseGap)} day(s) shifts every later deadline that counts from here.`,
        },
        suggestion: {
          zhCN: `两者改成一致：把正文那句日界改成蓝图声明的第 ${anchorGap} 天，或若正文才是对的，就改蓝图的【时点】标注。注意上一章末尾可能已经交代过同一个跨度（实测第 56 章就写过「两日后送检出」），改的时候要顺着那一处一起看，别让同一个跨度被数两遍。`,
          enUS: `Make them agree: rewrite the prose boundary as day ${anchorGap}, or fix the blueprint's 【时点】 label if the prose is right. Check the previous chapter's ending too — it may already state the same span, and the two must not count it twice.`,
        },
      })
      continue
    }

    // 正文写出了日界 → 已落实。
    if (proseStates) continue
    findings.push({
      // key 里带的是**问题章号**（那一章是既成事实，不随写作推进而变），
      // 不是当前章号——后者会让提醒永远关不掉（#86/#89/#98/#108）。
      stableFactKey: `chapter-time:anchor-unmet:${chapter.chapterNumber}`,
      severity: 'warning' as const,
      sourceChapter: chapter.chapterNumber,
      evidence: `第${chapter.chapterNumber}章：蓝图【时点：${anchor}】，正文没有日界；正文开头「${opening}」`,
      issue: {
        zhCN: `本章蓝图声明了时间推进（【时点：${anchor}】），正文里却没有任何跨日或时间间隔的交代，开头是「${opening}」。上一章结尾与这一章之间到底隔了多久，读者只能按「同一夜接着写」来读——人物却已经换过班、换过地方。`,
        enUS: `This chapter's blueprint declares a time change (【时点: ${anchor}】), but the prose states no day boundary or gap; it opens with “${opening}”. Readers can only take it as the same night continuing, even though characters have changed shifts or places.`,
      },
      suggestion: {
        zhCN: `在正文开头补一句日界，把蓝图声明的时间落到纸面：例如「次日天没亮，……」或「隔了一天，……」。若这一章其实与上一章同一夜，那就改蓝图的【时点】标注（作者可在蓝图页修正）——两者必须一致，别让 chip 说次日、正文写当夜。`,
        enUS: `Open the prose with an explicit day boundary that matches the blueprint, e.g. "before dawn the next day, …" or "a day later, …". If the chapter really continues the same night, fix the blueprint's 【时点】 label instead — the two must agree.`,
      },
    })
  }
  return findings
}

/**
 * 从一段文字里读出**隔了几天**（issue #134）。
 *
 * 为什么需要它：`statesDayBoundaryText` 是**布尔**——「次日」「两日后」「三日后」
 * 在它眼里是同一个 `true`。实测第 57 章蓝图标「次日」、正文写「两日后」，差整整
 * 一天，而 #132 的判据因为两侧都 true 判成「已落实」。
 *
 * 判据仍是**封闭语法**，只认三类能确定数值的写法（其余一律 null，不猜）：
 * - 序数日界：次日/翌日/第二天 → 1；隔天/隔日 → 1；第三天 → 2；
 * - 数量 + 时间单位 + 后/之后：两天/两日/三日/一周/半个月…；
 * - 「第 N 天/日」。
 *
 * 单位换算做**保守**的一档：日/天 = 1，周/礼拜/星期 = 7，月 = 30，年 = 365。
 * 读数只用于「两侧差多少」的比较，所以换算精度不影响判断（同样的写法两侧会得到
 * 同样的数）；只有**两侧用了不同单位**并且恰好接近时才会差一点，那种情况
 * 一律按「不确定」放过（见 `findUnmetTimeAnchorFindings` 的容差）。
 *
 * 刻意不读：「明天」「后天」这类相对指示（没有上一章的绝对日期就无法换算）。
 */
const DAY_UNIT: Record<string, number> = { 天: 1, 日: 1, 周: 7, 礼拜: 7, 星期: 7, 月: 30, 年: 365 }

function chineseNumber(value: string): number | null {
  if (/^\d+$/u.test(value)) return Number(value)
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  if (value === '半') return 0.5
  if (value.length === 1) return digits[value] ?? null
  // 「十二」「二十」「二十三」：
  const match = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/u.exec(value)
  if (!match) return null
  const tens = match[1] ? digits[match[1]]! : 1
  return tens * 10 + (match[2] ? digits[match[2]]! : 0)
}

/** 读出一段文字声明的**日数间隔**；读不确定就返回 null（不猜）。 */
export function dayGapOf(text: string): number | null {
  const value = String(text ?? '')
  // ⚠️ 按**出现位置**收集，不能「先扫①再扫②」（issue #143）：分两轮 push 会让
  // 「三日后才是结案日。次日清早他就上了船。」拿到 1（次日在第①轮里），
  // 而全文最早出现的其实是「三日后」。
  const found: Array<{ at: number; days: number }> = []
  // ① 序数日界词。
  for (const match of value.matchAll(/次日|翌日|隔天|隔日/gu)) found.push({ at: match.index ?? 0, days: 1 })
  for (const match of value.matchAll(/第([一二两三四五六七八九十]+)(?:天|日)/gu)) {
    const day = chineseNumber(match[1]!)
    if (day !== null && day >= 1) found.push({ at: match.index ?? 0, days: day - 1 })
  }
  // ② 数量 + 时间单位 + 后/之后/以后。
  for (const match of value.matchAll(/(\d+|[一二两三四五六七八九十]+|半)\s*(?:个)?(礼拜|星期|周|月|天|日|年)\s*(?:后|之后|以后)/gu)) {
    const count = chineseNumber(match[1]!)
    const unit = DAY_UNIT[match[2]!]
    if (count === null || unit === undefined) continue
    found.push({ at: match.index ?? 0, days: count * unit })
  }
  if (found.length === 0) return null
  // 取**最先出现**的那个日界记号（issue #143）。
  //
  // 旧实现取**最后一个**，依据是「后文更正前文」——那条假设是从 `timeAnchorOf`
  // 取最后一个【时点】借来的，但**两者语义不同**：蓝图【时点】是一行标注，后写的
  // 确实可能是更正；而正文里**先出现的那个才是本章的日界交代**，后面的往往是
  // 对将来的期限（「公司回话三日后到」），不是对本章时间的更正。
  // ⚠️ 调用方还会先切**章首窗口**（`openingWindow`），所以读到的不会是章末的期限。
  return found.sort((left, right) => left.at - right.at)[0]!.days
}

/**
 * 「蓝图声明了跨日，正文一字未提」→ 一致性发现（issue #132）。


 *
 * `sourceChapter` 取**样本末章 + 1**（即将写的那一章）：这条提示是给「落笔前」看的，
 * 与 `finalized-prose-audit` 里其余各项同一口径。
 */
export function findUndatedStreakFindings(
  chapters: readonly TimeProseChapter[],
  currentChapter: number,
  options: UndatedStreakOptions = {},
): ConsistencyFinding[] {
  return findUndatedStreak(chapters, options).map(streak => {
    const range = `${streak.chapters[0]}–${streak.chapters[streak.chapters.length - 1]}`
    const timeWords = streak.timeOfDayWords.slice(0, 4)
      .map(item => `${item.phrase}（${item.chapters.length} 章）`).join('、')
    const timeWordsEn = streak.timeOfDayWords.slice(0, 4)
      .map(item => `${item.phrase} (${item.chapters.length})`).join(', ')
    return {
      // key **只带这一段的首章**，不带末章（issue #89 修正）。
      //
      // 原来的注释只考虑「怎么让提示自然消失」（补上日界后这一段不再成立），
      // 漏了同一行上还挂着 #79 的「我已知，稍后处理」按钮：**判据会随新章滚动，key 就不能带末章号**。
      // 实测那本书 38 章零跨日交代，末章号每写一章 +1 → key 从 `...:1:38` 变成 `...:1:39`
      // → 上一章 ack 过的 key 对不上 → 提醒原样重报，按钮等于失效。
      // 而这一条恰恰是**最需要「稍后处理」**的（回改 30 多章的日界不可能一章内做完）。
      // 带首章仍是稳定的：这一段从第 1 章起就一直没交代过，作者真做了什么（补了日界、
      // 或那些章被改写），判据本身就不再成立，提示自然消失——两条路都通。
      stableFactKey: `chapter-time:undated:${streak.chapters[0]}`,
      severity: 'warning' as const,
      sourceChapter: currentChapter,
      evidence: timeWords
        ? `第 ${range} 章连续 ${streak.chapters.length} 章都没有跨日或时间间隔的交代；这段里出现过的时段词：${timeWords}`
        : `第 ${range} 章连续 ${streak.chapters.length} 章都没有跨日或时间间隔的交代，也没有任何时段词`,
      issue: {
        zhCN: `时间推进不明：第 ${range} 章连着 ${streak.chapters.length} 章没有任何跨日或时间间隔的交代（${timeWords ? `只在这几个词之间循环：${timeWords}` : '连时段词都没有'}）。读者读到这里说不出故事过了几天，而人物中间已经换过班次、结过账、递过话——按最自然的读法会把它当成同一夜反复。章数越往后，「昨夜」「当年」会慢慢稀释成没有指代的时间副词。`,
        enUS: `Time progression is unstated: chapters ${range} run ${streak.chapters.length} chapters with no day change or time gap (${timeWordsEn ? `cycling only among: ${timeWordsEn}` : 'not even a time-of-day word'}). Readers cannot tell how many days have passed while characters have changed shifts, settled accounts and passed messages — the natural reading is that it is all one night repeating. The longer the book, the more "last night" and "back then" degrade into time adverbs with no referent.`,
      },
      suggestion: {
        zhCN: '在这几章里补出时间推进：至少其中几章用一句明确的日界（「次日开航前」「隔了一天」「三日后账房来信」），并在蓝图 keyEvents 末尾标注【时点：…】让下一章的起草能按它换算。「昨夜」这类回指必须能对应到**有日界依据的**某一夜。',
        enUS: 'State the passage of time in these chapters: give at least some of them an explicit day boundary ("before departure the next day", "a day later", "three days on, a letter arrives"), and label each blueprint keyEvents with 【时点: …】 so the next chapter drafts against it. A back-reference like "last night" must map to a night that has a stated boundary.',
      },
    }
  })
}