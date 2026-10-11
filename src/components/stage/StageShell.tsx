import { useCallback, useEffect, useMemo, useState } from 'react'
import { useProjectStore } from '../../stores/project-store'
import { useLayoutStore } from '../../stores/layout-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useEditorStore } from '../../stores/editor-store'
import { navigate } from '../../stores/navigation/navigation-intents'
import { useStageStore } from '../../stores/navigation/stage-store'
import { openBuiltinEditor } from '../../stores/open-builtin-editor'
import { chapterLabel } from '../../stores/navigation/stage-navigation'
import type { Theme } from '../../stores/theme-store'
import { ipc } from '../../services/ipc-client'
import ClearProjectDataDialog from '../dialogs/ClearProjectDataDialog'
import type { MenuGroupSpec } from '../ui/Menu'
import StagePalette from './StagePalette'
import type { PaletteItem } from './palette-filter'
import StageSpine from './StageSpine'
import StageTopBar from './StageTopBar'
import StageWorkspace from './StageWorkspace'
import { inkTheme } from './ink-theme'
import { RESOURCE_NAMES, STAGE_NAMES } from './stage-text'
import { refreshStageWork, useLandingPage, useStageView, useStageWorkRefresh, type StageView } from './use-stage-work'
import { useStageShortcuts } from './use-stage-shortcuts'
import '../../styles/paper-ink/index.css'
import './stage.css'

type Text = (zh: string, en: string) => string

const PHASE_META: Record<string, [string, string]> = {
  todo: ['待写', 'To write'], draft: ['待审稿', 'To review'], reviewed: ['待修稿', 'To revise'], revised: ['待定稿', 'To finalize'], final: ['定稿', 'Final'],
}

async function openProjectFolder(): Promise<void> {
  const folder = await ipc.invoke('dialog:select-folder', 'project-open')
  if (folder) await useProjectStore.getState().openProject(folder)
}

function crumbsFor(view: StageView, library: boolean, activeName: string | undefined, text: Text): string[] {
  if (library) return []
  const location = view.location
  if (!location) return []
  if (location.kind === 'resource') return [text('作品资料', 'Reference'), text(...RESOURCE_NAMES[location.page])]
  const stage = text(...STAGE_NAMES[location.stage])
  if (location.stage === 'manuscript' && location.chapter !== undefined) return [stage, chapterLabel(location.chapter, text)]
  if (location.stage === 'architecture' && activeName) return [stage, activeName]
  return [stage]
}

