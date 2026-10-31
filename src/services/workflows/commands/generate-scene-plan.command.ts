import { BaseWorkflowCommand, type CommandExecuteParams, type WorkflowGenerationRuntimeDependencies } from './base-command'
import { ipc } from '../../ipc-client'
import { requireWorkflowProjectSession, workflowWritingLanguage } from '../workflow-project-session'
import { promptLanguageText } from '../../prompt-language'
import { buildScenePlanPrompt } from '../../../shared/writing-intelligence-prompts'
import { parseScenePlanResponse, type SceneCard } from '../../../shared/writing-intelligence'
import type { BlueprintForPreflight } from '../../../shared/consistency-preflight'

export interface GenerateScenePlanParams {
  chapterNumber: number
  targetWords: number
}

export class GenerateScenePlanCommand extends BaseWorkflowCommand<SceneCard[]> {
  constructor(private readonly params: GenerateScenePlanParams, dependencies?: WorkflowGenerationRuntimeDependencies) {
    super(dependencies)
  }

  async execute(params: CommandExecuteParams): Promise<SceneCard[]> {
    return this.executeWithGenerationRuntime('structured', params, () => this.executeWithinGeneration(params), {
      authorInputs: [{ id: 'scene-plan:chapter', text: String(this.params.chapterNumber) }, { id: 'scene-plan:target-units', text: String(this.params.targetWords) }],
      operation: 'generate-scene-plan', promptKeys: ['chapter_blueprint'], skillStages: ['planning'], output: 'structured-data',
    })
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<SceneCard[]> {
    const projectSession = requireWorkflowProjectSession(context)
    const language = workflowWritingLanguage(context)
    const [blueprint, roster, core] = await Promise.all([
      ipc.invokeWithProjectSession(projectSession, 'db:blueprint-get', this.params.chapterNumber, projectSession.projectPath),
      ipc.invokeWithProjectSession(projectSession, 'db:character-roster-read', projectSession.projectPath).catch(() => null),
      ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', projectSession.projectPath).catch(() => null),
    ])
    if (!blueprint) throw new Error(promptLanguageText(language, '本章还没有蓝图，不能生成场景卡。', 'This chapter has no blueprint yet.'))
    const entries = Array.isArray(roster?.entries) ? roster.entries : []
    const names = new Set(Array.isArray(blueprint.characters) ? blueprint.characters : [])
    const characters = entries.filter(entry => names.has(entry.name)).map(entry => ({
      name: entry.name,
      role: entry.role,
      profile: JSON.stringify(entry, null, 1),
    }))
    const preflightBlueprint: BlueprintForPreflight = {
      chapterNumber: blueprint.chapterNumber, title: blueprint.title || '', role: blueprint.role || '',
      purpose: blueprint.purpose || '', keyEvents: blueprint.keyEvents || '', characters: blueprint.characters || [],
      suspenseHook: blueprint.suspenseHook || '', costsAndTurns: blueprint.costsAndTurns || '',
      foreshadowing: blueprint.foreshadowing || '', userGuidance: blueprint.userGuidance || '', notes: blueprint.notes || '',
    }
    const prompt = buildScenePlanPrompt({
      chapterNumber: this.params.chapterNumber,
      blueprint: preflightBlueprint,
      characters,
      architecture: [core?.premise, core?.charactersArch, core?.worldbuilding, core?.synopsis].filter(Boolean).join('\n\n'),
      targetWords: this.params.targetWords,
      language,
    })
    callbacks.log(promptLanguageText(language, '正在把本章蓝图拆成场景卡...', 'Building scene cards from the chapter blueprint...'))
    const completion = await this.callLLMResult(
      prompt,
      promptLanguageText(language, '你是一位场景结构编辑。只把既有蓝图拆成可执行场景，不发明新剧情。', 'You are a scene-structure editor. Split the existing blueprint into actionable scenes without inventing plot.'),
      callbacks,
      { responseFormat: { type: 'json_object' }, purpose: 'generate-scene-plan', reasoningStage: 'planning', writingSkillStage: 'planning' },
      context,
    )
    const scenes = parseScenePlanResponse(completion.content)
    const saved = await ipc.invokeWithProjectSession(projectSession, 'db:writing-intelligence-scenes-save', this.params.chapterNumber, scenes, projectSession.projectPath)
    callbacks.log(promptLanguageText(language, `已生成 ${saved.length} 张场景卡。`, `${saved.length} scene cards generated.`))
    return saved
  }
}