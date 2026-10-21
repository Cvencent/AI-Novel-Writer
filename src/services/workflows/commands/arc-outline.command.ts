import {
  ARC_MAX_CHAPTERS, ARC_MIN_CHAPTERS, ARC_BEATS,
  parseArcSegment, sanitizeArcProperNames, validateArcNoProperNames, validateArcSpan, validateBeatDiversity,
} from '../../../shared/arc-outline-contract'
import type { ArcBeat } from '../../../../electron/repositories/arc-outline-repository'
import {
  BaseWorkflowCommand,
  type CommandExecuteParams,
  type WorkflowGenerationRuntimeDependencies,
} from './base-command'
import { ipc } from '../../ipc-client'
import { requireIpcSuccess } from '../../ipc-result'
import { requireWorkflowProjectSession, workflowUiText, workflowWritingLanguage } from '../workflow-project-session'
import { promptLanguageText } from '../../prompt-language'
import { localizeNovelConfigFacts } from '../../../shared/novel-config-localization'
import type { ArchitectureProjectSnapshot } from './architecture.command'

/** 粗纲阶段的人名禁区与段长约束，写进提示词。 */
function arcInstruction(writingLanguage: 'zh-CN' | 'en-US', fromChapter: number, totalChapters: number, recentBeats: readonly ArcBeat[]): string {
  const beats = ARC_BEATS.join(' | ')
  const recent = recentBeats.length > 0 ? recentBeats.join(', ') : (writingLanguage === 'en-US' ? '(none)' : '（无）')
  return promptLanguageText(writingLanguage, `【本次任务：生成下一段粗纲】

全书共 ${totalChapters} 章，本次需要生成**从第 ${fromChapter} 章开始**的下一段粗纲。

硬性要求：
1. 每段跨度必须在 ${ARC_MIN_CHAPTERS}–${ARC_MAX_CHAPTERS} 章之间。具体跨度由你根据该段戏剧命题的大小自行判断：命题大就切长段，命题小就切短段；如果剩余章节不足上限，可以生成到全书末章。
2. 正文**绝对不能出现任何具体人名**。用「主角」「对手」「师长」这类身份词，或「某位研究员」这类泛称。人名要到细纲阶段才出现。
3. 只写：主要事件链与因果关系、冲突与代价、转折点与节奏、结果与状态变化、情绪基调走向。不要逐章流水账。
4. beat 必须取自这个固定集合：${beats}。最近已用过的 beat 是：${recent} —— 不要连续复用同一 beat。

输出格式（严格遵守，不要代码围栏、不要多余说明）：

## 第${fromChapter}–{你决定的结束章}章：{段标题}
beat: {beat}
{正文，不得含任何人名}
`, `[Task: generate the next arc segment]

The book has ${totalChapters} chapters. Generate the next arc segment **starting at chapter ${fromChapter}**.

Hard requirements:
1. Span must be between ${ARC_MIN_CHAPTERS} and ${ARC_MAX_CHAPTERS} chapters. Choose the span yourself based on how large the dramatic proposition is: a large proposition deserves a long segment, a small one a short segment. If fewer chapters remain, you may run to the final chapter.
2. The body must **never contain any proper character name**. Use role words such as "the protagonist", "the rival", "the mentor", or indefinite references. Names appear only in the chapter-outline stage.
3. Write only: the main event chain and causality, conflict and cost, turning points and pacing, outcomes and state changes, emotional trajectory. Do not write a chapter-by-chapter ledger.
4. beat must come from this fixed set: ${beats}. Recently used beats: ${recent} — do not repeat the same beat consecutively.

Output format (strict, no code fences, no extra prose):

## Chapter ${fromChapter}-{your chosen end}: {segment title}
beat: {beat}
{body, containing no proper names}
`)
}

