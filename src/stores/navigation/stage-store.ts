import { create } from 'zustand'
import type { ProjectSessionContext } from '../../shared/ipc-channels'

/** 运行侧页的分页：进行中（步骤、实时输出、等确认、可恢复）、历史、诊断（宽版：日志与模型调用）。 */
export type RunSheetTab = 'active' | 'history' | 'diagnostics'

/**
 * 内容区右侧的按需侧页。目前只有运行侧页；审稿、版本对比等侧页由后续 PR 加入。
 * runId 是要看的那次运行：还在运行就在「进行中」里定位，已结束就在「历史」里展开。
 */
export type StageSheet = { kind: 'run'; tab: RunSheetTab; runId?: string }

/** 命令面板：commands 是搜索与跳转（⌘K / Ctrl K），chapters 只查章节（⌘P / Ctrl P）。 */
export type StagePalette = 'commands' | 'chapters'

/** 流程脊从项目数据派生状态时用到、而 project-store 与 draft-store 里没有的两项。 */
export interface StageWork {
  /** 这份数据属于哪次打开；同一路径重新打开是新的会话，旧数据不能当新的用。 */
  session: ProjectSessionContext
  /** 故事前提、角色名单、世界观、情节大纲是否已有内容（与旧外壳侧栏同一判定）。 */
  architecture: Readonly<Record<string, boolean>>
  blueprints: readonly { chapterNumber: number; title: string }[]
}

interface StageState {
  sheet: StageSheet | null
  /** 沉浸写作：只留正文与章节动作条。与旧外壳的 immersive 分开保存。 */
  focus: boolean
  palette: StagePalette | null
  work: StageWork | null
  /** 有未保存修改、等作者确认是否放弃的待关闭标签。 */
  closingTabId: string | null
  /** 要为这一章打开写作弹层（定稿后打开下一章等）；挂着这一章写作按钮的页面接手后清空。只属于发出时的那次打开，换作品或重新打开即清掉。 */
  writeRequest: { session: ProjectSessionContext; chapterNumber: number } | null
}

/** 新外壳自己的界面状态。书房与作品的切换沿用 layout-store 的 sidebarView === 'home'，两种外壳共用。 */
export const useStageStore = create<StageState>()(() => ({
  sheet: null,
  focus: false,
  palette: null,
  work: null,
  closingTabId: null,
  writeRequest: null,
}))
