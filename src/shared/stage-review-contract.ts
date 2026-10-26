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

/** 各类别的中文名；模型偶尔会用中文回类别，这里做一次别名解析。 */
export const STAGE_REVIEW_CATEGORY_LABELS: Record<string, readonly [string, string]> = {
  plot_logic: ['情节逻辑', 'Plot logic'],
  arc_consistency: ['粗纲方向一致性', 'Arc consistency'],
  core_outline_consistency: ['核心大纲一致性', 'Core-outline consistency'],
  worldbuilding_consistency: ['世界观一致性', 'Worldbuilding consistency'],
  character_consistency: ['人物一致性', 'Character consistency'],
  foreshadowing_and_cost: ['伏笔与代价', 'Foreshadowing & cost'],
  pacing: ['节奏', 'Pacing'],
  prose_quality: ['写法', 'Prose quality'],
  duplication: ['前后重复', 'Duplication'],
  foreshadowing: ['伏笔', 'Foreshadowing'],
  field_completeness: ['字段完整', 'Field completeness'],
  outline_consistency: ['与细纲一致', 'Outline consistency'],
  cost_and_foreshadowing_continuity: ['代价与伏笔连贯', 'Cost & foreshadowing continuity'],
  hook_repetition: ['钩子雷同', 'Hook repetition'],
}

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
      'Write each section as a plain "Section: content" line. Do not use # / ## / ### sub-headings, and never include another chapter heading inside the entry.',
      'If "Scene and cast" lists someone by role only with no personal name (e.g. "the examiner", "the guard"), report character_consistency and either give the person a name in expectedText ("role · name") or remove them from the cast list.',
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
      '小节写成"小节名：内容"的普通行，不要用 # / ## / ### 之类的小标题，也不要在章内再出现任何"第N章"标题。',
      '「场景与出场人物」里出现只有身份、没有姓名的角色（如「检测教员」「门卫」「店员」）时，报 character_consistency，并在 expectedText 里补上姓名（写成「身份·姓名」）或把该角色从人物清单移除。',
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
      'If characters contains a role-only entry with no personal name (e.g. "the examiner"), report character_consistency and remove it from characters in expectedText; the role may still appear in the keyEvents scene description.',
      'Blueprints must not invent plot that is absent from the outline. Report such inventions as outline_consistency.',
      'Only report real problems. Return an empty list when the blueprints are sound.',
      'Output JSON only: {"findings":[...]}.',
    ]
    : [
      '类别只能取：' + BLUEPRINT_REVIEW_CATEGORIES.join('、') + '。',
      '每条必须给出：chapter（整数）、category、severity（error|warning）、problemText 与 expectedText。',
      'expectedText 必须是该章问题字段的修正版本，写成同名字段的 JSON 对象。',
      '检查每个字段是否齐全非空、characters 是否都在角色事实中、costsAndTurns / foreshadowing 与前后章是否连贯。',
      'characters 里出现只有身份没有姓名的条目（如「检测教员」）时，报 character_consistency，并在 expectedText 里把它从 characters 移除；这个角色仍然可以写在 keyEvents 的场景描述里。',
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

/** 类别归一：直接命中，或者用中文名反查（模型有时用中文回类别）。 */
export function normalizeStageReviewCategory(value: unknown, categories: readonly string[]): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (categories.includes(trimmed)) return trimmed
  for (const key of categories) {
    const labels = STAGE_REVIEW_CATEGORY_LABELS[key]
    if (labels && labels[0] === trimmed) return key
  }
  return null
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
export interface StageReviewNormalizationReport {
  findings: StageReviewFinding[]
  /** 模型返回的条目总数（解析出 JSON 数组的长度）。 */
  rawCount: number
  dropped: { unmatchedChapter: number; unknownCategory: number; emptyProblem: number }
}

/** 带丢弃原因的归一化：命令层用它把「为什么 0 条」写进运行日志，而不是让结果神秘消失。 */
export function normalizeStageReviewFindingsDetailed(
  raw: unknown,
  selected: readonly number[],
  categories: readonly string[],
): StageReviewNormalizationReport {
  const list = Array.isArray(raw) ? raw : []
  const allowedTargets = new Set(selected)
  const report: StageReviewNormalizationReport = { findings: [], rawCount: list.length, dropped: { unmatchedChapter: 0, unknownCategory: 0, emptyProblem: 0 } }
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { report.dropped.emptyProblem += 1; continue }
    const record = item as Record<string, unknown>
    const targetIndex = Number(record.chapter ?? record.targetIndex ?? record.target_index)
    if (!Number.isSafeInteger(targetIndex) || !allowedTargets.has(targetIndex)) { report.dropped.unmatchedChapter += 1; continue }
    const category = normalizeStageReviewCategory(record.category, categories)
    if (!category) { report.dropped.unknownCategory += 1; continue }
    const problemText = text(record.problemText ?? record.problem_text)
    if (!problemText) { report.dropped.emptyProblem += 1; continue }
    report.findings.push({
      targetIndex,
      category,
      severity: normalizeSeverity(record.severity),
      problemText,
      expectedText: text(record.expectedText ?? record.expected_text),
    })
  }
  return report
}

export function normalizeStageReviewFindings(
  raw: unknown,
  selected: readonly number[],
  categories: readonly string[],
): StageReviewFinding[] {
  return normalizeStageReviewFindingsDetailed(raw, selected, categories).findings
}

/** 蓝图检查的 expectedText 是字段补丁对象；粗纲 / 细纲是整段文本。两种都要接受。 */
function text(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value && typeof value === 'object' && !Array.isArray(value)) return JSON.stringify(value)
  return ''
}

/** 小节名 → 允许模型用 ### 写小节，但正式细纲是扁平格式，因此降级成「小节名：」。 */
export function normalizeOutlineEntryFormat(text: string): string {
  const sectionPattern = new RegExp('^#{2,6}\\s*(' + OUTLINE_SECTIONS.join('|') + ')\\s*$', 'gmu')
  return text.replace(/\r\n/gu, String.fromCharCode(10)).replace(sectionPattern, '$1：').trim()
}