/** 粗纲生成的验证闸门：解析 → 段长 → 人名 → 形态。全部通过才允许落库。 */
export function assertArcSegmentAcceptable(
  raw: string,
  expectedFrom: number,
  totalChapters: number,
  characterNames: readonly string[],
  recentBeats: readonly ArcBeat[],
): { fromChapter: number; toChapter: number; title: string; beat: ArcBeat; summary: string } {
  const parsed = parseArcSegment(raw)
  if (!parsed.ok) throw new Error(parsed.code)
  const { segment } = parsed
  if (segment.fromChapter !== expectedFrom) throw new Error('ARC_OUTLINE_RANGE_GAP')
  const span = validateArcSpan(segment.fromChapter, segment.toChapter, totalChapters)
  if (!span.ok) throw new Error(span.code)
  const names = validateArcNoProperNames(segment.summary, characterNames)
  if (!names.ok) throw new Error('ARC_OUTLINE_PROPER_NAME_FOUND:' + names.found.join(','))
  const diversity = validateBeatDiversity(segment.beat, recentBeats)
  if (!diversity.ok) throw new Error(diversity.code)
  return segment
}

/**
 * 与 assertArcSegmentAcceptable 同一套闸门，但「出现人名」不再判失败：
 * 先把命中的名字按角色定位换成身份词，再走同一套解析→段长→人名→形态校验。
 *
 * 为什么这么改：粗纲的规则是「只写方向、不写人名」，但模型偶尔会漏写一个名字。
 * 过去这种情况会让整段生成作废，作者白等一次调用还得重来；而把「林越」换成「主角」
 * 并不改变方向本身——那正是粗纲本来就该有的写法。替换后仍然走完整校验，不放松任何一条。
 */
export function acceptArcSegmentWithNameFallback(
  raw: string,
  expectedFrom: number,
  totalChapters: number,
  characterNames: readonly string[],
  recentBeats: readonly ArcBeat[],
  roleByName: ReadonlyMap<string, string | undefined> = new Map(),
  language: 'zh-CN' | 'en-US' = 'zh-CN',
): { segment: { fromChapter: number; toChapter: number; title: string; beat: ArcBeat; summary: string }; replacedNames: string[] } {
  const parsed = parseArcSegment(raw)
  if (!parsed.ok) throw new Error(parsed.code)
  const cleaned = sanitizeArcProperNames(parsed.segment.summary, characterNames, roleByName, language)
  if (cleaned.replaced.length === 0) {
    return { segment: assertArcSegmentAcceptable(raw, expectedFrom, totalChapters, characterNames, recentBeats), replacedNames: [] }
  }
  const rebuilt = [
    `## 第${parsed.segment.fromChapter}–${parsed.segment.toChapter}章：${parsed.segment.title}`,
    `beat: ${parsed.segment.beat}`,
    cleaned.text,
  ].join('\n')
  return {
    segment: assertArcSegmentAcceptable(rebuilt, expectedFrom, totalChapters, characterNames, recentBeats),
    replacedNames: cleaned.replaced,
  }
}

