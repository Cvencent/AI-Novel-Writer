import { useLocaleStore } from '../../stores/locale-store'
import type { WorkflowDefinition, WorkflowContext, StepCallbacks } from '../../stores/workflow-store'
import { workflowResourceKey } from '../../stores/workflow-store'
import { useProjectStore } from '../../stores/project-store'
import { projectSessionContextFromProject, sameProjectSessionContext, sameProjectPathKey } from '../../shared/project-session-context'
import { writingLanguageText } from '../../shared/writing-language'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { ArchitectureProjectSnapshot } from './commands/architecture.command'

export interface BlueprintReviewWorkflowParams {
  projectPath: string
  projectSession: ProjectSessionContext
  range: { from: number; to: number }
}

/**
 * 蓝图 AI 检查工作流。
 *
 * 蓝图不调用工具：它只是把细纲整理成结构化字段（角色/关系在细纲阶段已经定好），
 * 所以检查只需要蓝图行 + 细纲原文，不需要角色 / 知识库工具轮。
 */
export function createBlueprintReviewWorkflow(
  params: BlueprintReviewWorkflowParams,
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
    throw new Error(text('当前项目已切换，无法启动蓝图检查', 'The project changed, so the blueprint review cannot start.'))
  }

  const projectSession = Object.freeze({ ...params.projectSession })
  const snapshot: ArchitectureProjectSnapshot = Object.freeze({
    expectedProjectPath: params.projectPath,
    novelConfig: Object.freeze({ ...project.novelConfig }),
  })

  return {
    type: 'architecture_generation',
    title: text('AI 检查蓝图', 'AI review blueprints'),
    projectPath: params.projectPath,
    projectSession,
    uiLocale,
    resourceKeys: [],
    readResourceKeys: [workflowResourceKey('blueprints'), workflowResourceKey('architecture'), workflowResourceKey('novel-config')],
    steps: [{
      name: text('检查蓝图', 'Review blueprints'),
      description: text('对照细纲检查蓝图字段是否齐全、是否与细纲一致', 'Check blueprint fields against the outline they were derived from'),
      executor: async (_step: unknown, context: WorkflowContext, callbacks: StepCallbacks) => {
        const { ReviewBlueprintsCommand } = await import('./commands/blueprint-review.command')
        return new ReviewBlueprintsCommand(params.range, snapshot).execute({ step: _step, context, callbacks })
      },
    }],
    onComplete: { mode: 'silent', message: text('蓝图检查已完成，请查看建议', 'Blueprint review finished. Review the suggestions.') },
  }
}
