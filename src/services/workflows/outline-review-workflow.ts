import { useLocaleStore } from '../../stores/locale-store'
import type { WorkflowDefinition, WorkflowContext, StepCallbacks } from '../../stores/workflow-store'
import { workflowResourceKey } from '../../stores/workflow-store'
import { useProjectStore } from '../../stores/project-store'
import { projectSessionContextFromProject, sameProjectSessionContext, sameProjectPathKey } from '../../shared/project-session-context'
import { writingLanguageText } from '../../shared/writing-language'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { ArchitectureProjectSnapshot } from './commands/architecture.command'

export interface OutlineReviewWorkflowParams {
  projectPath: string
  projectSession: ProjectSessionContext
  range: { from: number; to: number }
}

/**
 * 细纲 AI 检查工作流。
 *
 * 只读检查 + 写检查结果表；不改写细纲本身，写回由作者在建议卡片上逐条接受。
 * 因此只占用 audit 侧的资源键，不抢占细纲的写资源。
 */
export function createOutlineReviewWorkflow(
  params: OutlineReviewWorkflowParams,
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
    throw new Error(text('当前项目已切换，无法启动细纲检查', 'The project changed, so the outline review cannot start.'))
  }

  const projectSession = Object.freeze({ ...params.projectSession })
  const snapshot: ArchitectureProjectSnapshot = Object.freeze({
    expectedProjectPath: params.projectPath,
    novelConfig: Object.freeze({ ...project.novelConfig }),
  })

  return {
    type: 'architecture_generation',
    title: text('AI 检查细纲', 'AI review outline'),
    projectPath: params.projectPath,
    projectSession,
    uiLocale,
    resourceKeys: [],
    readResourceKeys: [workflowResourceKey('architecture'), workflowResourceKey('novel-config')],
    steps: [{
      name: text('检查细纲', 'Review outline'),
      description: text('把选定章节的细纲交给模型检查，返回可执行的修改建议', 'Hand the selected chapters to the model for actionable suggestions'),
      executor: async (_step: unknown, context: WorkflowContext, callbacks: StepCallbacks) => {
        const { ReviewOutlineCommand } = await import('./commands/outline-review.command')
        return new ReviewOutlineCommand(params.range, snapshot).execute({ step: _step, context, callbacks })
      },
    }],
    onComplete: { mode: 'silent', message: text('细纲检查已完成，请查看建议', 'Outline review finished. Review the suggestions.') },
  }
}