export class GenerateArcOutlineCommand extends BaseWorkflowCommand<string> {
  constructor(
    private snapshot: ArchitectureProjectSnapshot,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    return this.executeWithGenerationRuntime('text', params, () => this.executeWithinGeneration(params), {
      authorInputs: [{ id: 'arc:author-config', text: JSON.stringify(this.snapshot.novelConfig) }],
      operation: 'generate-arc-outline', promptKeys: ['arc_outline'], skillStages: ['planning'], output: 'visible-text',
    })
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    const writingLanguage = workflowWritingLanguage(context)
    const { expectedProjectPath } = this.snapshot
    const { novelConfig: config } = this.snapshot
    const modelFacts = localizeNovelConfigFacts(config, writingLanguage)

    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', expectedProjectPath)
    const premise = core?.premise || ''
    const worldbuilding = core?.worldbuilding || ''
    if (!premise || premise.includes('待生成')) throw new Error(text('故事前提未生成', 'The story premise has not been generated.'))
    if (!worldbuilding || worldbuilding.includes('待生成')) throw new Error(text('世界观未生成', 'Worldbuilding has not been generated.'))

    const totalChapters = Number(config.totalChapters) || 0
    if (totalChapters <= 0) throw new Error(text('总章数无效', 'The total chapter count is invalid.'))

    const existing = await ipc.invokeWithProjectSession(projectSession, 'db:arc-outline-list', expectedProjectPath)
    const arcs = Array.isArray(existing) ? existing : []
    let from = 1
    for (const arc of arcs) { from = Math.max(from, arc.toChapter + 1) }

    if (from > totalChapters) {
      callbacks.log(text('粗纲已覆盖全书。', 'The arc outline already covers the whole book.'))
      return ''
    }

    const recentBeats = arcs.map(arc => arc.beat).slice(-3)
    const roster = await ipc.invokeWithProjectSession(projectSession, 'db:character-roster-read', expectedProjectPath).catch(() => null)
    const characterNames = roster?.entries?.map((entry: { name: string }) => entry.name).filter(Boolean) ?? []
    const roleByName = new Map<string, string | undefined>(
      (roster?.entries ?? []).map((entry: { name: string; role?: string }) => [entry.name, entry.role]),
    )

    callbacks.log(text(`正在生成第 ${from} 章起的粗纲…`, `Generating the arc segment starting at chapter ${from}…`))

    const priorArcSummary = arcs.slice(-2).map(arc => promptLanguageText(writingLanguage,
      `第 ${arc.fromChapter}–${arc.toChapter} 章（${arc.beat}）：${arc.title}`,
      `Chapters ${arc.fromChapter}-${arc.toChapter} (${arc.beat}): ${arc.title}`)).join('\n')

    const task = [
      promptLanguageText(writingLanguage,
        `【故事前提】\n${premise}\n\n【世界观】\n${worldbuilding}\n\n【题材与受众】\n${modelFacts.genre} / ${modelFacts.targetAudience}`,
        `[Story premise]\n${premise}\n\n[Worldbuilding]\n${worldbuilding}\n\n[Genre and audience]\n${modelFacts.genre} / ${modelFacts.targetAudience}`),
      priorArcSummary ? promptLanguageText(writingLanguage,
        `【已确认的前序段（不要重复其内容）】\n${priorArcSummary}`,
        `[Confirmed preceding segments (do not repeat)]\n${priorArcSummary}`) : '',
      arcInstruction(writingLanguage, from, totalChapters, recentBeats),
    ].filter(Boolean).join('\n\n')

    const completion = await this.callLLMResult(
      task,
      promptLanguageText(writingLanguage, '你是一位长篇小说的故事架构师。', 'You are a story architect for long-form fiction.'),
      callbacks,
      { purpose: `arc-outline:from:${from}`, reasoningStage: 'planning', writingSkillStage: 'planning' },
      context,
    )

    const accepted = acceptArcSegmentWithNameFallback(
      completion.content, from, totalChapters, characterNames, recentBeats, roleByName, writingLanguage,
    )
    const segment = accepted.segment
    if (accepted.replacedNames.length > 0) {
      callbacks.log(text(
        `粗纲里出现了人名（${accepted.replacedNames.join(text('、', ', '))}），已按角色定位换成身份词——粗纲只写方向，人名留到细纲。`,
        `The arc draft mentioned character names (${accepted.replacedNames.join(', ')}); they were replaced with role words. Arc segments carry direction only; names belong in the chapter outline.`,
      ))
    }

    const saved = await ipc.invokeWithProjectSession(projectSession, 'db:arc-outline-save', {
      arcIndex: arcs.length + 1,
      fromChapter: segment.fromChapter,
      toChapter: segment.toChapter,
      title: segment.title || text('未命名段', 'Untitled segment'),
      summary: segment.summary,
      beat: segment.beat,
    }, expectedProjectPath)
    requireIpcSuccess(saved as { success: boolean; error?: string }, text('保存粗纲', 'Save the arc outline'))

    callbacks.log(text(
      `已生成粗纲第 ${arcs.length + 1} 段：第 ${segment.fromChapter}–${segment.toChapter} 章（${segment.beat}）`,
      `Arc segment ${arcs.length + 1} generated: chapters ${segment.fromChapter}-${segment.toChapter} (${segment.beat}).`,
    ))
    return segment.summary
  }
}

/**
 * 对话式重生成一个粗纲段。
 *
 * 作者用自然语言说明方向，模型只重写这一段的标题、beat 与方向正文；
 * 段区间保持不变（边界由作者在别处调整）。成功后该段回到 draft 待确认，
 * 其后的段标记 needs_regen，因为它们依赖被改段的结果。
 */
