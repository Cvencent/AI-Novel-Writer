import type { ArchStepKey } from '../../../services/architecture-step-selection'
import type { ArchitectureOverview } from '../../editor/use-architecture-overview'

type Text = (zh: string, en: string) => string

export const SECTION_ORDER: readonly ArchStepKey[] = ['premise', 'characters', 'worldbuilding', 'synopsis']

export const SECTION_NUMERALS: Record<ArchStepKey, string> = { premise: 'i', characters: 'ii', worldbuilding: 'iii', synopsis: 'iv' }

/**
 * 一节的状态徽标。「已确认」沿用流程脊的判定（这一节已有内容，见 stage-progress 的 ARCHITECTURE_SECTIONS）；
 * 其余几种是这节虽有或没有内容、但需要作者处理的情况。
 */
export type SectionBadge =
  | { kind: 'empty' }
  | { kind: 'ready' }
  /** 大纲分批生成，已覆盖到第 coveredTo 章。 */
  | { kind: 'partial'; coveredTo: number; total: number }
  /** 大纲被输出长度打断，或检查点已不可恢复。 */
  | { kind: 'incomplete' }
  /** 还没有正式内容，只有一份未完成候选。 */
  | { kind: 'candidate' }
  /** 角色名单需要显式修复或采用。 */
  | { kind: 'attention'; label: string }

export function sectionBadge(key: ArchStepKey, overview: ArchitectureOverview): SectionBadge {
  const filled = Boolean(overview.archStatus[key])
  if (key === 'characters') {
    const presentation = overview.roster.presentation
    if (presentation && presentation.kind !== 'ready' && presentation.kind !== 'empty') return { kind: 'attention', label: presentation.label }
    return filled ? { kind: 'ready' } : { kind: 'empty' }
  }
  if (key === 'synopsis') {
    const { coveredTo, totalChapters, incomplete, recoveryFailed, candidate } = overview.synopsis
    if (!filled) return candidate ? { kind: 'candidate' } : { kind: 'empty' }
    if (incomplete || recoveryFailed) return { kind: 'incomplete' }
    if (coveredTo > 0 && coveredTo < totalChapters) return { kind: 'partial', coveredTo, total: totalChapters }
    return { kind: 'ready' }
  }
  if (key === 'worldbuilding' && !filled && overview.worldBuilding.candidate) return { kind: 'candidate' }
  return filled ? { kind: 'ready' } : { kind: 'empty' }
}

export function badgeText(badge: SectionBadge, text: Text): string {
  switch (badge.kind) {
    case 'empty': return text('待生成', 'Not started')
    case 'ready': return text('已确认', 'Confirmed')
    case 'partial': return text(`部分完成 · ${badge.coveredTo} / ${badge.total} 章`, `Partial · ${badge.coveredTo} / ${badge.total} ch.`)
    case 'incomplete': return text('不完整', 'Incomplete')
    case 'candidate': return text('有未完成候选', 'Unfinished candidate')
    case 'attention': return badge.label
  }
}

export type BadgeTone = 'ok' | 'warn' | 'muted'

export function badgeTone(badge: SectionBadge): BadgeTone {
  if (badge.kind === 'ready') return 'ok'
  return badge.kind === 'empty' ? 'muted' : 'warn'
}

/** 架构阶段唯一的主操作：一节都没确认时生成架构，有缺口时继续生成，四节都已确认时进入蓝图。 */
export type ArchitectureMainAction = 'generate' | 'continue' | 'next'

export function mainAction(filled: number, total: number): ArchitectureMainAction {
  if (filled >= total) return 'next'
  return filled === 0 ? 'generate' : 'continue'
}

/** 卡片上的一句摘要：取正文去掉 Markdown 标记后的开头。 */
export function excerpt(markdown: string, limit = 90): string {
  const plain = markdown
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > limit ? `${plain.slice(0, limit)}……` : plain
}
