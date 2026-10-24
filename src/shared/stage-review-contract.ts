/**
 * 细纲 / 蓝图 AI 检查的纯逻辑：类别、Prompt 组装、findings 归一化。
 * 粗纲检查另有 arc-review-contract.ts，二者产物形状相同（stage-review-types）。
 */
import type { WritingLanguage } from './writing-language'
import { OUTLINE_SECTIONS } from './plot-outline-contract'

const NL = String.fromCharCode(10)

export const OUTLINE_REVIEW_CATEGORIES = [
  'plot_logic',
  'arc_consistency',
  'core_outline_consistency',
  'worldbuilding_consistency',
  'character_consistency',
  'foreshadowing_and_cost',
  'pacing',
  'prose_quality',
] as const
export type OutlineReviewCategory = typeof OUTLINE_REVIEW_CATEGORIES[number]

export const BLUEPRINT_REVIEW_CATEGORIES = [
  'field_completeness',
  'outline_consistency',
  'character_consistency',
  'cost_and_foreshadowing_continuity',
  'hook_repetition',
  'pacing',
] as const
export type BlueprintReviewCategory = typeof BLUEPRINT_REVIEW_CATEGORIES[number]

export interface OutlineReviewChapterInput {
  chapter: number
  title: string
  body: string
}

export interface BlueprintReviewChapterInput {
  chapter: number
  title: string
  role: string
  purpose: string
  keyEvents: string
  characters: readonly string[]
  suspenseHook: string
  costsAndTurns: string
  foreshadowing: string
}

/**
 * 细纲检查 Prompt。
 *
 * 设计要点（用户明确要求）：
 * - 带上核心大纲与粗纲方向：细纲跑偏最常见的原因就是检查时看不到全书方向。
 * - 带上这段细纲的全部章节原文，并要求按章定位问题（chapter 字段），这样
 *   「接受」才能精确替换到对应章。
 * - 维度覆盖情节逻辑、与粗纲/核心大纲/世界观的一致性、人物一致性、伏笔与代价、节奏。
 */
export function buildOutlineReviewPrompt(input: {
  chapters: readonly OutlineReviewChapterInput[]
  selected: readonly number[]
  coreOutline: string
  premise: string
  worldbuilding: string
  arcDirective: string
  language: WritingLanguage
}): string {
  const english = input.language === 'en-US'
  const selected = new Set(input.selected)
  const body = input.chapters
    .filter(chapter => selected.has(chapter.chapter))
    .map(chapter => '[Chapter ' + chapter.chapter + '] ' + chapter.title + NL + chapter.body)
    .join(NL + NL)
  const header = english
    ? 'Review these chapter outlines and report concrete, actionable problems.'
    : '请检查以下每章细纲，指出具体、可执行的问题。'
  const rules = english
    ? [
      'Categories: ' + OUTLINE_REVIEW_CATEGORIES.join(', ') + '.',
      'Every finding must carry: chapter (the integer chapter number it targets), category, severity (error|warning),',
      'problemText (what is wrong and why) and expectedText (the exact replacement text for that chapter, in full).',
      'An expectedText must be a complete replacement for the whole chapter entry including its "## Chapter N: title" heading and every required section: ' + OUTLINE_SECTIONS.join(', ') + '.',
      'Judge continuity across the selected chapters and against the arc direction, core outline and worldbuilding supplied below.',
      'Flag ledger-style or diary-style writing (a flat summary of events) as a pacing/prose_quality problem.',
      'Only report real problems. Return an empty list when the chapters are sound.',
      'Output JSON only: {"findings":[...]}.',
    ]
    : [
      '类别只能取：' + OUTLINE_REVIEW_CATEGORIES.join('、') + '。',
      '每条必须给出：chapter（目标章号，整数）、category、severity（error|warning）、',
      'problemText（哪里不对、为什么）与 expectedText（该章的完整替换文本）。',
      'expectedText 必须是整章条目的完整替换内容，包含 "## 第N章：标题" 标题行与全部必备小节：' + OUTLINE_SECTIONS.join('、') + '。',
      '要跨所选章节判断连贯性，并对照下面的粗纲方向、核心大纲与世界观。',
      '把流水账 / 日记体（平铺直叙地罗列事件）报成 pacing 或 prose_quality 问题。',
      '只报告真实问题。没有问题时返回空数组。',
      '只输出 JSON：{"findings":[...]}。',
    ]
  const facts = [
    input.coreOutline ? (english ? '[Core outline]' : '【核心大纲】') + NL + input.coreOutline : '',
    input.premise ? (english ? '[Premise]' : '【故事前提】') + NL + input.premise : '',
    input.worldbuilding ? (english ? '[Worldbuilding]' : '【世界观】') + NL + input.worldbuilding : '',
    input.arcDirective,
  ].filter(Boolean).join(NL + NL)
  return [header, rules.join(NL), facts, body].filter(Boolean).join(NL + NL)
}