export default function StageShell({ theme }: { theme: Theme }) {
  const text = useLocaleStore(s => s.text)
  const hasProject = useProjectStore(s => Boolean(s.currentProject))
  const home = useLayoutStore(s => s.sidebarView === 'home')
  const library = !hasProject || home
  const focus = useStageStore(s => s.focus) && !library
  const palette = useStageStore(s => s.palette)
  const activeName = useEditorStore(s => s.tabs.find(tab => tab.id === s.activeTabId)?.name)
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const [clearOpen, setClearOpen] = useState(false)
  const view = useStageView()

  useStageWorkRefresh()
  useLandingPage(view)
  useStageShortcuts({ library, focus })

  useEffect(() => {
    if (library && useStageStore.getState().focus) useStageStore.setState({ focus: false })
  }, [library])

  const toggleFocus = useCallback(() => useStageStore.setState(state => ({ focus: !state.focus, palette: null })), [])

  const workMenu = useMemo<MenuGroupSpec[]>(() => [
    { id: 'work', items: [
      { id: 'library', label: text('回到书房', 'Back to library'), onSelect: () => useLayoutStore.getState().setSidebarView('home') },
      { id: 'open', label: text('打开其他作品…', 'Open another book…'), onSelect: () => void openProjectFolder() },
      { id: 'new', label: text('新建作品…', 'New book…'), onSelect: () => useLayoutStore.getState().openNewProject() },
    ] },
    { id: 'files', items: [
      { id: 'export', label: text('导出…', 'Export…'), onSelect: () => useLayoutStore.getState().openExport() },
      { id: 'backup', label: text('项目备份', 'Project backup'), onSelect: () => navigate({ kind: 'settings', section: 'backup' }) },
      { id: 'import', label: text('小说拆解与仿写…', 'Novel breakdown & imitation…'), onSelect: () => useLayoutStore.getState().openImportNovel() },
    ] },
    { id: 'danger', tone: 'danger', items: [
      { id: 'clear', label: text('清除生成内容…', 'Clear generated content…'), onSelect: () => setClearOpen(true) },
    ] },
  ], [text])

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const go: PaletteItem[] = view.stages.map(status => ({
      id: `stage-${status.stage}`, group: 'stage', label: text(...STAGE_NAMES[status.stage]),
      run: () => navigate({ kind: 'stage', stage: status.stage }),
    }))
    const chapters: PaletteItem[] = view.chapters.map(row => ({
      id: `chapter-${row.number}`, group: 'chapter', chapter: row.number,
      label: row.title ? `${chapterLabel(row.number, text)} · ${row.title}` : chapterLabel(row.number, text),
      meta: row.running ? text('生成中', 'Writing') : text(...PHASE_META[row.phase]),
      run: () => navigate({ kind: 'chapter', chapterNumber: row.number }),
    }))
    const references: PaletteItem[] = hasProject && !library ? [
      ...(Object.keys(RESOURCE_NAMES) as (keyof typeof RESOURCE_NAMES)[]).map(page => ({
        id: `resource-${page}`, group: 'reference' as const, label: text(...RESOURCE_NAMES[page]),
        run: () => navigate({ kind: 'resource', page }),
      })),
      { id: 'characters', group: 'reference', label: text('角色', 'Characters'), keywords: 'roster 名单',
        run: () => openBuiltinEditor('character-editor', text('角色', 'Characters'), 'character') },
    ] : []
    const actions: PaletteItem[] = [
      { id: 'new', group: 'action', label: text('新建作品', 'New book'), run: () => useLayoutStore.getState().openNewProject() },
      { id: 'open', group: 'action', label: text('打开作品', 'Open a book'), run: () => void openProjectFolder() },
      { id: 'import', group: 'action', label: text('小说拆解与仿写', 'Novel breakdown & imitation'), run: () => useLayoutStore.getState().openImportNovel() },
      ...(hasProject ? [
        { id: 'library', group: 'action' as const, label: text('回到书房', 'Back to library'), run: () => useLayoutStore.getState().setSidebarView('home') },
        { id: 'run', group: 'action' as const, label: text('运行侧页', 'Run sheet'), keywords: 'AI 输出 任务 日志', run: () => navigate({ kind: 'run', facet: 'output' }) },
        { id: 'export', group: 'action' as const, label: text('导出', 'Export'), run: () => useLayoutStore.getState().openExport() },
        { id: 'backup', group: 'action' as const, label: text('项目备份', 'Project backup'), run: () => navigate({ kind: 'settings', section: 'backup' }) },
      ] : []),
      ...(hasProject && !library ? [
        { id: 'focus', group: 'action' as const, label: text('沉浸写作', 'Focus mode'), run: toggleFocus },
      ] : []),
      { id: 'settings', group: 'action', label: text('设置', 'Settings'), run: () => navigate({ kind: 'settings', section: 'llm' }) },
    ]
    return [...go, ...chapters, ...references, ...actions]
  }, [view.stages, view.chapters, hasProject, library, text, toggleFocus])

  const crumbs = crumbsFor(view, library, activeName, text)
  const focusChapter = view.location?.kind === 'stage' ? view.location.chapter : undefined
  const focusRow = view.chapters.find(row => row.number === focusChapter)
  const focusTitle = focusRow ? { chapter: focusRow.number, title: focusRow.title || chapterLabel(focusRow.number, text) } : { title: activeName ?? '' }

  return (
    <div
      ref={setRoot}
      className="paper-ink stage-shell"
      data-theme={inkTheme(theme)}
      data-shell-presentation="stage"
      data-focus={focus || undefined}
      data-library={library || undefined}
    >
      <StageTopBar
        crumbs={crumbs}
        library={library}
        focus={focus}
        focusTitle={focusTitle}
        workMenu={workMenu}
        onToggleFocus={toggleFocus}
      />
      <div className="stage-frame">
        {!library && !focus && (
          <StageSpine
            stages={view.stages}
            chapters={view.chapters}
            location={view.location}
            onStage={stage => navigate({ kind: 'stage', stage })}
            onChapter={chapterNumber => navigate({ kind: 'chapter', chapterNumber })}
            onResource={page => navigate({ kind: 'resource', page })}
            onSettings={() => navigate({ kind: 'settings', section: 'llm' })}
          />
        )}
        <StageWorkspace library={library} focus={focus} />
      </div>
      <StagePalette mode={palette} items={paletteItems} container={root} onClose={() => useStageStore.setState({ palette: null })} />
      <ClearProjectDataDialog open={clearOpen} onClose={() => setClearOpen(false)} onCleared={() => refreshStageWork(text)} />
    </div>
  )
}
