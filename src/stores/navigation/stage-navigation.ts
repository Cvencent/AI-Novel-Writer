import type { DraftMeta } from '../../services/draft-index'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { canonicalResourceUri } from '../../shared/project-paths'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../shared/project-session-context'
import { readDraftBody, useDraftStore } from '../draft-store'
import { useEditorStore } from '../editor-store'
import { useLayoutStore } from '../layout-store'
import { useLocaleStore } from '../locale-store'
import { openBuiltinEditor } from '../open-builtin-editor'
import { useProjectStore } from '../project-store'
import type { NavigationIntent } from './navigation-intents'
import { openPageTab } from './page-tabs'
import { deriveChapters, focusChapter } from './stage-progress'
import { useStageStore } from './stage-store'

type Text = (zh: string, en: string) => string

export function chapterLabel(chapterNumber: number, text: Text): string {
  return text(`第 ${chapterNumber} 章`, `Chapter ${chapterNumber}`)
}

export function chapterTabName(chapterNumber: number, title: string, text: Text): string {
  const label = chapterLabel(chapterNumber, text)
  return title ? `${label} · ${title}` : label
}

/** 回到作品：离开书房、退出沉浸、收起搜索。 */
function enterWork(): void {
  useStageStore.setState({ focus: false, palette: null })
  if (useLayoutStore.getState().sidebarView === 'home') useLayoutStore.setState({ sidebarView: 'project', activeRailItem: 'project' })
}

function currentSession(): ProjectSessionContext | null {
  return projectSessionContextFromProject(useProjectStore.getState().currentProject)
}

async function chapterDrafts(chapterNumber: number, session: ProjectSessionContext): Promise<readonly DraftMeta[]> {
  const loaded = useDraftStore.getState()
  if (!sameProjectSessionContext(loaded.dataProjectSession, session) || !loaded.draftsByChapter[chapterNumber]) {
    await loaded.loadChapterDrafts(chapterNumber, session.projectPath, session)
  }
  return useDraftStore.getState().draftsByChapter[chapterNumber] ?? []
}

/**
 * 打开一章：已有这一稿的标签就直接切过去；否则读出正文开新标签，与项目树打开草稿走同一条读取路径。
 * 待写的章还没有正文，落到章节蓝图并选中这一章，那里有「写作此章」。
 */
export async function openChapter(chapterNumber: number): Promise<void> {
  const session = currentSession()
  if (!session) return
  const text = useLocaleStore.getState().text
  const drafts = await chapterDrafts(chapterNumber, session)
  if (!sameProjectSessionContext(session, currentSession())) return
  const work = useStageStore.getState().work
  const [row] = deriveChapters({
    blueprints: (work?.projectKey === session.projectPath ? work.blueprints : []).filter(blueprint => blueprint.chapterNumber === chapterNumber),
    drafts: { [chapterNumber]: drafts },
    runningChapters: new Set(),
  })
  const draft = row?.draft
  if (!draft) {
    openBuiltinEditor('chapter-card-editor', text('章节蓝图', 'Chapter blueprint'), 'chapter-card', undefined, chapterNumber)
    return
  }
  const filePath = canonicalResourceUri(draft.filePath) ?? draft.filePath
  const editor = useEditorStore.getState()
  const open = editor.tabs.find(tab => tab.type === 'chapter' && tab.projectKey === session.projectPath && tab.filePath === filePath)
  if (open) {
    editor.setActiveTab(open.id)
    return
  }
  const content = await readDraftBody(filePath, session.projectPath, session)
  if (!sameProjectSessionContext(session, currentSession())) return
  useEditorStore.getState().openFile({
    id: filePath,
    name: chapterTabName(chapterNumber, row.title, text),
    type: 'chapter',
    filePath,
    content,
    savedContent: content,
    draftId: draft.id,
    chapterNumber,
    draftStatus: draft.status,
    projectKey: session.projectPath,
    projectSessionLease: session.leaseId,
  })
}

function openKnowledge(): void {
  const projectKey = useProjectStore.getState().currentProject?.path
  if (!projectKey) return
  const text = useLocaleStore.getState().text
  useEditorStore.getState().openFile({ id: 'knowledge-base', name: text('知识库', 'Knowledge base'), type: 'knowledge', projectKey })
}

/** 正文阶段本身没有页面，落到当前该写的那一章；还没有任何章时先去蓝图。 */
async function openManuscript(): Promise<void> {
  const session = currentSession()
  const work = useStageStore.getState().work
  if (!session || work?.projectKey !== session.projectPath) {
    openPageTab('blueprint')
    return
  }
  const drafts = useDraftStore.getState()
  const target = focusChapter(deriveChapters({
    blueprints: work.blueprints,
    drafts: sameProjectSessionContext(drafts.dataProjectSession, session) ? drafts.draftsByChapter : {},
    runningChapters: new Set(),
  }))
  if (target) await openChapter(target.number)
  else openPageTab('blueprint')
}

/** 新外壳下各意图的落点。设置与写作此章仍由旧对话框承接，RD-5、RD-7 换成新页面。 */
export function stageNavigate(intent: NavigationIntent): void {
  if (intent.kind === 'settings') {
    useLayoutStore.setState({ settingsOpen: true, settingsSection: intent.section })
    return
  }
  if (intent.kind === 'chapter' && intent.write) {
    useLayoutStore.setState({ chapterCreationOpen: true, chapterCreationPrefill: { ...intent.write, chapterNumber: intent.chapterNumber } })
    return
  }
  enterWork()
  switch (intent.kind) {
    case 'stage':
      if (!intent.stage) useStageStore.setState({ sheet: null })
      else if (intent.stage === 'manuscript') void openManuscript()
      else openPageTab(intent.stage)
      return
    case 'resource':
      if (intent.page === 'knowledge') openKnowledge()
      else openPageTab(intent.page)
      return
    case 'run':
      useStageStore.setState({ sheet: { kind: 'run', facet: intent.facet } })
      // 运行侧页在 RD-4 之前沿用旧的 AI 输出与任务面板，它们读这几个布局字段。
      useLayoutStore.setState(intent.facet === 'output'
        ? { rightView: 'ai-output', rightPanelRunId: intent.runId ?? null }
        : { bottomTab: intent.facet, bottomPanelOpen: true })
      return
    case 'chapter':
      void openChapter(intent.chapterNumber)
  }
}
