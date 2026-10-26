import { BaseWorkflowCommand, type CommandExecuteParams } from './base-command'
import { ipc } from '../../ipc-client'
import { requireIpcSuccess } from '../../ipc-result'
import { requireWorkflowProjectSession, workflowUiText, workflowWritingLanguage } from '../workflow-project-session'
import { buildRosterSyncPrompt, extractRosterSyncPlan, mergeRosterSyncPlan } from '../../../shared/roster-sync-contract'
import { randomUUID } from '../../../utils/id'

/** 修稿合并后的人物关系同步：修稿后正文是事实来源，AI 只更新真正变化的关系。 */
export class RosterSyncCommand extends BaseWorkflowCommand<string> {
  constructor(private readonly mergedProse: string) { super() }

  async execute(params: CommandExecuteParams): Promise<string> {
    return this.executeWithGenerationRuntime('text', params, () => this.executeWithinGeneration(params), {
      authorInputs: [{ id: 'roster-sync:prose', text: this.mergedProse.slice(0, 4000) }],
      operation: 'roster-sync', promptKeys: ['synopsis'], skillStages: ['planning'], output: 'visible-text',
    })
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const text = (zh: string, en: string) => workflowUiText(context, zh, en)
    const projectSession = requireWorkflowProjectSession(context)
    const writingLanguage = workflowWritingLanguage(context)
    const expectedProjectPath = projectSession.projectPath

    callbacks.log(text('正在读取当前人物名单...', 'Reading the current character roster...'))
    const roster = await ipc.invokeWithProjectSession(projectSession, 'db:character-roster-read', expectedProjectPath) as unknown as {
      status: string; entries: Array<Record<string, unknown>>; revision: number
    }
    if (roster.status !== 'ready' || !Array.isArray(roster.entries) || roster.entries.length === 0) {
      callbacks.log(text('没有可同步的人物名单，跳过。', 'No character roster to sync; skipped.'))
      return 'skipped:no-roster'
    }

    callbacks.log(text('AI 正在对比修稿后正文与人物关系...', 'The model is comparing the merged prose with character relationships...'))
    const completion = await this.callLLMResult(
      buildRosterSyncPrompt({
        mergedProse: this.mergedProse,
        roster: JSON.stringify(roster.entries, null, 1),
        language: writingLanguage,
      }),
      text('你是一位严谨的小说连续性编辑。只更新修稿真正改动的人物关系，不发明角色，不动未受影响的条目。', 'You are a rigorous continuity editor. Update only relationships the revision actually changed; never invent characters or touch untouched entries.'),
      callbacks,
      { purpose: 'roster-sync', reasoningStage: 'planning', writingSkillStage: 'planning' },
      context,
    )
    const plan = extractRosterSyncPlan(completion.content)
    if (!plan) {
      callbacks.log(text('模型输出无法解析为关系更新方案，未做任何修改。', 'The model reply could not be parsed into a relationship update; nothing was changed.'))
      return 'skipped:unparsable'
    }

    const merged = mergeRosterSyncPlan(roster.entries as never, plan)
    if (merged.changed.length === 0) {
      callbacks.log(text('对比完成：修稿没有引起人物关系变化。', 'Compared: the revision changed no character relationships.'))
      return 'skipped:no-changes'
    }

    callbacks.log(text(`正在写回 ${merged.changed.length} 个角色的关系...`, `Writing relationships for ${merged.changed.length} characters...`))
    const result = await ipc.invokeWithProjectSession(projectSession, 'db:character-roster-commit', {
      operationId: `roster-sync:${context.runId}:${randomUUID()}`,
      expectedRevision: roster.revision,
      schemaVersion: 1,
      entries: merged.entries,
      intent: 'manual_edit',
    }, expectedProjectPath)
    requireIpcSuccess(result as { success: boolean; error?: string }, text('写回人物关系失败', 'Failed to write character relationships'))

    for (const note of plan.notes) callbacks.log(text(`差异：${note}`, `Difference: ${note}`))
    callbacks.log(text(`人物关系已按修稿更新：${merged.changed.join('、')}。`, `Character relationships updated from the revision: ${merged.changed.join(', ')}.`))
    return 'ok'
  }
}

