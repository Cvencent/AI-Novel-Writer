import { textHash, type DurableGenerationRun } from '../repositories/generation-run-repository'
import type { EditorInlineInput, EditorInlineContext, EditorInlineScope } from '../../src/shared/editor-inline-generation'
import type { WritingLanguage } from '../../src/shared/writing-language'
import { composePromptSystemRole, type PromptTemplate } from '../../src/services/builtin-prompt-templates'
import { renderPrompt } from '../../src/shared/render-prompt'
import type { GenerationTask } from '../../src/services/generation/generation-harness'
import { isDeepStrictEqual } from 'node:util'

const actions = ['refine', 'expand', 'continue', 'dialogue', 'custom'] as const
const scopes = ['chapter-draft', 'core-outline', 'world-setting', 'golden-finger', 'protagonist-profile', 'global-guidance', 'writing-style', 'reference-works', 'premise', 'worldbuilding', 'characters', 'arc-outline', 'synopsis'] as const
const instructions = {
  refine: ['润色这部分，使语言自然、具体并增强场景表现力。', 'Refine this passage for natural, specific language and stronger scene craft.'],
  expand: ['扩写这部分，补充与情节有关的动作、感官和环境细节。', 'Expand this passage with plot-relevant action, sensory detail, and setting.'],
  continue: ['根据现有因果和人物动机，自然续写接下来的情节。', 'Continue naturally from the established causality and character motivation.'],
  dialogue: ['将这部分改写为有区分度、能推动冲突的自然对话。', 'Rewrite this passage as distinct, natural dialogue that advances the conflict.'],
} as const

/** 作用域的人话名称；模型需要知道自己在改项目的哪一块。 */
const scopeLabels: Record<EditorInlineScope, readonly [string, string]> = {
  'chapter-draft': ['章节正文', 'chapter manuscript'],
  'core-outline': ['核心大纲', 'core outline'],
  'world-setting': ['世界观', 'world setting'],
  'golden-finger': ['金手指', 'core hook'],
  'protagonist-profile': ['主角人设', 'protagonist profile'],
  'global-guidance': ['全局写作要求', 'global writing guidance'],
  'writing-style': ['文风', 'writing style'],
  'reference-works': ['参考作品', 'reference works'],
  premise: ['故事前提', 'premise'],
  worldbuilding: ['世界观架构', 'worldbuilding architecture'],
  characters: ['角色名单', 'character roster'],
  'arc-outline': ['粗纲', 'arc outline'],
  synopsis: ['情节大纲', 'plot synopsis'],
}
/** 每个作用域改完后必须守住的东西。 */
const scopeConstraints: Record<EditorInlineScope, readonly [string, string]> = {
  'chapter-draft': ['这是已写正文。保持既有事实、人物视角、时间线与叙事意图，不得用题材惯例替换作者已写下的内容。', 'This is existing manuscript prose. Preserve established facts, viewpoint, timeline and narrative intent; never replace what the author has written with genre assumptions.'],
  'core-outline': ['这是全书的核心大纲，是后面所有架构与正文的上位设定。保持故事前提、主角目标与核心冲突不变，除非作者明确要求改这些。', 'This is the book-level core outline and sits above every later architecture decision and chapter. Keep the premise, protagonist goal and central conflict unless the author explicitly asks to change them.'],
  'world-setting': ['这是世界观设定。保持已确立的规则、时代、力量体系与社会结构自洽；新增设定不得与已写事实矛盾。', 'This is world-setting material. Keep established rules, era, power system and social structure self-consistent; new details must not contradict existing facts.'],
  'golden-finger': ['这是主角的核心优势设定。保持获取方式、能力边界与成长路径的因果一致。', 'This is the protagonist’s core hook. Keep how it is gained, its limits and its growth path causally consistent.'],
  'protagonist-profile': ['这是主角人设。保持性格、来历与核心目标一致，改动不得与已成立的剧情冲突。', 'This is the protagonist profile. Keep personality, backstory and central goal consistent; changes must not contradict established plot.'],
  'global-guidance': ['这是贯穿全书的写作规则。保持其可执行、可核对，不要写成剧情概述或章节清单。', 'This is book-wide writing guidance. Keep it actionable and checkable; do not turn it into plot summary or a chapter list.'],
  'writing-style': ['这是文风要求。改的是写作方式而不是故事内容，不要在这里引入剧情事实。', 'This is a writing-style requirement. Revise how the book is written, not what happens; do not introduce plot facts here.'],
  'reference-works': ['这是参考作品清单。只描述参考了什么，不要照搬受版权保护的具体表达。', 'This is a reference-works list. Describe what is referenced; never reproduce protected expression.'],
  premise: ['这是故事前提。保持核心冲突与主角处境一致，不要提前写出后续剧透。', 'This is the premise. Keep the central conflict and protagonist situation consistent; do not leak later plot.'],
  worldbuilding: ['这是世界观架构文档。保持内部规则自洽，并与核心大纲一致。', 'This is the worldbuilding document. Keep internal rules self-consistent and aligned with the core outline.'],
  characters: ['这是角色名单全文。保持角色身份、关系与动机一致，不要凭空新增或删除角色。', 'This is the character roster. Keep identities, relationships and motivations consistent; do not invent or remove characters.'],
  'arc-outline': ['这是粗纲，只写走向不写具体人名。保持章节区间覆盖连续，不要在这里落地角色姓名。', 'This is the arc outline: direction only, no proper names. Keep chapter coverage contiguous and do not land character names here.'],
  synopsis: ['这是情节大纲。保持与粗纲的方向一致，不要改写已确认的粗纲走向。', 'This is the plot synopsis. Stay aligned with the arc outline and do not rewrite confirmed arc direction.'],
}

