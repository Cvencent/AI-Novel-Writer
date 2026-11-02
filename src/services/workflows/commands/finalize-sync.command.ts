import { BaseWorkflowCommand, type CommandExecuteParams } from './base-command'
import { ipc } from '../../ipc-client'
import { requireIpcSuccess } from '../../ipc-result'
import { requireWorkflowProjectSession, workflowUiText, workflowWritingLanguage } from '../workflow-project-session'
import {
  buildFinalizeSyncPrompt,
  extractFinalizeSyncPlan,
  extractOutlineEntry,
  normalizeFinalizeSyncOutlineEntry,
} from '../../../shared/finalize-sync-contract'
import type { BlueprintData } from '../../../../electron/repositories/blueprint-repository'
import { plotOutlineChapterSpans } from '../../../shared/plot-outline-contract'

/** 用定稿正文校正该章细纲与蓝图：正文是权威，AI 只修真实且实质的偏差，直接写库。 */
export class FinalizeSyncCommand extends BaseWorkflowCommand<string> {
  constructor(
    private readonly chapterNumber: number,
    private readonly finalizedContent: string,
  ) { super() }

  async execute(params: CommandExecuteParams): Promise<string> {
    return this.executeWithGenerationRuntime('text', params, () => this.executeWithinGeneration(params), {
      authorInputs: [{ id: 'finalize-sync:chapter', text: String(this.chapterNumber) }, { id: 'finalize-sync:prose', text: this.finalizedContent }],
      operation: 'finalize-sync', promptKeys: ['synopsis'], skillStages: ['planning'], output: 'visible-text',
    })
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const text = (zh: string, en: string) => workflowUiText(context, zh, en)
    const projectSession = requireWorkflowProjectSession(context)
    const writingLanguage = workflowWritingLanguage(context)
    const expectedProjectPath = projectSession.projectPath

    callbacks.log(text('正在读取该章细纲与蓝图...', 'Reading the chapter outline and blueprint...'))
    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', expectedProjectPath)
    const synopsis = core?.synopsis || ''
    // issue #61：旧实现只认 `project_core.synopsis`，而很多项目的这份大纲只覆盖前几章
    // （本样本 22 章定稿、synopsis 只有第 1–3 章），于是第 4 章以后点这个入口必然失败，
    // 而且失败只有一句断言、没有任何出路。现在：没有细纲条目时**只校正蓝图**，
    // 并在日志里说清「本章不在情节大纲里，细纲未改动」。
    const outlineEntry = extractOutlineEntry(synopsis, this.chapterNumber) ?? ''
    const coveredChapters = plotOutlineChapterSpans(synopsis).map(span => span.chapter)
    const coveredRange = coveredChapters.length
      ? `第 ${coveredChapters[0]}–${coveredChapters[coveredChapters.length - 1]} 章`
      : (writingLanguage === 'en-US' ? '(empty)' : '（空）')
    const blueprint = await ipc.invokeWithProjectSession(projectSession, 'db:blueprint-get', this.chapterNumber, expectedProjectPath) as BlueprintData | null
    if (!blueprint) {
      throw new Error(text(
        `这一章既没有蓝图、也不在情节大纲里（大纲目前覆盖 ${coveredRange}），没有可校正的内容。请先生成第 ${this.chapterNumber} 章蓝图。`,
        `This chapter has neither a blueprint nor an entry in the plot outline (the outline covers ${coveredRange}). Generate the chapter blueprint first.`,
      ))
    }
    if (!outlineEntry) {
      callbacks.log(text(
        `本章不在「情节大纲」里（大纲目前覆盖 ${coveredRange}），本次只校正蓝图，细纲不改动。`,
        `This chapter is not in the plot outline (it covers ${coveredRange}), so only the blueprint will be corrected.`,
      ))
    }

    callbacks.log(text('AI 正在对比定稿正文与细纲、蓝图...', 'The model is comparing the finalized prose with the outline and blueprint...'))
    const completion = await this.callLLMResult(
      buildFinalizeSyncPrompt({
        chapterNumber: this.chapterNumber,
        finalizedContent: this.finalizedContent,
        outlineEntry,
        blueprint: {
          role: blueprint.role || '', purpose: blueprint.purpose || '', keyEvents: blueprint.keyEvents || '',
          characters: Array.isArray(blueprint.characters) ? blueprint.characters : [],
          suspenseHook: blueprint.suspenseHook || '', costsAndTurns: blueprint.costsAndTurns || '', foreshadowing: blueprint.foreshadowing || '',
        },
        language: writingLanguage,
      }),
      text('你是一位严格的长篇小说连续性编辑。定稿正文是权威，只修真实且实质的偏差。', 'You are a rigorous continuity editor for long-form fiction. The finalized prose is authoritative; fix only real, material deviations.'),
      callbacks,
      { purpose: `finalize-sync:chapter:${this.chapterNumber}`, reasoningStage: 'planning', writingSkillStage: 'planning' },
      context,
    )
    const plan = extractFinalizeSyncPlan(completion.content)
    if (!plan) throw new Error(text('模型输出无法解析为校正方案，未做任何修改。', 'The model reply could not be parsed into a correction plan; nothing was changed.'))

    const titleMatch = /^##\s*第\s*\d+\s*章[：:]?\s*([^\n]*)/.exec(plan.outlineEntry)
    const dbTitle = blueprint.title || (titleMatch?.[1]?.trim() ?? '')
    // 只有原本就有细纲条目时才写回细纲：没有条目时 `replacePlotOutlineChapter` 会拒绝，
    // 而「凭空补一条细纲」不是这个功能的职责（那会把没写过的章节塞进大纲）。
    const normalizedEntry = outlineEntry && plan.outlineEntry.trim()
      ? normalizeFinalizeSyncOutlineEntry(plan.outlineEntry, this.chapterNumber, dbTitle)
      : ''

    callbacks.log(text('正在写回细纲与蓝图...', 'Writing the corrected outline and blueprint...'))
    if (normalizedEntry) {
      const outlineResult = await ipc.invokeWithProjectSession(projectSession, 'db:stage-review-apply-outline', this.chapterNumber, normalizedEntry, expectedProjectPath)
      requireIpcSuccess(outlineResult as { success: boolean; error?: string }, text('写回细纲失败', 'Failed to write the corrected outline'))
    }
    const patch: Record<string, unknown> = { chapterNumber: this.chapterNumber }
    if (plan.blueprint.role !== undefined) patch.role = plan.blueprint.role
    if (plan.blueprint.purpose !== undefined) patch.purpose = plan.blueprint.purpose
    if (plan.blueprint.keyEvents !== undefined) patch.keyEvents = plan.blueprint.keyEvents
    if (plan.blueprint.characters !== undefined) patch.characters = plan.blueprint.characters
    if (plan.blueprint.suspenseHook !== undefined) patch.suspenseHook = plan.blueprint.suspenseHook
    if (plan.blueprint.costsAndTurns !== undefined) patch.costsAndTurns = plan.blueprint.costsAndTurns
    if (plan.blueprint.foreshadowing !== undefined) patch.foreshadowing = plan.blueprint.foreshadowing
    const blueprintResult = await ipc.invokeWithProjectSession(projectSession, 'db:stage-review-apply-blueprint', this.chapterNumber, patch, expectedProjectPath)
    requireIpcSuccess(blueprintResult as { success: boolean; error?: string }, text('写回蓝图失败', 'Failed to write the corrected blueprint'))

    for (const note of plan.notes) callbacks.log(text(`差异：${note}`, `Difference: ${note}`))
    callbacks.log(normalizedEntry
      ? text(`第 ${this.chapterNumber} 章细纲与蓝图已按定稿正文校正。`, `Chapter ${this.chapterNumber} outline and blueprint were aligned with the finalized prose.`)
      : text(`第 ${this.chapterNumber} 章蓝图已按定稿正文校正（本章不在情节大纲里，细纲未改动）。`,
        `Chapter ${this.chapterNumber} blueprint was aligned with the finalized prose (this chapter is not in the plot outline, so the outline was left unchanged).`))
    return normalizedEntry
  }
}

