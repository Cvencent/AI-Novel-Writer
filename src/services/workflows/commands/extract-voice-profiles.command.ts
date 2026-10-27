import { BaseWorkflowCommand, type CommandExecuteParams, type WorkflowGenerationRuntimeDependencies } from './base-command'
import { ipc } from '../../ipc-client'
import { requireWorkflowProjectSession, workflowWritingLanguage } from '../workflow-project-session'
import { promptLanguageText } from '../../prompt-language'
import { hashAuthorText } from '../../../shared/source-ref'
import { buildVoiceProfilePrompt } from '../../../shared/writing-intelligence-prompts'
import { parseVoiceProfilesResponse, type CharacterVoiceProfileRecord } from '../../../shared/writing-intelligence'

export interface ExtractVoiceProfilesParams {
  chapterNumber: number
  draftId: number
  draftVersion: number
}

export class ExtractVoiceProfilesCommand extends BaseWorkflowCommand<CharacterVoiceProfileRecord[]> {
  constructor(private readonly params: ExtractVoiceProfilesParams, dependencies?: WorkflowGenerationRuntimeDependencies) {
    super(dependencies)
  }

  async execute(params: CommandExecuteParams): Promise<CharacterVoiceProfileRecord[]> {
    return this.executeWithGenerationRuntime('structured', params, () => this.executeWithinGeneration(params), {
      authorInputs: [{ id: 'voice-profile:draft', text: String(this.params.draftId) }, { id: 'voice-profile:version', text: String(this.params.draftVersion) }],
      operation: 'extract-character-voices', promptKeys: [], skillStages: ['review'], output: 'structured-data',
    })
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<CharacterVoiceProfileRecord[]> {
    const session = requireWorkflowProjectSession(context)
    const language = workflowWritingLanguage(context)
    const [draft, roster] = await Promise.all([
      ipc.invokeWithProjectSession(session, 'db:draft-get-full', this.params.draftId, session.projectPath),
      ipc.invokeWithProjectSession(session, 'db:character-roster-read', session.projectPath),
    ])
    if (!draft || draft.chapterNumber !== this.params.chapterNumber || draft.version !== this.params.draftVersion) {
      throw new Error(promptLanguageText(language, '草稿身份已变化，角色声音提取未启动。', 'The draft identity changed, so voice extraction did not start.'))
    }
    const entries = Array.isArray(roster.entries) ? roster.entries : []
    const identified = entries.filter(entry => typeof entry.characterId === 'string' && entry.characterId)
    const allowed = identified.map(entry => ({ characterId: entry.characterId!, name: entry.name }))
    const prompt = buildVoiceProfilePrompt({
      chapterNumber: this.params.chapterNumber,
      content: draft.content,
      roster: identified.map(entry => ({ characterId: entry.characterId!, name: entry.name, role: entry.role, profile: JSON.stringify(entry, null, 1) })),
      language,
    })
    callbacks.log(promptLanguageText(language, '正在从本章定稿提取角色声音...', 'Extracting character voices from this chapter...'))
    const completion = await this.callLLMResult(
      prompt,
      promptLanguageText(language, '你是一位对白编辑。只用正文中的逐字证据总结角色声音，不用剧情简介代替分析。', 'You are a dialogue editor. Infer voice only from exact manuscript evidence, never from plot summaries.'),
      callbacks,
      { responseFormat: { type: 'json_object' }, purpose: 'extract-character-voices', reasoningStage: 'review', writingSkillStage: 'review' },
      context,
    )
    const parsed = parseVoiceProfilesResponse(completion.content, allowed, draft.content)
    const contentHash = await hashAuthorText(draft.content)
    const profiles = parsed.map(profile => ({ ...profile, sourceDraftId: this.params.draftId, contentHash, updatedAt: '' }))
    const saved = await ipc.invokeWithProjectSession(session, 'db:writing-intelligence-voices-save', this.params.draftId, contentHash, profiles, session.projectPath)
    callbacks.log(promptLanguageText(language, `已更新 ${saved.length} 个角色声音档案。`, `${saved.length} character voice profiles updated.`))
    return saved
  }
}