/**
 * 感官通道覆盖（issue #151）。
 *
 * 现场：71 章 68,790 字的一本书，**嗅觉只有 10 章**（每万字 1.60）、味觉 1 章、
 * 拟声 4 章；三类合起来 **57/71 章（80%）一次都没有**。而同书触觉类（湿 13.2、潮 12.1、
 * 水汽 8.1 每万字）密度极高——故事的舞台是夜航船、舱底积水、化浆池、霉仓，气味在题材里
 * 俯拾即是，正文却几乎不写。
 *
 * ## 为什么这是机制缺口，不是模型短板
 *
 * 起草模板（`builtin-prompt-templates.ts`）与精修模板都明写「通过五感细节（视觉、听觉、
 * 嗅觉、触觉）强化环境描写」，但：
 * - 审稿的 17 个维度里，文风那一维只有「比喻超配额 / 模板化生理反应 / 段尾总结腔 / 平均句长」；
 * - `AI_FLAVOR_QUOTAS` 同样只有那四项；
 * - 写前预检没有任何一条判据读它。
 *
 * 也就是说：「五感」是一条**只写进提示词、全链路零核对**的要求。这与 #93（审稿缺文风维度）、
 * #96（意象配额从未被检查）、#114（句长只封上限）是同一类问题——**只写进提示词、没人核对 = 等于没写**。
 *
 * ## 判据怎么定（都按 issue 的实测注意事项收窄）
 *
 * 1. **按章报**，不给全书平均值（作者要改的是某几章，不是一个百分比）；
 * 2. **阈值按「有嗅觉的章占比」**，不按每万字次数：实测两本书分别是 14% 与 17%，
 *    而一段正常的叙事不会在 4/5 的章里连一次气味都没有；
 * 3. 词表分两档——**环境气味**与**计时/比喻用法**，后者不算（issue 实测的假阳性）：
 *    - 「一炷香」是计时器（本章 6 次全是它），不是嗅觉；
 *    - 「咬」多为「咬牙」「锁舌咬得不紧」，不是味觉；
 *    - 「叮嘱」里的「叮」不是拟声。
 */
import type { ConsistencyFinding } from './consistency-preflight'

/**
 * 环境气味词族（**封闭语法类**：中文里能指示「闻到了什么」的构词）。
 *
 * ⚠️ 刻意**不收**单字「香」「味」：实测「香」6 次全是「一炷香」这个计时器，
 * 「味」也会命中「袖口的味道也记得」这类回忆。只收**带气味语素的双字以上构词**。
 */
const SMELL_WORDS = Object.freeze([
  '腥气', '铁腥', '血腥', '霉味', '霉气', '墨味', '油墨味', '焦味', '烟味', '糊味',
  '臭味', '酸味', '香味', '香气', '气味', '味道', '土腥', '潮腥', '膻味',
] as const)

/**
 * 味觉词族：**动作**（尝/咂/舔）与**味觉形容词**。
 *
 * ⚠️ 不收「咬」（实测全书 1 次是「锁舌咬得不紧」）、不收单字「苦」「甜」
 * （「苦力」「甜头」这类构词在民国航运题材里很常见）。
 */
const TASTE_WORDS = Object.freeze([
  // ⚠️ 全部是**双字以上**构词：单字「尝」会命中「尝试 / 何尝 / 未尝」，
  // 「舔」可以单用（「舔了舔」），所以只收它在**句内成词**的形态。
  '尝了尝', '尝一口', '尝一尝', '尝尝', '咂了咂', '咂嘴', '舔了舔', '舔一舔',
  '咸味', '发咸', '苦涩', '发苦', '辛辣', '甘甜', '回甘', '发酸',
] as const)

/**
 * 拟声词族。⚠️ 全用双字以上：单字「叮」会命中「叮嘱」，「当」会命中「当作/当时」。
 */
const SOUND_WORDS = Object.freeze([
  '吱呀', '吱嘎', '咔嚓', '哐当', '哐啷', '砰', '哗啦', '当啷', '叮当', '咕嘟', '轰隆', '扑通', '沙沙',
] as const)

export interface SensoryChannelMeasurement {
  chapterNumber: number
  smell: number
  taste: number
  sound: number
  /** 三类全为 0：这一章只有视觉与触觉。 */
  silent: boolean
}

function countWords(content: string, words: readonly string[]): number {
  let total = 0
  for (const word of words) {
    let index = content.indexOf(word)
    while (index >= 0) {
      total += 1
      index = content.indexOf(word, index + word.length)
    }
  }
  return total
}

/** 量一章的感官通道命中数（纯统计，不判好坏）。 */
export function measureSensoryChannels(chapterNumber: number, content: string): SensoryChannelMeasurement {
  const body = String(content ?? '')
  const smell = countWords(body, SMELL_WORDS)
  const taste = countWords(body, TASTE_WORDS)
  const sound = countWords(body, SOUND_WORDS)
  return { chapterNumber, smell, taste, sound, silent: smell === 0 && taste === 0 && sound === 0 }
}

/**
 * 「最近这么多章里，有多少章闻到过气味」的下限（issue #151 建议 3）。
 *
 * 标定：受测两本书分别是 **10/71 = 14%** 与 **4/24 = 17%**；而一段正常叙事不会在
 * 4/5 的章里连一次气味都没有。取 **0.3**（三成）作为下限而不是 0.5：
 * - 偏低是刻意的——这条判据的目标是「整本书几乎没有气味」这一档，
 *   **不是**「这一章写得不够香」（后者属审美，规则判不了，交审稿）。
 * - 0.3 在受测样本上是 2.1× 与 1.8× 的差距，不是贴着噪声线设的。
 */
