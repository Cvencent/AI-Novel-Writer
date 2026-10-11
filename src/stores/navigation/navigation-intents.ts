import type { ChapterCreationPrefill, SettingsSection } from '../layout-store'

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
  | { kind: 'chapter'; chapterNumber: number; write?: NonNullable<ChapterCreationPrefill> }
