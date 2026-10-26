import type { WritingLanguage } from '../../../shared/writing-language'

/**
 * 粗纲逐段生成时的「前情上下文」：让每一段都看得见前面所有段发生了什么。
 *
 * 预算策略（不二次摘要，粗纲 summary 本身就是浓缩剧情）：
 * - 全量索引：所有已生成段的「章范围（beat）：标题」行；
 * - 锚点摘要：第 1 段（定基调）+ 均匀采样最多 10 段 + 最近 3 段（紧邻衔接），
 *   每段给截断后的 summary；采样与最近重叠时去重。
 * 1200 章量级：索引约几千字符 + 13 段摘要，稳定在预算内。
 */
export interface ArcPriorArc {
  fromChapter: number
  toChapter: number
  title: string
  beat: string
  summary: string
}

export interface ArcPriorContextBudget {
  /** 锚点摘要的最多段数（不含最近段）。 */
  maxAnchors: number
  /** 最近几段给全文式 summary（截断）。 */
  recentFull: number
  /** 每段摘要截断字符数。 */
  summaryChars: number
}

export const DEFAULT_ARC_PRIOR_BUDGET: ArcPriorContextBudget = {
  maxAnchors: 10,
  recentFull: 3,
  summaryChars: 700,
}

const nl = '\n'

function arcLine(arc: ArcPriorArc, language: WritingLanguage): string {
  return language === 'en-US'
    ? `Ch. ${arc.fromChapter}-${arc.toChapter} (${arc.beat}): ${arc.title}`
    : `第 ${arc.fromChapter}–${arc.toChapter} 章（${arc.beat}）：${arc.title}`
}

function arcBody(arc: ArcPriorArc, summaryChars: number): string {
  const summary = (arc.summary || '').trim()
  if (summary.length <= summaryChars) return summary
  return `${summary.slice(0, summaryChars)}…`
}

/** 均匀采样 count 个（升序，去重）；总是包含第一段。 */
export function sampleAnchors(total: number, count: number): number[] {
  if (total <= 0 || count <= 0) return []
  const picked = new Set<number>([0])
  if (total > 1 && count > 1) {
    const step = (total - 1) / (count - 1)
    for (let k = 1; k < count; k += 1) picked.add(Math.min(total - 1, Math.round(k * step)))
  }
  return [...picked].sort((a, b) => a - b)
}

export function buildArcPriorContext(
  arcs: readonly ArcPriorArc[],
  language: WritingLanguage,
  budget: ArcPriorContextBudget = DEFAULT_ARC_PRIOR_BUDGET,
): string | null {
  if (arcs.length === 0) return null
  const indexLines = arcs.map(arc => arcLine(arc, language))
  const indexSection = (language === 'en-US' ? '[Arc outline so far (index of all segments)]' : '【粗纲至今（所有已生成段的索引）】') + nl + indexLines.join(nl)

  const recentCount = Math.min(budget.recentFull, arcs.length)
  const recentStart = arcs.length - recentCount
  const anchorPool = arcs.slice(0, recentStart)
  const anchorIndexes = sampleAnchors(anchorPool.length, Math.min(budget.maxAnchors, anchorPool.length))
  const recentIndexes = arcs.map((_, i) => i).slice(recentStart)

  const summaryParts: string[] = []
  for (const i of anchorIndexes) {
    summaryParts.push(`${arcLine(arcs[i]!, language)}${nl}${arcBody(arcs[i]!, budget.summaryChars)}`)
  }
  const summariesSection = summaryParts.length > 0
    ? (language === 'en-US' ? '[Anchor segment summaries (beginning + sampled middle)]' : '【锚点段摘要（开头 + 中段采样）】') + nl + summaryParts.join(nl)
    : ''

  const recentParts = recentIndexes.map(i => `${arcLine(arcs[i]!, language)}${nl}${arcBody(arcs[i]!, budget.summaryChars)}`)
  const recentSection = (language === 'en-US' ? '[Last segments (continue directly from these)]' : '【最近几段（直接衔接它们写）】') + nl + recentParts.join(nl)

  return [indexSection, summariesSection, recentSection].filter(Boolean).join(nl + nl)
}