const MAX_INSTRUCTION_BYTES = 16 * 1024
const MAX_CONTEXT_BYTES = 4 * 1024
export function validateEditorInlineInput(input: EditorInlineInput): EditorInlineInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['action', 'instruction', 'scope', 'contextBefore', 'contextAfter', 'documentText', 'from', 'to', 'selectedText'].includes(key))
    || !actions.includes(input.action) || typeof input.documentText !== 'string' || typeof input.selectedText !== 'string'
    || input.instruction !== undefined && typeof input.instruction !== 'string'
    || input.scope !== undefined && !scopes.includes(input.scope)
    || input.contextBefore !== undefined && typeof input.contextBefore !== 'string'
    || input.contextAfter !== undefined && typeof input.contextAfter !== 'string'
    || !Number.isSafeInteger(input.from) || !Number.isSafeInteger(input.to) || input.from < 0 || input.to <= input.from
    || input.to > input.documentText.length || input.documentText.slice(input.from, input.to) !== input.selectedText
    || Buffer.byteLength(input.documentText, 'utf8') > 8 * 1024 * 1024) throw new Error('GENERATION_EDITOR_INPUT_INVALID')
  const instruction = input.instruction?.trim()
  const contextBefore = input.contextBefore?.trim()
  const contextAfter = input.contextAfter?.trim()
  if ((input.action === 'custom' && !instruction) || (input.action !== 'custom' && instruction)
    || instruction && Buffer.byteLength(instruction, 'utf8') > MAX_INSTRUCTION_BYTES
    || contextBefore && Buffer.byteLength(contextBefore, 'utf8') > MAX_CONTEXT_BYTES
    || contextAfter && Buffer.byteLength(contextAfter, 'utf8') > MAX_CONTEXT_BYTES) throw new Error('GENERATION_EDITOR_INPUT_INVALID')
  return structuredClone({
    action: input.action,
    documentText: input.documentText,
    from: input.from,
    to: input.to,
    selectedText: input.selectedText,
    ...(instruction ? { instruction } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(contextBefore ? { contextBefore } : {}),
    ...(contextAfter ? { contextAfter } : {}),
  })
}
export function buildEditorInlineContext(input: EditorInlineInput, writingLanguage: WritingLanguage, template: PromptTemplate): EditorInlineContext {
  const valid = validateEditorInlineInput(input)
  if (template.key !== 'edit_selected_text' || typeof template.content !== 'string') throw new Error('GENERATION_EDITOR_TEMPLATE_INVALID')
  return { ...valid, kind: 'author-draft', documentHash: textHash(valid.documentText), writingLanguage, template: structuredClone(template) }
}
export function readEditorInlineContext(run: DurableGenerationRun): EditorInlineContext {
  const context = run.binding.sourceManifest.editorInlineContext as EditorInlineContext | undefined
  if (run.binding.sourceManifest.operation !== 'editor-inline' || !context
    || textHash(JSON.stringify(context)) !== run.binding.sourceManifest.editorInlineContextHash
    || textHash(context.documentText) !== context.documentHash) throw new Error('GENERATION_EDITOR_CONTEXT_INVALID')
  const input = validateEditorInlineInput(run.binding.sourceManifest.editorInlineInput as EditorInlineInput)
  const expected = {
    action: context.action,
    documentText: context.documentText,
    from: context.from,
    to: context.to,
    selectedText: context.selectedText,
    ...(context.instruction ? { instruction: context.instruction } : {}),
    ...(context.scope ? { scope: context.scope } : {}),
    ...(context.contextBefore ? { contextBefore: context.contextBefore } : {}),
    ...(context.contextAfter ? { contextAfter: context.contextAfter } : {}),
  }
  if (!isDeepStrictEqual(input, expected)) throw new Error('GENERATION_EDITOR_CONTEXT_INVALID')
  return structuredClone(context)
}
export function readEditorInlineTask(run: DurableGenerationRun): GenerationTask {
  readEditorInlineContext(run)
  const task = run.binding.sourceManifest.editorInlineTask as GenerationTask | undefined
  if (!task || textHash(JSON.stringify(task)) !== run.binding.sourceManifest.editorInlineTaskHash) throw new Error('GENERATION_EDITOR_TASK_INVALID')
  return structuredClone(task)
}
/** 正在编辑的字段 → 它在 project_core 里的列名；用于把其他设定带给模型时排除自身。 */
const scopeCoreKeys: Partial<Record<EditorInlineScope, string>> = {
  'core-outline': 'core_outline',
  'world-setting': 'world_setting',
  'golden-finger': 'golden_finger',
  'protagonist-profile': 'protagonist_profile',
  'global-guidance': 'global_guidance',
  'writing-style': 'writing_style',
  'reference-works': 'reference_works',
  premise: 'premise',
  worldbuilding: 'worldbuilding',
  characters: 'characters_arch',
  synopsis: 'synopsis',
}

