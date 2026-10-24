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
  buildOutlineReviewPrompt,
  OUTLINE_REVIEW_CATEGORIES,
} from '../../../shared/stage-review-contract'
import {
  plotOutlineChapterSpans,
  chapterOutlineArcDirective,
} from '../../../shared/plot-outline-contract'
import type { ArchitectureProjectSnapshot } from './architecture.command'

const NL = String.fromCharCode(10)

export function extractReviewJson(raw: string): unknown {
  const text = raw.trim().replace(/^`json`?/iu, '').replace(/``?/gu, '')
  try { return JSON.parse(text) } catch { void 0 }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) { try { return JSON.parse(text.slice(start, end + 1)) } catch { void 0 } }
  return null
}

/**
 * 细纲 AI 检查。
 *
 * 输入：所选章节的细纲原文 + 核心大纲 + 故事前提 + 世界观 + 所属粗纲方向。
 * 输出：按章定位、带完整替换文本的 findings，落进 stage_review 表。
 *
 * 注意 expectedText 是**整章条目的完整替换文本**——因为「接受」会整章替换，
 * 只给片段会破坏六小节结构。
 */
export class ReviewOutlineCommand extends BaseWorkflowCommand<string> {
  constructor(
    private readonly range: { from: number; to: number },
    private readonly snapshot: ArchitectureProjectSnapshot,
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) { super(generationDependencies) }

  async execute(params: CommandExecuteParams): Promise<string> {
    return this.executeWithGenerationRuntime('text', params, () => this.executeWithinGeneration(params), {
      authorInputs: [{ id: 'outline:review-selection', text: JSON.stringify(this.range) }],
      operation: 'review-outline', promptKeys: ['plot_outline'], skillStages: ['planning'], output: 'visible-text',
    })
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const projectSession = requireWorkflowProjectSession(context)
    const writingLanguage = workflowWritingLanguage(context)
    const { expectedProjectPath } = this.snapshot
    const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', expectedProjectPath)
    if (!core) throw new Error('There is no project to review.')
    const synopsis = core.synopsis || ''
    const spans = plotOutlineChapterSpans(synopsis)
    const selected = spans
      .filter(span => span.chapter >= this.range.from && span.chapter <= this.range.to)
      .map(span => span.chapter)
    if (selected.length === 0) throw new Error('The selected range contains no chapter outline to review.')
    const chapters = selected.map(chapter => {
      const span = spans.find(entry => entry.chapter === chapter)!
      const raw = synopsis.slice(span.index, span.end).trim()
      const newline = raw.indexOf(NL)
      const head = newline >= 0 ? raw.slice(0, newline) : raw
      const title = head.replace(/^#+\s*/u, '').replace(/^第\s*\d+\s*章\s*[:：]?\s*/u, '').trim() || head
      return { chapter, title, body: raw }
    })

    // 所属粗纲段：细纲必须与它所在段的走向一致，检查时要能看到。
    const listedArcs = await ipc.invokeWithProjectSession(projectSession, 'db:arc-outline-list', expectedProjectPath).catch(() => [])
    const arcs = (Array.isArray(listedArcs) ? listedArcs : []).map(arc => ({
      fromChapter: arc.fromChapter, toChapter: arc.toChapter, beat: arc.beat, title: arc.title, summary: arc.summary, status: arc.status,
    }))
    const arcDirective = arcs.length > 0 ? chapterOutlineArcDirective(arcs, this.range.from, writingLanguage) : ''

    callbacks.log('Reviewing the chapter outline...')
    const prompt = buildOutlineReviewPrompt({
      chapters,
      selected,
      coreOutline: core.coreOutline || '',
      premise: core.premise || '',
      worldbuilding: core.worldbuilding || '',
      arcDirective,
      language: writingLanguage,
    })
    const completion = await this.callLLMResult(
      prompt,
      'You are a rigorous fiction editor. Report only real, actionable problems.',
      callbacks,
      { purpose: 'outline-review', reasoningStage: 'planning', writingSkillStage: 'planning' },
      context,
    )
    const payload = extractReviewJson(completion.content)
    const rawFindings = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as { findings?: unknown }).findings : payload
    const findings = normalizeStageReviewFindings(rawFindings, selected, OUTLINE_REVIEW_CATEGORIES)
    const runId = 'outline-review:' + context.runId
    const sourceHash = await hashAuthorText(chapters.map(chapter => chapter.body).join(NL))
    const saved = await ipc.invokeWithProjectSession(projectSession, 'db:stage-review-save', {
      operationId: runId, runId, target: 'outline', selected, sourceHash, findings,
    }, expectedProjectPath)
    requireIpcSuccess(saved, 'Failed to save the outline review.')
    callbacks.log('Outline review finished with ' + findings.length + ' suggestion(s).')
    return runId
  }
}
