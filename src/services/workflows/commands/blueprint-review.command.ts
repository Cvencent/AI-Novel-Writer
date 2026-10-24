import {
  BaseWorkflowCommand,
  type CommandExecuteParams,
  type WorkflowGenerationRuntimeDependencies,
} from './base-command'
import { ipc } from '../../ipc-client'
import { requireIpcSuccess } from '../../ipc-result'
import { requireWorkflowProjectSession, workflowWritingLanguage } from '../workflow-project-session'
import { hashAuthorText } from '../../../shared/source-ref'
import {
  normalizeStageReviewFindings,
  buildBlueprintReviewPrompt,
  BLUEPRINT_REVIEW_CATEGORIES,
} from '../../../shared/stage-review-contract'
import { STAGE_REVIEW_MAX_TARGETS } from '../../../shared/stage-review-types'
import { outlineBatchSliceForBlueprint } from '../../../shared/blueprint-input'
import { extractReviewJson } from './outline-review.command'
import type { ArchitectureProjectSnapshot } from './architecture.command'

const NL = String.fromCharCode(10)

/**
 * 蓝图 AI 检查。
 *
 * 蓝图不调用工具：角色与关系在细纲阶段已定，蓝图只是结构化录入。
 * 检查对照的是「派生所用的细纲原文」——因此要把对应章节的细纲切片一起喂进去。
 */
export class ReviewBlueprintsCommand extends BaseWorkflowCommand<string> {
  constructor(
    private readonly range: { from: number; to: number },
    private readonly snapshot: ArchitectureProjectSnapshot,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) { super(generationDependencies) }

  async execute(params: CommandExecuteParams): Promise<string> {
    return this.executeWithGenerationRuntime('text', params, () => this.executeWithinGeneration(params), {
      authorInputs: [{ id: 'blueprint:review-selection', text: JSON.stringify(this.range) }],
      operation: 'review-blueprints', promptKeys: ['chapter_blueprint'], skillStages: ['planning'], output: 'visible-text',
    })
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const projectSession = requireWorkflowProjectSession(context)
    const writingLanguage = workflowWritingLanguage(context)
    const { expectedProjectPath } = this.snapshot
    const all = await ipc.invokeWithProjectSession(projectSession, 'db:blueprint-get-all', expectedProjectPath).catch(() => [])
    const selected = (Array.isArray(all) ? all : [])
      .filter(blueprint => blueprint.chapterNumber >= this.range.from && blueprint.chapterNumber <= this.range.to)
      .map(blueprint => blueprint.chapterNumber)
    if (selected.length === 0) throw new Error('The selected range contains no blueprint to review.')
    if (selected.length > STAGE_REVIEW_MAX_TARGETS) throw new Error('单次检查最多 ' + STAGE_REVIEW_MAX_TARGETS + ' 章，请缩小范围后重试。')
    const chapters = (Array.isArray(all) ? all : [])
      .filter(blueprint => selected.includes(blueprint.chapterNumber))
      .map(blueprint => ({
        chapter: blueprint.chapterNumber,
        title: blueprint.title,
        role: blueprint.role,
        purpose: blueprint.purpose,
        keyEvents: blueprint.keyEvents,
        characters: Array.isArray(blueprint.characters) ? blueprint.characters : [],
        suspenseHook: blueprint.suspenseHook,
        costsAndTurns: blueprint.costsAndTurns || '',
        foreshadowing: blueprint.foreshadowing || '',
      }))
    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', expectedProjectPath).catch(() => null)
    const outlineSlices = outlineBatchSliceForBlueprint(core?.synopsis || '', this.range.from, this.range.to)

    callbacks.log('Reviewing chapter blueprints...')
    const prompt = buildBlueprintReviewPrompt({
      chapters,
      selected,
      outlineSlices,
      charactersArch: core?.charactersArch || '',
      worldbuilding: core?.worldbuilding || '',
      language: writingLanguage,
    })
    const completion = await this.callLLMResult(
      prompt,
      'You are a rigorous fiction editor. Report only real, actionable problems.',
      callbacks,
      { purpose: 'blueprint-review', reasoningStage: 'planning', writingSkillStage: 'planning' },
      context,
    )
    const payload = extractReviewJson(completion.content)
    const rawFindings = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as { findings?: unknown }).findings : payload
    const findings = normalizeStageReviewFindings(rawFindings, selected, BLUEPRINT_REVIEW_CATEGORIES)
    const runId = 'blueprint-review:' + context.runId
    const sourceHash = await hashAuthorText(chapters.map(chapter => [chapter.title, chapter.purpose, chapter.keyEvents].join(NL)).join(NL))
    const saved = await ipc.invokeWithProjectSession(projectSession, 'db:stage-review-save', {
      operationId: runId, runId, target: 'blueprint', selected, sourceHash, findings,
    }, expectedProjectPath)
    requireIpcSuccess(saved, 'Failed to save the blueprint review.')
    callbacks.log('Blueprint review finished with ' + findings.length + ' suggestion(s).')
    return runId
  }
}
