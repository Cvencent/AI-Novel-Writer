/**
 * 粗纲 AI 检查（WP5）的纯逻辑：类别、Prompt 组装、findings 归一化与边界校验。
 * 结果形状对齐 review_findings，便于复用既有建议卡片与复检机制。
 */
import type { WritingLanguage } from './writing-language'

export const ARC_REVIEW_CATEGORIES = [
  'plot_logic',
  'reveal_pacing',
  'duplication',
  'foreshadowing',
  'core_outline_consistency',
  'worldbuilding_consistency',
  'pacing',
] as const
export type ArcReviewCategory = typeof ARC_REVIEW_CATEGORIES[number]

export type ArcReviewSeverity = 'error' | 'warning' | 'pass'

export interface ArcReviewSegmentInput {
  arcIndex: number
  fromChapter: number
  toChapter: number
  title: string
  beat: string
  summary: string
}

export interface ArcReviewFinding {
  arcIndex: number
  category: ArcReviewCategory
  severity: ArcReviewSeverity
  problemText: string
  expectedText: string
}

const NL = String.fromCharCode(10)

export function buildArcReviewPrompt(input: {
  arcs: readonly ArcReviewSegmentInput[]
  selected: readonly number[]
  coreOutline: string
  worldbuilding: string
  language: WritingLanguage
}): string {
  const english = input.language === 'en-US'
  const selected = new Set(input.selected)
  const body = input.arcs
    .filter(arc => selected.has(arc.arcIndex))
    .map(arc => '[' + arc.arcIndex + '] ' + arc.title + ' (' + arc.fromChapter + '-' + arc.toChapter + ', ' + arc.beat + ')' + NL + arc.summary)
    .join(NL + NL)
  const header = english
    ? 'Review these arc-outline segments and report concrete problems.'
    : '请检查以下粗纲分段，指出具体问题。'
  const rules = english
    ? ['Report categories from: ' + ARC_REVIEW_CATEGORIES.join(', '),
       'Each finding needs the arcIndex it targets, a category, a severity (error|warning), problemText and expectedText (the replacement text).',
       'Only report real, actionable problems. Return an empty list when the segments are sound.',
       'Output JSON: {"findings":[...]} only.']
    : ['类别只能取：' + ARC_REVIEW_CATEGORIES.join('、'),
       '每条必须给出目标 arcIndex、category、severity（error|warning）、problemText 与 expectedText（建议替换文本）。',
       '只报告真实、可执行的问题。没有问题时返回空数组。',
       '只输出 JSON：{"findings":[...]}。']
  const facts = [input.coreOutline ? (english ? '[Core outline]' : '【核心大纲】') + NL + input.coreOutline : '',
    input.worldbuilding ? (english ? '[Worldbuilding]' : '【世界观】') + NL + input.worldbuilding : '']
    .filter(Boolean).join(NL + NL)
  return [header, rules.join(NL), facts, body].filter(Boolean).join(NL + NL)
}

function isCategory(value: unknown): value is ArcReviewCategory {
  return typeof value === 'string' && (ARC_REVIEW_CATEGORIES as readonly string[]).includes(value)
}

function normalizeSeverity(value: unknown): ArcReviewSeverity {
  return value === 'error' ? 'error' : value === 'pass' ? 'pass' : 'warning'
}

export function normalizeArcReviewFindings(raw: unknown, selected: readonly number[]): ArcReviewFinding[] {
  const list = Array.isArray(raw) ? raw : []
  const allowed = new Set(selected)
  const out: ArcReviewFinding[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const arcIndex = Number(record.arcIndex ?? record.arc_index)
    if (!Number.isSafeInteger(arcIndex) || !allowed.has(arcIndex)) continue
    if (!isCategory(record.category)) continue
    const problemText = typeof record.problemText === 'string' ? record.problemText.trim() : ''
    if (!problemText) continue
    const expectedText = typeof record.expectedText === 'string' ? record.expectedText.trim() : ''
    out.push({ arcIndex, category: record.category, severity: normalizeSeverity(record.severity), problemText, expectedText })
  }
  return out
}
