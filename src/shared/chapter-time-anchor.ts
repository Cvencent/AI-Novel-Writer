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
  + '|当晚过去|一夜过去|这一夜过去)'
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
 * 这是全模块唯一的判据入口：`findUndatedStreak` 只问它「本章交代了没有」，
 * 不自己去数词——这样形态的覆盖范围只在一处维护，也就只在一处出错。
 */
export function statesDayBoundaryText(content: string): boolean {
  return DAY_BOUNDARY_PATTERN.test(String(content ?? ''))
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
 * 「最近 N 章没有任何跨日交代」→ 一致性发现（issue #84）。
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
      // key 带**这一段的首章**：作者把这段时间推进补上后，下一次扫描这一段就不再出现，
      // 提示自然消失；带末章则会让同一条提示随着新章继续往后滚动（与 #79 的教训相反，
      // 这里「消失」靠的是判据本身不再成立，而不是 ack）。
      stableFactKey: `chapter-time:undated:${streak.chapters[0]}:${streak.chapters[streak.chapters.length - 1]}`,
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