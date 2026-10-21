import type { ArchGenerateStepKey, ArchStepKey } from '../../../services/architecture-step-selection'
import type { ArchitectureOverview } from '../../editor/use-architecture-overview'

type Text = (zh: string, en: string) => string

export const SECTION_ORDER: readonly ArchStepKey[] = ['premise', 'characters', 'worldbuilding', 'arc', 'synopsis']

/** 「AI 生成架构」对话框可选的四节；粗纲有独立的分段生成流程。 */
export const GENERATE_SECTION_ORDER: readonly ArchGenerateStepKey[] = ['premise', 'characters', 'worldbuilding', 'synopsis']

export const SECTION_NUMERALS: Record<ArchStepKey, string> = { premise: 'i', characters: 'ii', worldbuilding: 'iii', arc: 'iv', synopsis: 'v' }

/**
 * 一节的状态徽标。「已确认」即 overview.confirmed（流程脊用同一判定，见 checkArchConfirmed）；
 * 其余几种是这节虽有或没有内容、但需要作者处理的情况。
 */
export type SectionBadge =
  | { kind: 'empty' }
  | { kind: 'ready' }
  /** 大纲分批生成，已覆盖到第 coveredTo 章。 */
  | { kind: 'partial'; coveredTo: number; total: number }
  /** 大纲有一批被打断或正在生成。 */
  | { kind: 'incomplete' }
  /** 粗纲：已分 n 段，其中 m 段已确认，覆盖到第 coveredTo 章。 */
  | { kind: 'arc'; segments: number; confirmed: number; coveredTo: number; total: number }
  /** 还没有正式内容，只有一份未完成候选。 */
  | { kind: 'candidate' }
  /** 角色名单需要显式修复或采用。 */
  | { kind: 'attention'; label: string }

export function sectionBadge(key: ArchStepKey, overview: ArchitectureOverview): SectionBadge {
  if (overview.confirmed[key]) return { kind: 'ready' }
  if (key === 'characters') {
    const presentation = overview.roster.presentation
    return presentation && presentation.kind !== 'ready' && presentation.kind !== 'empty' ? { kind: 'attention', label: presentation.label } : { kind: 'empty' }
  }
  if (key === 'arc') {
    const { list } = overview.arc
    if (list.length === 0) return { kind: 'empty' }
    const confirmed = list.filter(arc => arc.status === 'confirmed').length
    const coveredTo = list.reduce((max, arc) => Math.max(max, arc.toChapter), 0)
    if (confirmed === list.length) return { kind: 'ready' }
    return { kind: 'arc', segments: list.length, confirmed, coveredTo, total: overview.arc.totalChapters }
  }
  if (key === 'synopsis') {
    const { progress, candidate } = overview.synopsis
    switch (progress.kind) {
      case 'partial': return { kind: 'partial', coveredTo: progress.coveredTo, total: progress.total }
      case 'interrupted':
      case 'unresumable': return { kind: 'incomplete' }
      case 'empty':
      case 'complete': return candidate ? { kind: 'candidate' } : { kind: 'empty' }
      default: return progress satisfies never
    }
  }
  if (key === 'worldbuilding' && overview.worldBuilding.candidate) return { kind: 'candidate' }
  return { kind: 'empty' }
}

export function badgeText(badge: SectionBadge, text: Text): string {
  switch (badge.kind) {
    case 'empty': return text('待生成', 'Not started')
    case 'ready': return text('已确认', 'Confirmed')
    case 'partial': return text(`部分完成 · ${badge.coveredTo} / ${badge.total} 章`, `Partial · ${badge.coveredTo} / ${badge.total} ch.`)
    case 'incomplete': return text('不完整', 'Incomplete')
    case 'candidate': return text('有未完成候选', 'Unfinished candidate')
    case 'arc': return text(
      badge.segments + ' 段 · 已确认 ' + badge.confirmed + ' 段' + (badge.coveredTo > 0 ? ' · 到第 ' + badge.coveredTo + ' 章' : ''),
      badge.segments + ' ' + (badge.segments === 1 ? 'segment' : 'segments') + ' · ' + badge.confirmed + ' confirmed' + (badge.coveredTo > 0 ? ' · through ch. ' + badge.coveredTo : ''),
    )
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

/** 卡片上的一句摘要：取正文去掉标题行与 Markdown 标记后的开头；只有标题时退回标题文字。省略号随界面语言（「……」或「…」）。 */
export function excerpt(markdown: string, ellipsis: string, limit = 90): string {
  const body = markdown.replace(/^#{1,6}\s+.*$/gm, '').trim()
  const plain = (body || markdown.replace(/^#{1,6}\s+/gm, ''))
    .replace(/[*_`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > limit ? `${plain.slice(0, limit)}${ellipsis}` : plain
}
