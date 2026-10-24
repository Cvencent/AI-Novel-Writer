import { useLocaleStore } from '../../stores/locale-store'
import type { WorkflowDefinition, WorkflowContext, StepCallbacks } from '../../stores/workflow-store'
import { workflowResourceKey } from '../../stores/workflow-store'
import { useProjectStore } from '../../stores/project-store'
import { projectSessionContextFromProject, sameProjectSessionContext, sameProjectPathKey } from '../../shared/project-session-context'
import { writingLanguageText } from '../../shared/writing-language'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { ArchitectureProjectSnapshot } from './commands/architecture.command'

export interface ArcOutlineWorkflowParams {
  projectPath: string
  projectSession: ProjectSessionContext
  targetUnits?: number
  /** 'next' = 生成下一段；'reverse' = 从现有细纲反推全部粗纲；'revise' = 按作者方向重写某段。 */
  mode: 'next' | 'reverse' | 'revise' | 'review'
  /** mode='review' 时要检查的粗纲段（空 = 全部）。 */
  selectedArcIndexes?: readonly number[]
  /** mode='revise' 时目标段与作者方向。 */
  revise?: { arcIndex: number; expectedRevision: number; direction: string }
}

/**
 * 粗纲工作流。
 *
 * - mode='next'：生成「下一段」粗纲（按已有覆盖位置续接）。
 * - mode='reverse'：已有细纲时反推粗纲分段，供作者逐段检查修改。
 *
 * 每一步都复用 GenerateArcOutlineCommand / ReverseArcOutlineCommand，
 * 由命令自己读写 arc_outlines 表并做校验闸门。
 */
export function createArcOutlineWorkflow(
  params: ArcOutlineWorkflowParams,
  uiLocale: 'zh-CN' | 'en-US' = useLocaleStore.getState().locale,
): WorkflowDefinition {
  const text = (zh: string, en: string) => writingLanguageText(uiLocale, zh, en)
  const project = useProjectStore.getState().currentProject
  const currentProjectSession = projectSessionContextFromProject(project)
  if (
    !project
    || !currentProjectSession
    || !sameProjectPathKey(project.path, params.projectPath)
    || !sameProjectSessionContext(params.projectSession, currentProjectSession)
  ) {
    throw new Error(text('当前项目已切换，无法启动粗纲生成', 'The project changed, so arc-outline generation cannot start.'))
  }

  const projectSession = Object.freeze({ ...params.projectSession })
  const snapshot: ArchitectureProjectSnapshot = Object.freeze({
    targetUnits: params.targetUnits,
    expectedProjectPath: params.projectPath,
    novelConfig: Object.freeze({ ...project.novelConfig }),
  })

  const step = params.mode === 'review'
    ? {
      name: text('AI 检查粗纲', 'AI review arc outline'),
      key: 'arc-review',
      description: text('把选定粗纲段交给模型检查，返回可执行的修改建议', 'Hand the selected arc segments to the model for actionable suggestions'),
      executor: async (_step: unknown, context: WorkflowContext, callbacks: StepCallbacks) => {
        const { ReviewArcOutlineCommand } = await import('./commands/arc-outline.command')
        return new ReviewArcOutlineCommand(params.selectedArcIndexes ?? [], snapshot).execute({ step: _step, context, callbacks })
      },
    }
    : params.mode === 'revise'
    ? {
      name: text('按新方向重写粗纲段', 'Rewrite arc segment'),
      key: 'arc-revise',
      description: text('按作者说明的方向重写这一段，后续段标记待重生成', 'Rewrite this segment along the author direction and mark later segments for regeneration'),
      executor: async (_step: unknown, context: WorkflowContext, callbacks: StepCallbacks) => {
        if (!params.revise) throw new Error('ARC_OUTLINE_REVISE_INPUT_MISSING')
        const { RegenerateArcOutlineSegmentCommand } = await import('./commands/arc-outline.command')
        return new RegenerateArcOutlineSegmentCommand(snapshot, params.revise).execute({ step: _step, context, callbacks })
      },
    }
    : params.mode === 'reverse'
    ? {
      name: text('反推粗纲', 'Derive arc outline'),
      key: 'arc-reverse',
      description: text('把已有细纲归纳成若干粗纲段，逐段供你确认', 'Condense the existing chapter outline into arc segments for your review'),
      executor: async (_step: unknown, context: WorkflowContext, callbacks: StepCallbacks) => {
        const { ReverseArcOutlineCommand } = await import('./commands/arc-outline.command')
        return new ReverseArcOutlineCommand(snapshot).execute({ step: _step, context, callbacks })
      },
    }
    : {
      name: text('生成粗纲', 'Generate arc outline'),
      key: 'arc-next',
      description: text('生成下一段粗纲（不含人名，只管方向）', 'Generate the next arc segment (no character names, direction only)'),
      executor: async (_step: unknown, context: WorkflowContext, callbacks: StepCallbacks) => {
        const { GenerateArcOutlineCommand } = await import('./commands/arc-outline.command')
        return new GenerateArcOutlineCommand(snapshot).execute({ step: _step, context, callbacks })
      },
    }

  return {
    type: 'architecture_generation',
    title: params.mode === 'review'
      ? text('AI 检查粗纲', 'AI review arc outline')
      : params.mode === 'reverse'
      ? text('反推粗纲', 'Derive arc outline')
      : params.mode === 'revise'
        ? text('重写粗纲段', 'Rewrite arc segment')
        : text('生成粗纲', 'Generate arc outline'),
    projectPath: params.projectPath,
    projectSession,
    uiLocale,
    resourceKeys: [workflowResourceKey('architecture')],
    readResourceKeys: [workflowResourceKey('novel-config')],
    steps: [step],
    onComplete: {
      mode: 'silent',
      message: params.mode === 'review'
        ? text('粗纲检查已完成，请查看建议', 'Arc review finished. Review the suggestions.')
        : params.mode === 'reverse'
        ? text('粗纲已反推完成，请逐段检查修改', 'Arc outline derived. Review and adjust each segment.')
        : params.mode === 'revise'
          ? text('粗纲段已按新方向重写，请确认', 'Arc segment rewritten along the new direction; review and confirm.')
          : text('粗纲已生成', 'Arc outline generated'),
    },
  }
}
