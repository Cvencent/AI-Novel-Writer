import type { EditorTab } from '../../stores/editor-store'
import type { ResourcePage, WorkStage } from '../../stores/navigation/navigation-intents'

type Text = (zh: string, en: string) => string

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

/** 阶段与资料页的标签在新外壳里用流程脊上的名字，同一个页面只有一个名字；旧外壳打开时存的标签名不变。 */
const PAGE_TAB_NAMES: Partial<Record<EditorTab['type'], [string, string]>> = {
  config: STAGE_NAMES.setup,
  'world-building': STAGE_NAMES.architecture,
  'chapter-card': STAGE_NAMES.blueprint,
  'narrative-thread': RESOURCE_NAMES.plot,
  knowledge: RESOURCE_NAMES.knowledge,
  'version-history': RESOURCE_NAMES.history,
}

/** 标签在新外壳里显示的名字。正文、审稿报告、角色与恢复草稿等标签沿用各自的名字。 */
export function stageTabName(tab: Pick<EditorTab, 'type' | 'name' | 'planningRecovery'>, text: Text): string {
  const name = tab.planningRecovery ? undefined : PAGE_TAB_NAMES[tab.type]
  return name ? text(...name) : tab.name
}
