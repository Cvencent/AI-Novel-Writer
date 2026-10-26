import { useLocaleStore } from '../../stores/locale-store'
import type { WorkflowDefinition, WorkflowContext, StepCallbacks } from '../../stores/workflow-store'
import { workflowResourceKey } from '../../stores/workflow-store'
import { useProjectStore } from '../../stores/project-store'
import { projectSessionContextFromProject, sameProjectPathKey, sameProjectSessionContext } from '../../shared/project-session-context'
import { writingLanguageText } from '../../shared/writing-language'
import type { ProjectSessionContext } from '../../shared/ipc-channels'

export interface RosterSyncWorkflowParams {
  projectPath: string
  projectSession: ProjectSessionContext
  /** 修稿合并后的正文（调用方冻结）。 */
  mergedProse: string
}

/** 修稿合并后的人物关系同步工作流：任务化，可切页，右侧运行侧页看进度。 */
export function createRosterSyncWorkflow(
  params: RosterSyncWorkflowParams,
  uiLocale: 'zh-CN' | 'en-US' = useLocaleStore.getState().locale,
): WorkflowDefinition {
  const text = (zh: string, en: string) => writingLanguageText(uiLocale, zh, en)
  const project = useProjectStore.getState().currentProject
  const currentProjectSession = projectSessionContextFromProject(project)
  if (!project || !currentProjectSession || !sameProjectPathKey(project.path, params.projectPath)
    || !sameProjectSessionContext(params.projectSession, currentProjectSession)) {
    throw new Error(text('当前项目已切换，无法启动人物关系同步', 'The project changed; the roster sync cannot start.'))
  }
  const projectSession = Object.freeze({ ...params.projectSession })
  return {
    type: 'architecture_generation',
    title: text('按修稿同步人物关系', 'Sync character relationships from the revision'),
    projectPath: params.projectPath,
    projectSession,
    uiLocale,
    resourceKeys: [],
    readResourceKeys: [workflowResourceKey('architecture')],
    steps: [{
      name: text('对比修稿并更新关系', 'Compare the revision and update relationships'),
      description: text('修稿后正文是事实来源；只更新真正变化的关系', 'The merged prose is the source of truth; only changed relationships are updated'),
      executor: async (_step: unknown, context: WorkflowContext, callbacks: StepCallbacks) => {
        const { RosterSyncCommand } = await import('./commands/roster-sync.command')
        return new RosterSyncCommand(params.mergedProse).execute({ step: _step, context, callbacks })
      },
    }],
    onComplete: { mode: 'silent', message: text('人物关系已按修稿同步', 'Character relationships synced from the revision') },
  }
}
