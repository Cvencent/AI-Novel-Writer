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
    const outlineEntry = extractOutlineEntry(synopsis, this.chapterNumber)
    if (!outlineEntry) throw new Error(text('细纲里没有这一章的条目，无法校正。', 'The chapter outline has no entry for this chapter.'))
    const blueprint = await ipc.invokeWithProjectSession(projectSession, 'db:blueprint-get', this.chapterNumber, expectedProjectPath) as BlueprintData | null
    if (!blueprint) throw new Error(text('这一章还没有蓝图，无法校正。', 'This chapter has no blueprint.'))

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
    const normalizedEntry = normalizeFinalizeSyncOutlineEntry(plan.outlineEntry, this.chapterNumber, dbTitle)

    callbacks.log(text('正在写回细纲与蓝图...', 'Writing the corrected outline and blueprint...'))
    const outlineResult = await ipc.invokeWithProjectSession(projectSession, 'db:stage-review-apply-outline', this.chapterNumber, normalizedEntry, expectedProjectPath)
    requireIpcSuccess(outlineResult as { success: boolean; error?: string }, text('写回细纲失败', 'Failed to write the corrected outline'))
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
    callbacks.log(text(`第 ${this.chapterNumber} 章细纲与蓝图已按定稿正文校正。`, `Chapter ${this.chapterNumber} outline and blueprint were aligned with the finalized prose.`))
    return normalizedEntry
  }
}

