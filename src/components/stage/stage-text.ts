import type { ResourcePage, WorkStage } from '../../stores/navigation/navigation-intents'

export const STAGE_NAMES: Record<WorkStage, [string, string]> = {
  setup: ['设定', 'Setup'],
  architecture: ['架构', 'Architecture'],
  blueprint: ['蓝图', 'Blueprint'],
  manuscript: ['正文', 'Manuscript'],
}

export const RESOURCE_NAMES: Record<ResourcePage, [string, string]> = {
  plot: ['剧情与伏笔', 'Plot & threads'],
  knowledge: ['知识库', 'Knowledge base'],
  history: ['版本历史', 'Version history'],
}