export const SMELL_CHAPTER_SHARE_FLOOR = 0.3

/** 趋势判据的窗口：最近多少章（与 `proseFlavorDriftFindings` 的 DRIFT_WINDOW 同量级）。 */
export const SENSORY_WINDOW = 20

/** 至少要有这么多章才判（样本不足时占比没有意义）。 */
export const SENSORY_MIN_CHAPTERS = 8

/**
 * 单章「三类全无」→ 一条提醒。
 *
 * ⚠️ 按章报而不是按全书平均：作者要改的是**具体某几章**。但这里**只在整本书的气味覆盖
 * 已经偏低时**才按章报（见下面 `findSensoryChannelFindings` 的门槛）——否则一本写得正常
 * 的书里「这一章恰好没写气味」是很常见的事，逐章报会变成噪声。
 * 所以本函数**不直接导出给界面**用，只作为趋势判据的明细来源。
 */
export interface SensoryChapterInput {
  chapterNumber: number
  content: string
}

/**
 * 感官通道覆盖偏低 → 一致性发现（issue #151）。
 *
 * 两条判据合取，避免两头的假阳性：
 * 1. **趋势**：最近 `SENSORY_WINDOW` 章里「有过气味」的章占比低于 `SMELL_CHAPTER_SHARE_FLOOR`；
 * 2. **明细**：只列这段窗口里**三类全无**的章号。
 *
 * 只有第 1 条成立时才报——所以「某几章没写气味」本身不会被报，
 * 报的是「这一整段几乎从来没有气味」。
 */
export function findSensoryChannelFindings(
  chapters: readonly SensoryChapterInput[],
  options: { window?: number; floor?: number; minChapters?: number } = {},
): ConsistencyFinding[] {
  const window = options.window ?? SENSORY_WINDOW
  const floor = options.floor ?? SMELL_CHAPTER_SHARE_FLOOR
  const minChapters = options.minChapters ?? SENSORY_MIN_CHAPTERS
  const ordered = [...chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-window)
  if (ordered.length < minChapters) return []
  const measured = ordered.map(chapter => measureSensoryChannels(chapter.chapterNumber, chapter.content))
  const smelling = measured.filter(item => item.smell > 0)
  const share = smelling.length / measured.length
  if (share >= floor) return []
  const silent = measured.filter(item => item.silent).map(item => item.chapterNumber)
  // 窗口里都已经「几乎没有气味」时才报；章节明细给出具体要改哪几章。
  const first = measured[0]!.chapterNumber
  const last = measured[measured.length - 1]!.chapterNumber
  const tasteChapters = measured.filter(item => item.taste > 0).length
  const soundChapters = measured.filter(item => item.sound > 0).length
  return [{
    // key 取**这一段的首章**（不带末章号）：这一段随新章滚动，带末章会让 ack 永远对不上
    // （#86/#89/#98/#108）。这一段从首章起就一直没气味，作者真补了气味后判据自然不再成立。
    stableFactKey: `prose-flavor:sensory:${first}`,
    severity: 'warning' as const,
    sourceChapter: last,
    evidence: `第${first}–${last}章共 ${measured.length} 章，只有 ${smelling.length} 章写过气味（${Math.round(share * 100)}%）；`
      + `味觉 ${tasteChapters} 章、环境音 ${soundChapters} 章；三类全无的章：${silent.length ? silent.map(n => `第${n}章`).join('、') : '无'}`,
    issue: {
      zhCN: `感官通道几乎只剩视觉与触觉：最近 ${measured.length} 章里只有 ${smelling.length} 章写过气味（${Math.round(share * 100)}%），味觉 ${tasteChapters} 章、环境音 ${soundChapters} 章，三类全无的有 ${silent.length} 章。起草与精修模板都要求「通过五感细节强化环境描写」，但没有任何一层核对它——于是模型逐章退化成它最擅长的通道。故事的舞台本身不缺气味可写（积水、霉仓、油墨、湿麻布），缺的是把它写出来。`,
      enUS: `The sensory channels have collapsed into sight and touch: of the last ${measured.length} chapters only ${smelling.length} mention any smell (${Math.round(share * 100)}%), ${tasteChapters} mention taste, ${soundChapters} mention ambient sound, and ${silent.length} have none of the three. Both the drafting and refinement templates ask for sensory detail, but nothing downstream ever checks it, so each chapter drifts back to the channels the model handles best.`,
    },
    suggestion: {
      zhCN: `在列出的那几章里各补一处**当场闻到的气味**（不必长）：「舱底积水泡了三天，那股铁腥味贴着地皮走」「霉麻袋一翻，霉味先冲上来」。改的是**少数几章**，不用每章都补——先让读者在这一段里闻到过一次东西。不要写成「闻到一股难以形容的味道」这类空话：要写出**是什么东西**发出的、**在什么动作之后**闻到的。`,
      enUS: `Add one on-the-spot smell to a few of the chapters listed (it does not need to be long): "the bilge had soaked for three days and the iron tang crept along the floor". Rewrite only a few chapters, not all of them — the point is to let the reader smell something at least once in this stretch. Avoid vague lines like "a smell he could not name": say what the thing is and what action raised the smell.`,
    },
  }]
}