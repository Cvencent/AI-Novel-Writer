import {
  ARC_MAX_CHAPTERS, ARC_MIN_CHAPTERS, ARC_BEATS,
  parseArcSegment, validateArcNoProperNames, validateArcSpan, validateBeatDiversity,
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
      operation: 'generate-arc-outline', promptKeys: [], skillStages: ['planning'], output: 'visible-text',
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

    const segment = assertArcSegmentAcceptable(
      completion.content, from, totalChapters, characterNames, recentBeats,
    )

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
