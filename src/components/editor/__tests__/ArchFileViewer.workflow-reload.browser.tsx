import { act } from 'react'
import { EditorView } from '@codemirror/view'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import type { ProjectData } from '../../../shared/ipc-channels'
import { globalEventBus } from '../../../shared/event-bus'
import { useEditorStore } from '../../../stores/editor-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { renderArcOutlineMarkdown } from '../../../services/resource-protocol'
import ArchFileViewer from '../ArchFileViewer'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT_PATH = 'C:\\novels\\arch-reload'
const project: ProjectData = {
  id: 'arch-reload-project',
  sessionLease: 'arch-reload-lease',
  name: 'Arc reload',
  path: PROJECT_PATH,
  novelConfig: {
    genre: '', subGenre: '', targetAudience: '', totalChapters: 16, wordsPerChapter: 2500,
    plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '', worldSetting: '',
    goldenFinger: '', protagonistProfile: '', globalGuidance: '',
  },
  characterStates: '', createdAt: '', updatedAt: '',
}

let container: HTMLDivElement
let root: Root
let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
  useProjectStore.setState({ currentProject: project, fileTree: [], loading: false })
  setActiveProjectSessionContext({ projectId: project.id, leaseId: project.sessionLease!, projectPath: PROJECT_PATH })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  vi.restoreAllMocks()
})

const arcs = [
  { arcIndex: 1, fromChapter: 1, toChapter: 8, title: '旧港钟声', beat: '起', summary: '第一段方向。', status: 'confirmed' },
  { arcIndex: 2, fromChapter: 9, toChapter: 16, title: '北堤潮位', beat: '承', summary: '第二段方向。', status: 'draft' },
]

describe('粗纲标签页的生成完成自动刷新', () => {
  it('每段生成完成后重读分段台账并追加显示新段，而不是把编辑器清空', async () => {
    invoke = vi.fn(async (channel: string) => {
      if (channel === 'db:arc-outline-list') return arcs
      if (channel === 'db:character-roster-read') return { status: 'empty', renderedMarkdown: '', legacyMarkdown: '', entries: [] }
      return { success: true }
    })
    Object.defineProperty(window, 'aiNovelAPI', {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn(), setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn(() => 0) },
    })
    // 真实应用里该 tab 由 openArchFile 注册进编辑器 store；apply 守卫会检查它。
    useEditorStore.setState({
      tabs: [{ id: 'arch-arc-reload', name: '粗纲', type: 'arch-file', filePath: 'ai-novel://core/arc', projectKey: PROJECT_PATH } as never],
      activeTabId: 'arch-arc-reload',
    })
    const initial = renderArcOutlineMarkdown([arcs[0]!])
    await act(async () => root.render(
      <ArchFileViewer tabId="arch-arc-reload" filePath="ai-novel://core/arc"
        projectKey={PROJECT_PATH} content={initial} savedContent={initial} />,
    ))
    await act(async () => { await Promise.resolve() })
    await act(async () => {
      globalEventBus.emit('WORKFLOW_COMPLETE', {
        type: 'architecture_generation',
        projectPath: PROJECT_PATH,
        projectSession: { projectId: project.id, leaseId: project.sessionLease!, projectPath: PROJECT_PATH },
        runId: 'arc-run-2',
      })
      await new Promise(resolve => setTimeout(resolve, 800))
    })
    await vi.waitFor(() => expect(container.textContent).toContain('第二段方向。'), { timeout: 5000 })
    // 既有内容不能被清空
    expect(container.textContent).toContain('第一段方向。')
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)
    expect(view).not.toBeNull()
    expect(view!.state.doc.toString().length).toBeGreaterThan(0)
  })
})