export class RegenerateArcOutlineSegmentCommand extends BaseWorkflowCommand<string> {
  constructor(
    private snapshot: ArchitectureProjectSnapshot,
    private input: { arcIndex: number; expectedRevision: number; direction: string },
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    return this.executeWithGenerationRuntime('text', params, () => this.executeWithinGeneration(params), {
      authorInputs: [
        { id: 'arc:author-config', text: JSON.stringify(this.snapshot.novelConfig) },
        { id: 'arc:author-direction', text: this.input.direction },
      ],
      operation: 'regenerate-arc-outline-segment', promptKeys: ['arc_outline'], skillStages: ['planning'], output: 'visible-text',
    })
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    const writingLanguage = workflowWritingLanguage(context)
    const { expectedProjectPath } = this.snapshot

    const existing = await ipc.invokeWithProjectSession(projectSession, 'db:arc-outline-list', expectedProjectPath)
    const arcs = Array.isArray(existing) ? existing : []
    const target = arcs.find(arc => arc.arcIndex === this.input.arcIndex)
    if (!target) throw new Error(text('粗纲段不存在，可能已被修改。', 'The arc segment no longer exists.'))
    if (target.revision !== this.input.expectedRevision) throw new Error('ARC_OUTLINE_REVISION_STALE')

    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', expectedProjectPath)
    const premise = core?.premise || ''
    const worldbuilding = core?.worldbuilding || ''
    if (!premise || !worldbuilding) throw new Error(text('故事前提或世界观未生成', 'The premise or worldbuilding has not been generated.'))

    const roster = await ipc.invokeWithProjectSession(projectSession, 'db:character-roster-read', expectedProjectPath).catch(() => null)
    const characterNames = roster?.entries?.map((entry: { name: string }) => entry.name).filter(Boolean) ?? []
    const roleByName = new Map<string, string | undefined>(
      (roster?.entries ?? []).map((entry: { name: string; role?: string }) => [entry.name, entry.role]),
    )
    const neighbours = arcs
      .filter(arc => arc.arcIndex === this.input.arcIndex - 1 || arc.arcIndex === this.input.arcIndex + 1)
      .map(arc => promptLanguageText(writingLanguage,
        `第 ${arc.fromChapter}–${arc.toChapter} 章（${arc.beat}）${arc.title}：${arc.summary}`,
        `Chapters ${arc.fromChapter}-${arc.toChapter} (${arc.beat}) ${arc.title}: ${arc.summary}`))
      .join('\n\n')

    callbacks.log(text(
      `正在按作者方向重写粗纲第 ${target.arcIndex} 段…`,
      `Rewriting arc segment ${target.arcIndex} along the author's direction…`,
    ))

    const task = [
      promptLanguageText(writingLanguage,
        `【故事前提】\n${premise}\n\n【世界观】\n${worldbuilding}`,
        `[Story premise]\n${premise}\n\n[Worldbuilding]\n${worldbuilding}`),
      promptLanguageText(writingLanguage,
        `【需要重写的粗纲段】第 ${target.fromChapter}–${target.toChapter} 章
当前标题：${target.title}
当前形态：${target.beat}
当前方向：
${target.summary}`,
        `[Arc segment to rewrite] Chapters ${target.fromChapter}-${target.toChapter}
Current title: ${target.title}
Current beat: ${target.beat}
Current direction:
${target.summary}`),
      neighbours ? promptLanguageText(writingLanguage,
        `【相邻段（必须衔接，不要改它们的区间）】\n${neighbours}`,
        `[Neighbouring segments (must connect; do not change their ranges)]\n${neighbours}`) : '',
      promptLanguageText(writingLanguage,
        `【作者的新方向】\n${this.input.direction}`,
        `[Author's new direction]\n${this.input.direction}`),
      promptLanguageText(writingLanguage,
        `【本次任务】只重写这一段，章数区间保持第 ${target.fromChapter}–${target.toChapter} 章不变。

硬性要求：
1. 正文绝对不能出现任何具体人名，用「主角」「对手」这类身份词。
2. 只写方向：事件链与因果、冲突与代价、转折与节奏、结果与状态变化。
3. beat 必须取自：${ARC_BEATS.join(' | ')}。
4. 必须服从作者的新方向，并同时与前后相邻段衔接。

输出格式（严格遵守，不要代码围栏）：
## 第${target.fromChapter}–${target.toChapter}章：{段标题}
beat: {beat}
{正文，不含任何人名}`,
        `[Task] Rewrite only this segment; keep the range chapters ${target.fromChapter}-${target.toChapter} unchanged.

Hard requirements:
1. The body must never contain any proper character name; use role words.
2. State direction only: event chain and causality, conflict and cost, turning points and pacing, outcomes and state changes.
3. beat must come from: ${ARC_BEATS.join(' | ')}.
4. Follow the author's new direction and connect to the neighbouring segments.

Output format (strict, no code fences):
## Chapter ${target.fromChapter}-${target.toChapter}: {segment title}
beat: {beat}
{body, containing no proper names}`),
    ].filter(Boolean).join('\n\n')

    const completion = await this.callLLMResult(
      task,
      promptLanguageText(writingLanguage, '你是一位长篇小说的故事架构师。', 'You are a story architect for long-form fiction.'),
      callbacks,
      { purpose: `arc-outline:revise:${target.arcIndex}`, reasoningStage: 'planning', writingSkillStage: 'planning' },
      context,
    )

    const parsed = parseArcSegment(completion.content)
    if (!parsed.ok) throw new Error(parsed.code)
    const segment = parsed.segment
    if (segment.fromChapter !== target.fromChapter || segment.toChapter !== target.toChapter) {
      throw new Error('ARC_OUTLINE_RANGE_CHANGED')
    }
    // 人名不再判失败：按角色定位换掉，粗纲只写方向。
    const cleanedNames = sanitizeArcProperNames(segment.summary, characterNames, roleByName, writingLanguage)
    if (cleanedNames.replaced.length > 0) {
      callbacks.log(text(
        `粗纲里出现了人名（${cleanedNames.replaced.join(text('、', ', '))}），已按角色定位换成身份词。`,
        `The rewritten arc segment mentioned character names (${cleanedNames.replaced.join(', ')}); they were replaced with role words.`,
      ))
      segment.summary = cleanedNames.text
    }
    // 重写后的 beat 必须仍与相邻段形成形态差异，避免连续同一种推进方式。
    const adjacentBeats = arcs
      .filter(arc => arc.arcIndex === target.arcIndex - 1 || arc.arcIndex === target.arcIndex + 1)
      .map(arc => arc.beat)
    const diversity = validateBeatDiversity(segment.beat, adjacentBeats)
    if (!diversity.ok) throw new Error(diversity.code)

    const saved = await ipc.invokeWithProjectSession(projectSession, 'db:arc-outline-replace-segment',
      target.arcIndex,
      this.input.expectedRevision,
      {
        title: segment.title || target.title,
        summary: segment.summary,
        beat: segment.beat,
      },
      expectedProjectPath)
    requireIpcSuccess(saved as { success: boolean; error?: string }, text('保存重写的粗纲段', 'Save the rewritten arc segment'))
    await ipc.invokeWithProjectSession(projectSession, 'db:arc-outline-mark-needs-regen', target.arcIndex, expectedProjectPath).catch(() => null)
    // 该段已生成的细纲与新版粗纲不再一致，标记为 stale，界面会提示重生成。
    await ipc.invokeWithProjectSession(
      projectSession,
      'db:arc-binding-mark-stale',
      target.id,
      this.input.expectedRevision + 1,
      expectedProjectPath,
    ).catch(() => null)

    callbacks.log(text(
      `粗纲第 ${target.arcIndex} 段已按新方向重写，后续段已标记待重生成。`,
      `Arc segment ${target.arcIndex} was rewritten; later segments are marked for regeneration.`,
    ))
    return segment.summary
  }
}

