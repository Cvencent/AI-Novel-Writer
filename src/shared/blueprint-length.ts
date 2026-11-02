import { countDraftUnits } from './draft-units'

/**
 * 蓝图「冲突与转折」（keyEvents）的长度口径（issue #64）。
 *
 * 实测这本书写到 25 章后 keyEvents 从均值 253 字涨到 429 字（第 25 章 510 字，
 * 而同章正文只有 630 汉字）：蓝图里已经排好台词与动作顺序，起草只剩扩写，
 * 「蓝图 → 正文」这一层的价值就被吃掉了；而且最近 3 章的全文会进入下一次
 * 蓝图生成与起草的提示词，成本逐章累积。
 *
 * 口径与单章模板一致（100–150 字这个量级），但**只作为生成侧目标与作者可见的
 * 提示**，不作为落库硬闸：不可变合同里有「作者指定事件为权威、不得删除」的条款，
 * 一个硬上限会推翻它，也会让事件确实很长的章节被反复拒稿。
 */
export interface BlueprintKeyEventsBudget {
  /** 生成侧目标（约数），随每章字数目标缩放。 */
  target: number
  /** 作者可见提示里给出的上限；超过它才提示，不是拒稿线。 */
  max: number
}

/**
 * 每章正文目标字数 → keyEvents 目标长度。
 *
 * 取正文目标的 1/5：一页不到的规划文本不该塞进一章的正文容量。下限 100 字
 * （短章也得说清一件事），上限 200 字（再长就必然开始写台词原文了）。
 */
export function blueprintKeyEventsBudget(targetWordsPerChapter: number): BlueprintKeyEventsBudget {
  const words = Number.isFinite(targetWordsPerChapter) && targetWordsPerChapter > 0 ? targetWordsPerChapter : 0
  const target = Math.min(200, Math.max(100, Math.round(words / 5)))
  return { target, max: target * 2 }
}

/**
 * 机器读的标注（【收束：…】【装置：…】）不算在蓝图长度里：它们是给下游轮换约束读的，
 * 不是作者要读的叙事内容——把它们算进去会让「超长」提示在正常蓝图上也误报。
 */
export function blueprintKeyEventsProseText(keyEvents: string): string {
  return String(keyEvents ?? '')
    .replace(/【\s*(?:收束|装置)\s*[:：][^】]{0,60}】/gu, ' ')
    .trim()
}

/** 供提示与写前预检共用的计数口径（与正文字数同一套 countDraftUnits）。 */
export function countBlueprintKeyEventsUnits(keyEvents: string): number {
  return countDraftUnits(blueprintKeyEventsProseText(keyEvents))
}

/**
 * 超过上限多少倍才算「准正文」。
 *
 * 不按 1.0 判：作者的伸缩、多主角的章本来就比平均值长，只有明显写成整场戏
 * （实测样本的 510 字 ≈ 目标的 3 倍）才值得打扰作者。
 */
export const BLUEPRINT_KEY_EVENTS_OVERSIZE_FACTOR = 1.5

export function blueprintKeyEventsOversize(
  keyEvents: string,
  targetWordsPerChapter: number,
): { units: number; budget: BlueprintKeyEventsBudget } | null {
  const units = countBlueprintKeyEventsUnits(keyEvents)
  const budget = blueprintKeyEventsBudget(targetWordsPerChapter)
  if (units <= Math.round(budget.max * BLUEPRINT_KEY_EVENTS_OVERSIZE_FACTOR)) return null
  return { units, budget }
}