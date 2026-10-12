import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ProjectData } from '../../../../shared/ipc-channels'
import type { ProjectOverview } from '../../../../shared/project-overview'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useAppearanceStore } from '../../../../stores/appearance-bootstrap'
import { useDraftStore } from '../../../../stores/draft-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../../stores/project-store'
import StageLibrary from '../StageLibrary'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Api = { invoke: (channel: string, ...args: unknown[]) => Promise<unknown>; on: () => () => void }
const win = window as unknown as { aiNovelAPI?: Api }

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [snapshot(useLayoutStore), snapshot(useProjectStore), snapshot(useLLMStore), snapshot(useStageStore), snapshot(useDraftStore), snapshot(useAppearanceStore), snapshot(useEditorStore)]

const LIGHTHOUSE = { name: '灯塔', path: 'C:\\novels\\lighthouse', updatedAt: '2026-10-11T21:14:00.000Z', previewCapabilityId: 'cap-lighthouse' }
const ISLAND = { name: '雾岛', path: 'C:\\novels\\island', updatedAt: '2026-10-02T09:00:00.000Z', previewCapabilityId: 'cap-island' }
const READY: ProjectOverview = {
  state: 'ready', projectId: 'island', revision: 'r1', name: '雾岛', totalWords: 6214, characters: 3, finalizedChapters: 2,
  stages: [
    { id: 'configuration', status: 'in-progress', count: 5 }, { id: 'architecture', status: 'completed', count: 4 },
    { id: 'blueprint', status: 'in-progress', count: 12 }, { id: 'drafting', status: 'in-progress', count: 3 },
    { id: 'review', status: 'not-started', count: 0 }, { id: 'finalization', status: 'in-progress', count: 2 },
  ],
}

let root: Root | undefined
let host: HTMLDivElement | undefined
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>

async function mount() {
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'width: 1440px; height: 900px;'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<div className="stage-library"><StageLibrary /></div>))
}

function openCurrent() {
  const project = { id: 'lighthouse', sessionLease: 'lease-1', name: '灯塔', path: LIGHTHOUSE.path,
    novelConfig: { genre: '悬疑', totalChapters: 12, wordsPerChapter: 3000, coreOutline: '雾钟提前一刻响起。', targetAudience: '成年读者' } } as unknown as ProjectData
  setActiveProjectSessionContext({ projectId: 'lighthouse', leaseId: 'lease-1', projectPath: LIGHTHOUSE.path })
  useProjectStore.setState({ currentProject: project })
}

const button = (name: string) => [...host!.ownerDocument.querySelectorAll<HTMLButtonElement>('button')]
  .find(candidate => (candidate.getAttribute('aria-label') ?? candidate.textContent?.trim()) === name)
const dialog = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')]
  .find(candidate => candidate.querySelector('h2')?.textContent === name)

async function click(element: HTMLElement | undefined) {
  expect(element, '要点击的元素存在').toBeTruthy()
  await act(async () => element!.click())
}

async function chooseFromBookMenu(book: string, item: string) {
  await click(button(`《${book}》更多操作`))
  const menuItem = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(candidate => candidate.textContent === item)
  return menuItem
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'project:peek-overview') return READY
    if (channel === 'project:overview-current') return { ...READY, projectId: 'lighthouse', name: '灯塔', excerpt: '守塔人把灯又擦了一遍。' }
    if (channel === 'update:get-state') return { status: 'disabled', currentVersion: '1.2.2', isReminderDeferred: false }
    return undefined
  })
  win.aiNovelAPI = { invoke, on: () => () => undefined }
  useAppearanceStore.setState({ resolvedShell: 'stage' })
  useLayoutStore.setState({ sidebarView: 'home' })
  useStageStore.setState({ work: null })
  useLLMStore.setState({ loaded: true, defaultModelId: 'model' })
  useProjectStore.setState({
    currentProject: null,
    recentProjects: [],
    legacyImportBusy: false,
    legacyImportNotice: '',
    openProject: vi.fn(async () => true),
    removeRecentProject: vi.fn(async () => true),
    deleteProject: vi.fn(async () => true),
  } as never)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  delete win.aiNovelAPI
  setActiveProjectSessionContext(null)
  for (const restore of restores) restore()
})