const factLabels: Record<string, readonly [string, string]> = {
  project_name: ['作品名', 'Title'],
  genre: ['类型', 'Genre'],
  sub_genre: ['细分类型', 'Subgenre'],
  target_audience: ['目标读者', 'Target readers'],
  total_chapters: ['总章数', 'Total chapters'],
  words_per_chapter: ['每章字数', 'Words per chapter'],
  plot_structure: ['故事结构', 'Story structure'],
  narrative_pov: ['叙事视角', 'Point of view'],
  writing_language: ['写作语言', 'Writing language'],
  core_outline: ['核心大纲', 'Core outline'],
  world_setting: ['世界观', 'World setting'],
  golden_finger: ['金手指', 'Core hook'],
  protagonist_profile: ['主角人设', 'Protagonist profile'],
  global_guidance: ['全局写作要求', 'Global guidance'],
  writing_style: ['文风', 'Writing style'],
  reference_works: ['参考作品', 'Reference works'],
  premise: ['故事前提', 'Premise'],
  worldbuilding: ['世界观架构', 'Worldbuilding'],
  characters_arch: ['角色名单', 'Character roster'],
  synopsis: ['情节大纲', 'Plot synopsis'],
}

/** 单个事实的上限，避免把整本项目书塞进一次改写请求。 */
const MAX_FACT_CHARS = 1200

