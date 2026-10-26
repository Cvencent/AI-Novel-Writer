import { useLocaleStore } from '../../stores/locale-store'
import type { WorkflowDefinition, WorkflowContext, StepCallbacks } from '../../stores/workflow-store'
import { workflowResourceKey } from '../../stores/workflow-store'
import { useProjectStore } from '../../stores/project-store'
import { projectSessionContextFromProject, sameProjectPathKey, sameProjectSessionContext } from '../../shared/project-session-context'
import { writingLanguageText } from '../../shared/writing-language'
import type { ProjectSessionContext } from '../../shared/ipc-channels'

export interface FinalizeSyncWorkflowParams {
  projectPath: string
  projectSession: ProjectSessionContext
  chapterNumber: number
  /** 定稿正文（调用方冻结，避免运行中正文变化）。 */
  finalizedContent: string
}

/** 定稿正文 → 细纲/蓝图 校正工作流：任务化，可切页，右侧运行侧页看进度。 */
export function createFinalizeSyncWorkflow(
  params: FinalizeSyncWorkflowParams,
  uiLocale: 'zh-CN' | 'en-US' = useLocaleStore.getState().locale,
): WorkflowDefinition {
  const text = (zh: string, en: string) => writingLanguageText(uiLocale, zh, en)
  const project = useProjectStore.getState().currentProject
  const currentProjectSession = projectSessionContextFromProject(project)
  if (!project || !currentProjectSession || !sameProjectPathKey(project.path, params.projectPath)
    || !sameProjectSessionContext(params.projectSession, currentProjectSession)) {
    throw new Error(text('当前项目已切换，无法启动校正', 'The project changed; the alignment cannot start.'))
  }
  const projectSession = Object.freeze({ ...params.projectSession })
  return {
    type: 'architecture_generation',
    title: text(`按定稿正文校正第 ${params.chapterNumber} 章`, `Align chapter ${params.chapterNumber} with the finalized prose`),
    projectPath: params.projectPath,
    projectSession,
    uiLocale,
    resourceKeys: [workflowResourceKey('novel-config')],
    readResourceKeys: [workflowResourceKey('architecture')],
    steps: [{
      name: text('对比并修正细纲与蓝图', 'Compare and fix outline and blueprint'),
      description: text('定稿正文是权威；AI 只修真实且实质的偏差', 'The finalized prose is authoritative; the model fixes only real, material deviations'),
      executor: async (_step: unknown, context: WorkflowContext, callbacks: StepCallbacks) => {
        const { FinalizeSyncCommand } = await import('./commands/finalize-sync.command')
        return new FinalizeSyncCommand(params.chapterNumber, params.finalizedContent).execute({ step: _step, context, callbacks })
      },
    }],
    onComplete: { mode: 'silent', message: text('细纲与蓝图已按定稿正文校正', 'Outline and blueprint aligned with the finalized prose') },
  }
}