describe('书房', () => {
  it('书架空着时唯一的主按钮是新建作品，没有模型时给出添加模型的入口', async () => {
    useLLMStore.setState({ loaded: true, defaultModelId: null })
    await mount()
    expect(host!.querySelector('h1')?.textContent).toBe('书架还是空的')
    expect([...host!.querySelectorAll('.pi-btn--primary')].map(element => element.textContent)).toEqual(['新建作品'])
    expect(host!.textContent).toContain('还没有连接 AI 模型')

    await click(button('新建作品'))
    expect(useLayoutStore.getState().newProjectOpen).toBe(true)
    await click(button('添加模型'))
    expect(useLayoutStore.getState()).toMatchObject({ settingsOpen: true, settingsSection: 'llm' })
  })

  it('点封面只预览不打开，概览里的主按钮才打开这部作品', async () => {
    useProjectStore.setState({ recentProjects: [LIGHTHOUSE, ISLAND] })
    await mount()
    await click(button('预览《雾岛》'))
    expect(invoke).toHaveBeenCalledWith('project:peek-overview', 'cap-island')
    expect(useProjectStore.getState().openProject).not.toHaveBeenCalled()
    expect(button('预览《雾岛》')?.getAttribute('aria-pressed')).toBe('true')

    const bars = [...host!.querySelectorAll<HTMLElement>('[data-stage]')].map(row => [row.dataset.stage, row.dataset.state, row.textContent])
    expect(bars).toEqual([
      ['setup', 'active', '设定 5 / 9'], ['architecture', 'done', '架构'], ['blueprint', 'done', '蓝图 12 章'], ['manuscript', 'active', '正文 2 章定稿'],
    ])
    expect([...host!.querySelectorAll('.pi-btn--primary')].map(element => element.textContent)).toEqual(['打开《雾岛》'])

    await click(button('预览《雾岛》'))
    expect(useProjectStore.getState().openProject).not.toHaveBeenCalled()
    await click(button('打开《雾岛》'))
    expect(useProjectStore.getState().openProject).toHaveBeenCalledWith(ISLAND.path)
  })

  it('从最近项目移除先确认，取消时不移除，确认后只移除书架记录', async () => {
    useProjectStore.setState({ recentProjects: [LIGHTHOUSE, ISLAND] })
    await mount()
    await click(await chooseFromBookMenu('雾岛', '从最近项目移除…'))
    expect(dialog('从书架移除《雾岛》？')?.textContent).toContain('作品文件夹留在原处')
    await click(button('取消'))
    expect(useProjectStore.getState().removeRecentProject).not.toHaveBeenCalled()

    await click(await chooseFromBookMenu('雾岛', '从最近项目移除…'))
    await click(button('移除记录'))
    expect(useProjectStore.getState().removeRecentProject).toHaveBeenCalledWith(ISLAND.path)
    expect(useProjectStore.getState().deleteProject).not.toHaveBeenCalled()
  })

  it('删除作品只对打开的作品可用，要输入完整作品名才能确认', async () => {
    openCurrent()
    useProjectStore.setState({ recentProjects: [LIGHTHOUSE, ISLAND] })
    await mount()

    const otherDelete = await chooseFromBookMenu('雾岛', '删除作品（先打开这部作品）')
    expect(otherDelete?.disabled).toBe(true)
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))

    await click(await chooseFromBookMenu('灯塔', '删除作品…'))
    const confirm = dialog('删除《灯塔》？')!
    const input = confirm.querySelector('input')!
    const remove = [...confirm.querySelectorAll('button')].find(candidate => candidate.textContent === '删除作品')!
    expect(remove.disabled).toBe(true)
    await type(input, '灯')
    expect(remove.disabled).toBe(true)
    await type(input, '灯塔')
    expect(remove.disabled).toBe(false)
    await click(remove)
    expect(useProjectStore.getState().deleteProject).toHaveBeenCalledWith(LIGHTHOUSE.path)
  })

  it('当前作品的概览与流程脊同源，主按钮写明继续写哪一步；数据没载入完时只写继续写作', async () => {
    openCurrent()
    useProjectStore.setState({ recentProjects: [LIGHTHOUSE] })
    await mount()
    const primary = () => [...host!.querySelectorAll('.pi-btn--primary')].map(element => element.textContent)
    expect(primary()).toEqual(['继续写作'])
    expect(host!.querySelector('[data-stage]')).toBeNull()

    const session = { projectId: 'lighthouse', leaseId: 'lease-1', projectPath: LIGHTHOUSE.path }
    await act(async () => {
      useStageStore.setState({ work: { session, architecture: { premise: true, characters: true }, blueprints: [] } })
      useDraftStore.setState({ draftsByChapter: {}, dataProjectSession: session, loading: false })
    })
    expect(primary()).toEqual(['继续写作 · 架构'])
    expect([...host!.querySelectorAll<HTMLElement>('[data-stage]')].map(row => row.textContent)).toEqual(['设定', '架构 2 / 4', '蓝图', '正文 0 / 12'])
    expect(host!.textContent).toContain('悬疑 · 12 章 · 每章约 3,000 字')
    expect(host!.textContent).toContain('守塔人把灯又擦了一遍。')

    await click(button('继续写作 · 架构'))
    expect(useLayoutStore.getState().sidebarView).not.toBe('home')
  })
})
