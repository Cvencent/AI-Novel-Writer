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
    const panel = await this.parseWithOneRepair(completion, prompt, callbacks, context, language)
    const saved = await ipc.invokeWithProjectSession(session, 'db:writing-intelligence-quality-save', {
      draftId: this.params.draftId, chapterNumber: this.params.chapterNumber, contentHash, panel,
    }, session.projectPath)
    callbacks.log(promptLanguageText(language, `编辑部评分 ${saved.weightedScore.toFixed(1)}，阻断问题 ${saved.blockingCount} 条。`, `Editorial score ${saved.weightedScore.toFixed(1)} with ${saved.blockingCount} blocking findings.`))
    return saved
  }

  /**
   * 结构不合法时**再要一次**（issue #245 现场）。
   *
   * 现场：运行侧页直接显示 `SyntaxError: Expected ':' after property name in JSON at
   * position 1102`。真库复现后确认是模型漏写键名（把 `"role": "continuity",` 写成
   * `"continuity",`）——一次采样质量问题，不是正文或设定写错。
   *
   * 这种情况下重发同一个提示词通常能换回一份合法结构（模型采样有随机性），
   * 而失败成本只是一次调用；不重试则整份五角色评审作废、作者白等 16 秒。
   * **只重试一次**：连续两次坏结构说明这条通道对该模型不稳，再多试只是让作者干等。
   *
   * ⚠️ 只对**结构**错误重试，不对内容合同错误重试（评分越界、角色重复等是模型判断
   * 的结果问题，重发同一个请求只会再撞一次）。
   */
  private async parseWithOneRepair(
    completion: { content: string },
    prompt: string,
    callbacks: CommandExecuteParams['callbacks'],
    context: CommandExecuteParams['context'],
    language: ReturnType<typeof workflowWritingLanguage>,
  ) {
    try {
      return parseEditorialPanelResponse(completion.content)
    } catch (error) {
      if (!isMalformedStructureError(error)) throw error
      callbacks.log(promptLanguageText(language,
        '编辑部返回的结构不完整（模型漏写字段），正在重新请求一次…',
        'The panel returned malformed structure (a missing field); requesting once more…'))
      const retry = await this.callLLMResult(
        prompt,
        promptLanguageText(language, '你是五人编辑部。所有判断必须可追溯到正文证据；不要把风格偏好冒充硬错误。', 'You are a five-person editorial panel. Every judgment must trace to manuscript evidence; never disguise style preferences as hard errors.'),
        callbacks,
        { responseFormat: { type: 'json_object' }, purpose: 'editorial-panel-review', reasoningStage: 'review', writingSkillStage: 'review' },
        context,
      )
      return parseEditorialPanelResponse(retry.content)
    }
  }
}

/**
 * 是不是「JSON 结构本身坏了」（只有这一类值得重发）。
 *
 * 导出是为了让测试能钉住判据：**只**重试结构错误，不重试内容合同错误
 * （评分越界、角色重复等是模型判断的结果问题，重发只会再撞一次）。
 */
export function isMalformedStructureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return message.startsWith('WRITING_INTELLIGENCE_JSON_INVALID')
}