/**
 * 蓝图检查 Prompt。
 *
 * 蓝图是结构化录入层：它不新编剧情，只把细纲整理成可执行的字段。
 * 因此检查重点是「字段是否齐全、是否与细纲一致」，而不是文学性。
 */
export function buildBlueprintReviewPrompt(input: {
  chapters: readonly BlueprintReviewChapterInput[]
  selected: readonly number[]
  outlineSlices: string
  charactersArch: string
  worldbuilding: string
  language: WritingLanguage
}): string {
  const english = input.language === 'en-US'
  const selected = new Set(input.selected)
  const body = input.chapters
    .filter(chapter => selected.has(chapter.chapter))
    .map(chapter => [
      '[Chapter ' + chapter.chapter + '] ' + chapter.title,
      'role: ' + chapter.role,
      'purpose: ' + chapter.purpose,
      'keyEvents: ' + chapter.keyEvents,
      'characters: ' + chapter.characters.join(', '),
      'suspenseHook: ' + chapter.suspenseHook,
      'costsAndTurns: ' + chapter.costsAndTurns,
      'foreshadowing: ' + chapter.foreshadowing,
    ].join(NL))
    .join(NL + NL)
  const header = english
    ? 'Review these chapter blueprints against the outline they were derived from.'
    : '请对照派生所用的细纲，检查以下章节蓝图。'
  const rules = english
    ? [
      'Categories: ' + BLUEPRINT_REVIEW_CATEGORIES.join(', ') + '.',
      'Every finding must carry: chapter (integer), category, severity (error|warning), problemText and expectedText.',
      'expectedText must be a corrected version of the offending field(s) for that chapter, written as a JSON object with the same field names.',
      'Check that every field is present and non-empty, that characters exist in the cast facts, and that costsAndTurns/foreshadowing stay continuous with neighbouring chapters.',
      'Blueprints must not invent plot that is absent from the outline. Report such inventions as outline_consistency.',
      'Only report real problems. Return an empty list when the blueprints are sound.',
      'Output JSON only: {"findings":[...]}.',
    ]
    : [
      '类别只能取：' + BLUEPRINT_REVIEW_CATEGORIES.join('、') + '。',
      '每条必须给出：chapter（整数）、category、severity（error|warning）、problemText 与 expectedText。',
      'expectedText 必须是该章问题字段的修正版本，写成同名字段的 JSON 对象。',
      '检查每个字段是否齐全非空、characters 是否都在角色事实中、costsAndTurns / foreshadowing 与前后章是否连贯。',
      '蓝图不得新增细纲里没有的剧情；发现新增的按 outline_consistency 报。',
      '只报告真实问题。没有问题时返回空数组。',
      '只输出 JSON：{"findings":[...]}。',
    ]
  const facts = [
    input.charactersArch ? (english ? '[Character facts]' : '【角色事实】') + NL + input.charactersArch : '',
    input.worldbuilding ? (english ? '[Worldbuilding]' : '【世界观】') + NL + input.worldbuilding : '',
    (english ? '[Source outline for the selected chapters]' : '【所选章节对应的细纲原文】') + NL + (input.outlineSlices || (english ? '(missing)' : '（缺失）')),
  ].filter(Boolean).join(NL + NL)
  return [header, rules.join(NL), facts, body].filter(Boolean).join(NL + NL)
}

function allowed(value: unknown, list: readonly string[]): value is string {
  return typeof value === 'string' && list.includes(value)
}

function normalizeSeverity(value: unknown): string {
  return value === 'error' ? 'error' : 'warning'
}

import type { StageReviewFinding } from './stage-review-types'

/**
 * 归一化模型返回的 findings：丢弃越界目标、未知类别、空问题描述。
 * 与粗纲检查同一套规则，保证三个环节的卡片行为一致。
 * targetIndex 的语义由调用方决定（细纲 / 蓝图都是章号）。
 */
export function normalizeStageReviewFindings(
  raw: unknown,
  selected: readonly number[],
  categories: readonly string[],
): StageReviewFinding[] {
  const list = Array.isArray(raw) ? raw : []
  const allowedTargets = new Set(selected)
  const out: StageReviewFinding[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const targetIndex = Number(record.chapter ?? record.targetIndex ?? record.target_index)
    if (!Number.isSafeInteger(targetIndex) || !allowedTargets.has(targetIndex)) continue
    if (!allowed(record.category, categories)) continue
    const problemText = text(record.problemText ?? record.problem_text)
    if (!problemText) continue
    out.push({
      targetIndex,
      category: record.category,
      severity: normalizeSeverity(record.severity),
      problemText,
      expectedText: text(record.expectedText ?? record.expected_text),
    })
  }
  return out
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
