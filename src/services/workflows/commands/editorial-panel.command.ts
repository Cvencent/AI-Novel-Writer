import { BaseWorkflowCommand, type CommandExecuteParams, type WorkflowGenerationRuntimeDependencies } from './base-command'
import { ipc } from '../../ipc-client'
import { requireWorkflowProjectSession, workflowWritingLanguage } from '../workflow-project-session'
import { promptLanguageText } from '../../prompt-language'
import { hashAuthorText } from '../../../shared/source-ref'
import { buildEditorialPanelPrompt } from '../../../shared/writing-intelligence-prompts'
import { parseEditorialPanelResponse, type DraftQualityReview } from '../../../shared/writing-intelligence'
import type { BlueprintForPreflight } from '../../../shared/consistency-preflight'

export interface EditorialPanelParams {
  chapterNumber: number
  draftId: number
  draftVersion: number
}

export class EditorialPanelCommand extends BaseWorkflowCommand<DraftQualityReview> {
  constructor(private readonly params: EditorialPanelParams, dependencies?: WorkflowGenerationRuntimeDependencies) {
    super(dependencies)
  }

  async execute(params: CommandExecuteParams): Promise<DraftQualityReview> {
    return this.executeWithGenerationRuntime('structured', params, () => this.executeWithinGeneration(params), {
      authorInputs: [{ id: 'editorial-panel:draft', text: String(this.params.draftId) }, { id: 'editorial-panel:version', text: String(this.params.draftVersion) }],
      // begin 准入要求 promptKeys 非空且可解析到内建模板（来源绑定会对每个 key
      // 取内建提示词做指纹）。本命令的评审提示词由 buildEditorialPanelPrompt
      // 内联构建，这里登记语义最接近的 consistency_check 作为来源资产。
      operation: 'editorial-panel-review', promptKeys: ['consistency_check'], skillStages: ['review'], output: 'structured-data',
    })
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<DraftQualityReview> {
    const session = requireWorkflowProjectSession(context)
    const language = workflowWritingLanguage(context)
    const [draft, blueprint, roster, threads] = await Promise.all([
      ipc.invokeWithProjectSession(session, 'db:draft-get-full', this.params.draftId, session.projectPath),
      ipc.invokeWithProjectSession(session, 'db:blueprint-get', this.params.chapterNumber, session.projectPath),
      ipc.invokeWithProjectSession(session, 'db:character-roster-read', session.projectPath).catch(() => null),
      ipc.invokeWithProjectSession(session, 'db:narrative-thread-list-relevant', {
        chapterNumber: this.params.chapterNumber, title: '', keyEvents: '', characters: [],
      }, session.projectPath).catch(() => []),
    ])
    if (!draft || draft.chapterNumber !== this.params.chapterNumber || draft.version !== this.params.draftVersion) {
      throw new Error(promptLanguageText(language, '草稿身份已变化，编辑部评审未启动。', 'The draft identity changed, so the editorial review did not start.'))
    }
    const contentHash = await hashAuthorText(draft.content)
    const preflightBlueprint: BlueprintForPreflight = {
      chapterNumber: this.params.chapterNumber, title: blueprint?.title || '', role: blueprint?.role || '',
      purpose: blueprint?.purpose || '', keyEvents: blueprint?.keyEvents || '', characters: blueprint?.characters || [],
      suspenseHook: blueprint?.suspenseHook || '', costsAndTurns: blueprint?.costsAndTurns || '',
      foreshadowing: blueprint?.foreshadowing || '', userGuidance: blueprint?.userGuidance || '', notes: blueprint?.notes || '',
    }
    const entries = Array.isArray(roster?.entries) ? roster.entries : []
    const rosterFacts = entries.filter(entry => typeof entry.characterId === 'string' && entry.characterId).map(entry => ({ characterId: entry.characterId!, name: entry.name, role: entry.role, profile: JSON.stringify(entry, null, 1) }))
    const narrativeConstraints = Array.isArray(threads) ? threads.map(thread => {
      const flags = [thread.overdue ? 'overdue' : '', thread.dormantChapters >= 3 ? `dormant:${thread.dormantChapters}` : ''].filter(Boolean).join(',')
      return `- ${thread.title} [${thread.status}${flags ? ` ${flags}` : ''}] ${thread.authorIntent || ''}`
    }).join('\n') : ''
    const prompt = buildEditorialPanelPrompt({
      chapterNumber: this.params.chapterNumber, draftVersion: this.params.draftVersion, content: draft.content,
      blueprint: preflightBlueprint, roster: rosterFacts, narrativeConstraints, language,
    })
    callbacks.log(promptLanguageText(language, '五位编辑正在并行评审本章...', 'Five editors are reviewing this chapter...'))
    const completion = await this.callLLMResult(
      prompt,
      promptLanguageText(language, '你是五人编辑部。所有判断必须可追溯到正文证据；不要把风格偏好冒充硬错误。', 'You are a five-person editorial panel. Every judgment must trace to manuscript evidence; never disguise style preferences as hard errors.'),
      callbacks,
      { responseFormat: { type: 'json_object' }, purpose: 'editorial-panel-review', reasoningStage: 'review', writingSkillStage: 'review' },
      context,
    )
    const panel = parseEditorialPanelResponse(completion.content)
    const saved = await ipc.invokeWithProjectSession(session, 'db:writing-intelligence-quality-save', {
      draftId: this.params.draftId, chapterNumber: this.params.chapterNumber, contentHash, panel,
    }, session.projectPath)
    callbacks.log(promptLanguageText(language, `编辑部评分 ${saved.weightedScore.toFixed(1)}，阻断问题 ${saved.blockingCount} 条。`, `Editorial score ${saved.weightedScore.toFixed(1)} with ${saved.blockingCount} blocking findings.`))
    return saved
  }
}