/**
 * 从已有细纲反推粗纲。
 *
 * 场景：作者已经写了 508 章细纲，但没有粗纲。此命令把已有章节交给模型，
 * 由模型判断该分成哪几段（段长仍由模型决定），每段给出标题、beat 与
 * **不含人名**的方向描述，全部以 draft 状态落库，供作者逐段检查修改。
 */
export class ReverseArcOutlineCommand extends BaseWorkflowCommand<string> {
  constructor(
    private snapshot: ArchitectureProjectSnapshot,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    return this.executeWithGenerationRuntime('text', params, () => this.executeWithinGeneration(params), {
      authorInputs: [{ id: 'arc:author-config', text: JSON.stringify(this.snapshot.novelConfig) }],
      operation: 'reverse-arc-outline', promptKeys: ['arc_outline'], skillStages: ['planning'], output: 'visible-text',
    })
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const projectSession = requireWorkflowProjectSession(context)
    const writingLanguage = workflowWritingLanguage(context)
    const { expectedProjectPath } = this.snapshot
    const { novelConfig: config } = this.snapshot

    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', expectedProjectPath)
    const synopsis = core?.synopsis ?? ''
    if (!synopsis.trim()) throw new Error(text('当前没有细纲可供反推。', 'There is no chapter outline to derive from.'))
    const totalChapters = Number(config.totalChapters) || 0
    if (totalChapters <= 0) throw new Error(text('总章数无效', 'The total chapter count is invalid.'))

    const existing = await ipc.invokeWithProjectSession(projectSession, 'db:arc-outline-list', expectedProjectPath)
    if (Array.isArray(existing) && existing.length > 0) {
      throw new Error(text('已有粗纲，反推会覆盖它。请先清空粗纲再反推。', 'An arc outline already exists; deriving would overwrite it. Clear it first.'))
    }

    const roster = await ipc.invokeWithProjectSession(projectSession, 'db:character-roster-read', expectedProjectPath).catch(() => null)
    const characterNames = roster?.entries?.map((entry: { name: string }) => entry.name).filter(Boolean) ?? []
    const roleByName = new Map<string, string | undefined>(
      (roster?.entries ?? []).map((entry: { name: string; role?: string }) => [entry.name, entry.role]),
    )

    callbacks.log(text('正在把已有细纲归纳为粗纲段…', 'Condensing the existing chapter outline into arc segments…'))

    const task = [
      promptLanguageText(writingLanguage,
        `【已有情节大纲（逐章）】\n${synopsis}`,
        `[Existing chapter outline]\n${synopsis}`),
      promptLanguageText(writingLanguage, `【本次任务：反推粗纲】

上面是已经写好的逐章细纲（全书共 ${totalChapters} 章，实际已写到第 ${lastChapterNumber(synopsis)} 章）。

请把它归纳成若干**粗纲段**，供作者检查方向。要求：

1. 分段由你判断：一段覆盖多少章取决于该段戏剧命题的大小，跨度必须在 ${ARC_MIN_CHAPTERS}–${ARC_MAX_CHAPTERS} 章之间。
2. 每段正文**绝对不能出现任何具体人名**，用「主角」「对手」这类身份词。人名只属于细纲层。
3. 每段只写方向：主要事件链与因果、冲突与代价、转折与节奏、结果与状态变化。
4. 必须完整覆盖从第 1 章到第 ${lastChapterNumber(synopsis)} 章，段与段首尾相接、不重叠、不留空。
5. beat 取自：${ARC_BEATS.join(' | ')}。

输出格式（每段一个块，不要代码围栏）：

## 第{from}–{to}章：{段标题}
beat: {beat}
{正文，不含任何人名}
`, `[Task: derive the arc outline]

Above is the finished chapter-by-chapter outline (book has ${totalChapters} chapters; ${lastChapterNumber(synopsis)} are written).

Condense it into **arc segments** for the author to review. Requirements:

1. You decide the segmentation: span depends on the dramatic proposition, and must be between ${ARC_MIN_CHAPTERS} and ${ARC_MAX_CHAPTERS}.
2. A segment body must **never contain proper character names**; use role words. Names belong to the chapter level.
3. Each segment states direction only: event chain and causality, conflict and cost, turning points and pacing, outcomes and state changes.
4. Cover chapters 1 through ${lastChapterNumber(synopsis)} completely: contiguous, non-overlapping, no gaps.
5. beat from: ${ARC_BEATS.join(' | ')}.

Output format (one block per segment, no code fences):

## Chapter {from}-{to}: {segment title}
beat: {beat}
{body, containing no proper names}
`),
    ].join('\n\n')

    const completion = await this.callLLMResult(
      task,
      promptLanguageText(writingLanguage, '你是一位长篇小说的故事架构师。', 'You are a story architect for long-form fiction.'),
      callbacks,
      { purpose: 'reverse-arc-outline', reasoningStage: 'planning', writingSkillStage: 'planning' },
      context,
    )

    const segments = parseArcSegments(completion.content)
    if (segments.length === 0) throw new Error(text('模型没有返回可用的粗纲段。', 'The model returned no usable arc segments.'))

    // 逐段校验：人名、段长、连续覆盖。任一段不合格即整体拒绝，避免半截粗纲。
    let expectedFrom = 1
    const recentBeats: ArcBeat[] = []
    for (const segment of segments) {
      if (segment.fromChapter !== expectedFrom) throw new Error('ARC_OUTLINE_RANGE_GAP')
      const span = validateArcSpan(segment.fromChapter, segment.toChapter, totalChapters)
      if (!span.ok) throw new Error(span.code)
      // 人名不再判失败：反推粗纲时逐段换掉，粗纲只写方向。
      const cleanedNames = sanitizeArcProperNames(segment.summary, characterNames, roleByName, writingLanguage)
      if (cleanedNames.replaced.length > 0) {
        callbacks.log(text(
          `第 ${segment.fromChapter}–${segment.toChapter} 段的粗纲出现了人名（${cleanedNames.replaced.join(text('、', ', '))}），已换成身份词。`,
          `The arc segment for chapters ${segment.fromChapter}-${segment.toChapter} mentioned character names (${cleanedNames.replaced.join(', ')}); they were replaced with role words.`,
        ))
        segment.summary = cleanedNames.text
      }
      const diversity = validateBeatDiversity(segment.beat, recentBeats)
      if (!diversity.ok) throw new Error(diversity.code)
      recentBeats.push(segment.beat)
      expectedFrom = segment.toChapter + 1
    }

    for (const [index, segment] of segments.entries()) {
      const saved = await ipc.invokeWithProjectSession(projectSession, 'db:arc-outline-save', {
        arcIndex: index + 1,
        fromChapter: segment.fromChapter,
        toChapter: segment.toChapter,
        title: segment.title || text(`第 ${index + 1} 段`, `Segment ${index + 1}`),
        summary: segment.summary,
        beat: segment.beat,
      }, expectedProjectPath)
      requireIpcSuccess(saved as { success: boolean; error?: string }, text('保存粗纲', 'Save the arc outline'))
    }

    callbacks.log(text(
      `已反推 ${segments.length} 段粗纲，覆盖第 1–${expectedFrom - 1} 章，全部为草稿，请逐段检查。`,
      `Derived ${segments.length} arc segments covering chapters 1-${expectedFrom - 1}. All are drafts; review each one.`,
    ))
    return segments.map(segment => segment.summary).join('\n\n')
  }
}

/** 解析模型返回的多段粗纲。 */
export function parseArcSegments(raw: string): { fromChapter: number; toChapter: number; title: string; beat: ArcBeat; summary: string }[] {
  const blocks = raw.replace(/\r\n?/gu, '\n').split(/^(?=#{1,4}\s*第\s*\d+)/mu).filter(part => part.trim())
  const segments: { fromChapter: number; toChapter: number; title: string; beat: ArcBeat; summary: string }[] = []
  for (const block of blocks) {
    const parsed = parseArcSegment(block)
    if (parsed.ok) segments.push(parsed.segment)
  }
  return segments
}

function lastChapterNumber(synopsis: string): number {
  let last = 0
  for (const match of synopsis.matchAll(/^#{1,4}\s*第\s*(\d+)\s*章/gmu)) {
    last = Math.max(last, Number(match[1]))
  }
  return last || 1
}
