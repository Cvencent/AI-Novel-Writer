import { openBuiltinEditor } from '../../components/panels/sidebar/sidebar-file-openers'
import { useEditorStore } from '../editor-store'
import { useLayoutStore, type ChapterWritePrefill, type SettingsSection } from '../layout-store'
import { useLocaleStore } from '../locale-store'
import { useProjectStore } from '../project-store'
import { legacyLayoutPatch } from './legacy-layout'

/** 作品流程脊的四个阶段，顺序即创作顺序。 */
export type WorkStage = 'setup' | 'architecture' | 'blueprint' | 'manuscript'

/** 流程脊下方的作品资料页。 */
export type ResourcePage = 'plot' | 'knowledge' | 'history'

/** 运行侧页的分页：实时输出、任务进度、诊断里的日志与模型调用。 */
export type RunPaneFacet = 'output' | 'tasks' | 'log' | 'models'

/**
 * 跨层导航意图。调用方只描述要去哪里，由当前外壳决定落到哪些界面状态。
 * 切换外壳只改 `navigate` 的实现，不改调用方。
 */
export type NavigationIntent =
  /** 不带 stage 表示回到作品的流程脊，不切换内容页。 */
  | { kind: 'stage'; stage?: WorkStage }
  | { kind: 'resource'; page: ResourcePage }
  | { kind: 'run'; facet: RunPaneFacet; runId?: string }
  | { kind: 'settings'; section: SettingsSection }
  /** 带 write 时同时展开写作此章的参数，即旧外壳的章节创作弹窗。 */
  | { kind: 'chapter'; chapterNumber: number; write?: ChapterWritePrefill }

const LEGACY_PAGE_TABS: Partial<Record<WorkStage | ResourcePage, (text: (zh: string, en: string) => string) => void>> = {
  architecture: text => openBuiltinEditor('world-building-editor', text('故事架构', 'Story architecture'), 'world-building'),
  blueprint: text => openBuiltinEditor('chapter-card-editor', text('章节蓝图', 'Chapter blueprint'), 'chapter-card'),
  plot: text => openBuiltinEditor('narrative-thread-editor', text('剧情树与叙事线索', 'Plot tree & narrative threads'), 'narrative-thread', 'plot-tree'),
  history: text => openBuiltinEditor('version-history', text('版本历史', 'Version history'), 'version-history'),
  setup: text => {
    const projectKey = useProjectStore.getState().currentProject?.path
    if (projectKey) useEditorStore.getState().openFile({ id: 'config', name: text('小说配置', 'Novel configuration'), type: 'config', projectKey })
  },
}

/** 唯一的跨层导航入口。 */
export function navigate(intent: NavigationIntent): void {
  useLayoutStore.setState(state => legacyLayoutPatch(state, intent))
  const page = intent.kind === 'stage' ? intent.stage : intent.kind === 'resource' ? intent.page : undefined
  if (page) LEGACY_PAGE_TABS[page]?.(useLocaleStore.getState().text)
}