export function editorInlineProjectFacts(core: Record<string, unknown>, scope: EditorInlineScope | undefined, english: boolean): string {
  const excluded = scope ? scopeCoreKeys[scope] : undefined
  const lines: string[] = []
  for (const [key, label] of Object.entries(factLabels)) {
    if (key === excluded) continue
    const raw = core[key]
    if (raw === undefined || raw === null) continue
    const value = String(raw).trim()
    if (!value) continue
    const bounded = value.length > MAX_FACT_CHARS ? value.slice(0, MAX_FACT_CHARS) + String.fromCharCode(8230) : value
    lines.push(`- ${label[english ? 1 : 0]}：${bounded}`)
  }
  if (lines.length === 0) return ""
  const heading = english ? "[Other authoritative project settings]" : "【项目里的其它权威设定】"
  const note = english
    ? "Treat these as established facts. Do not contradict them; do not restate them unless the revision requires it."
    : "以下是项目里已经确立的事实，不得与之矛盾；除非本次修改需要，否则不要复述它们。"
  return `${heading}\n${note}\n${lines.join("\n")}`
}

/** 同一字段其它内容的长度上限，避免把整本大纲塞进一次改写请求。 */
const MAX_SAME_FIELD_CHARS = 6000

/**
 * 把「同一个字段/文档里，除本次选中之外的其它内容」整理成既成事实。
 *
 * 例如改粗纲第 3 段时，第 1、2、4 段都在这里；改情节大纲某一章时，其它章也在这里。
 * 这些内容与本次改写同源，是模型最该遵守的上下文。超长时保留首尾，中间省略。
 */
export function editorInlineSameFieldContext(documentText: string, from: number, to: number, english: boolean): string {
  const marker = english ? "[the selected text being revised]" : "〔本次改写的选中文字〕"
  const others = (documentText.slice(0, from) + marker + documentText.slice(to)).trim()
  if (!others) return ""
  const heading = english ? "[Other content in the same field - established facts]" : "【同一字段里的其它内容（既成事实）】"
  const note = english
    ? "These are the other segments of the very field you are editing. Do not contradict them: keep names, numbers, chapter ranges and causal order consistent."
    : "以下是同一个字段里其它已经写定的内容。不得与之矛盾：人名、数字、章节区间与因果顺序都要对得上。"
  const bounded = others.length <= MAX_SAME_FIELD_CHARS
    ? others
    : others.slice(0, MAX_SAME_FIELD_CHARS / 2) + String.fromCharCode(10) + "..." + String.fromCharCode(10) + others.slice(others.length - MAX_SAME_FIELD_CHARS / 2)
  return heading + String.fromCharCode(10) + note + String.fromCharCode(10) + bounded
}


export function editorInlineTask(context: EditorInlineContext, projectFacts?: Record<string, unknown>): GenerationTask {
  const { template, writingLanguage } = context
  const english = writingLanguage === 'en-US'
  const editInstruction = context.action === 'custom'
    ? context.instruction!
    : instructions[context.action][english ? 1 : 0]
  const scope = context.scope ?? 'chapter-draft'
  return { purpose: `editor-ai-${context.action}`, reasoningStage: context.action === 'refine' || context.action === 'custom' ? 'review' : 'drafting', output: 'visible-text', messages: [
    { role: 'system', content: composePromptSystemRole(template, writingLanguage) },
    { role: 'user', content: renderPrompt(template, {
      edit_instruction: editInstruction,
      selected_text: context.selectedText,
      edit_scope: scopeLabels[scope][english ? 1 : 0],
      scope_constraint: scopeConstraints[scope][english ? 1 : 0],
      context_before: context.contextBefore ?? '',
      context_after: context.contextAfter ?? '',
      project_facts: projectFacts ? editorInlineProjectFacts(projectFacts, context.scope, english) : '',
      same_field_context: editorInlineSameFieldContext(context.documentText, context.from, context.to, english),
    }, writingLanguage) },
  ] }
}