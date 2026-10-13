import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ModelProfile, ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useAppearanceStore } from '../../../../stores/appearance-bootstrap'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { navigate } from '../../../../stores/navigation/navigation-intents'
import { useProjectStore } from '../../../../stores/project-store'
import { useThemeStore } from '../../../../stores/theme-store'
import StageSettings from '../StageSettings'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Api = { invoke: (channel: string, ...args: unknown[]) => Promise<unknown>; on: () => () => void }
const win = window as unknown as { aiNovelAPI?: Api }

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [snapshot(useLayoutStore), snapshot(useLLMStore), snapshot(useThemeStore), snapshot(useAppearanceStore), snapshot(useProjectStore), snapshot(useEditorStore)]

const MODEL = { id: 'flash', name: 'DeepSeek V4 Flash', provider: 'deepseek', protocol: 'openai', modelName: 'deepseek-v4-flash',
  apiKey: 'k', baseUrl: 'https://api.deepseek.com', temperature: 0.7, maxTokens: 4096, purposes: ['generation'] } as ModelProfile
const LOCAL = { ...MODEL, id: 'local', name: '本机 Ollama', provider: 'ollama', modelName: 'qwen3:14b' } as ModelProfile

let root: Root | undefined
let host: HTMLDivElement | undefined

async function mount(library = false) {
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'width: 1200px; height: 860px; display: flex;'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<StageSettings library={library} />))
}

const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')]
const byName = (name: string) => buttons().find(button => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === name)
const heading = () => host!.querySelector('h1')?.textContent

async function click(element: HTMLElement | undefined) {
  expect(element, '要点击的元素存在').toBeTruthy()
  await act(async () => element!.click())
}

async function key(name: string) {
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })) })
}

beforeEach(() => {
  win.aiNovelAPI = {
    invoke: async channel => channel === 'config:get' ? {} : channel === 'update:get-state' ? { status: 'disabled', currentVersion: '1.2.2', isReminderDeferred: false } : undefined,
    on: () => () => undefined,
  }
  useAppearanceStore.setState({ resolvedShell: 'stage' })
  useLLMStore.setState({ loaded: true, models: [MODEL, LOCAL], defaultModelId: 'flash', defaultEmbeddingModelId: null, deleteModel: vi.fn(async () => true) })
  useLayoutStore.setState({ settingsOpen: true, settingsSection: 'llm' })
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

describe('设置页', () => {
  it('按常用、高级、其他三组排列，按参数打开对应分组；旧的「编辑器」分区落在外观', async () => {
    useLayoutStore.setState({ settingsSection: 'backup' })
    await mount()
    const groups = [...host!.querySelectorAll('nav [role="group"]')].map(group => ({
      group: group.getAttribute('aria-label'),
      pages: [...group.querySelectorAll('button')].map(button => button.textContent),
    }))
    expect(groups).toEqual([
      { group: '常用', pages: ['AI 模型', '外观'] },
      { group: '高级', pages: ['检索模型', '网络代理', '提示词模板', '写作 Skills'] },
      { group: '其他', pages: ['项目备份', '关于与更新'] },
    ])
    expect(heading()).toBe('项目备份')
    expect(host!.querySelector('[aria-current="page"]')?.textContent).toBe('项目备份')

    await click(byName('关于与更新'))
    expect(useLayoutStore.getState().settingsSection).toBe('about')
    expect(heading()).toBe('关于与更新')

    await act(async () => useLayoutStore.setState({ settingsSection: 'editor' }))
    expect(heading()).toBe('外观')
    expect(host!.querySelector('[aria-current="page"]')?.textContent).toBe('外观')
  })

  it('删除模型先出现危险确认，写明后果；取消不删，确认才删', async () => {
    await mount()
    expect([...host!.querySelectorAll('[aria-label="AI 模型"] li')].map(item => item.querySelector('.stage-set-model-name')?.textContent))
      .toEqual(['DeepSeek V4 Flash默认', '本机 Ollama'])

    await click(byName('「DeepSeek V4 Flash」更多操作'))
    const menuItem = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === '删除模型…')
    await click(menuItem)
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.querySelector('h2')?.textContent).toBe('删除「DeepSeek V4 Flash」？')
    expect(dialog.textContent).toContain('它是默认模型。删除后要先另选一个默认模型')
    await click([...dialog.querySelectorAll('button')].find(button => button.textContent === '取消'))
    expect(useLLMStore.getState().deleteModel).not.toHaveBeenCalled()

    await click(byName('「本机 Ollama」更多操作'))
    await click([...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === '删除模型…'))
    const second = document.querySelector('[role="dialog"]')!
    expect(second.textContent).toContain('名称、接口地址和密钥会从本机删除')
    await click([...second.querySelectorAll('button')].find(button => button.textContent === '删除模型'))
    expect(useLLMStore.getState().deleteModel).toHaveBeenCalledWith('local')
  })

  it('保存模型时主进程出错：弹出错误，保存按钮恢复可点，编辑表单留着', async () => {
    useLLMStore.setState({ saveModel: vi.fn(async () => { throw new Error('llm:save-model 不可用') }) })
    await mount()
    await click(byName('编辑「DeepSeek V4 Flash」'))
    await click(byName('保存配置'))

    const alert = document.querySelector('[role="alertdialog"]')
    expect(alert?.textContent).toContain('模型设置保存失败')
    expect(alert?.textContent).toContain('llm:save-model 不可用')
    expect(byName('保存配置')?.disabled).toBe(false)
    await click([...alert!.querySelectorAll('button')].find(button => button.textContent === '确定'))
    await expect.poll(() => document.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('没有模型时是空状态，唯一的主按钮是添加模型', async () => {
    useLLMStore.setState({ models: [], defaultModelId: null })
    await mount()
    expect(host!.textContent).toContain('还没有添加模型')
    expect([...host!.querySelectorAll('.pi-btn--primary')].map(button => button.textContent)).toEqual(['添加模型'])
  })

  it('缩放在外观里：放大、缩小、还原', async () => {
    const zoomIn = vi.fn()
    const zoomOut = vi.fn()
    const zoomReset = vi.fn()
    useThemeStore.setState({ zoom: 1.1, zoomIn, zoomOut, zoomReset })
    useLayoutStore.setState({ settingsSection: 'appearance' })
    await mount()
    const group = host!.querySelector('[role="group"][aria-label="界面缩放"]')!
    expect(group.querySelector('output')?.textContent).toBe('110%')
    await click(byName('放大'))
    await click(byName('缩小'))
    await click(byName('还原'))
    expect([zoomIn.mock.calls.length, zoomOut.mock.calls.length, zoomReset.mock.calls.length]).toEqual([1, 1, 1])
  })

  it('返回或 Esc 关闭设置页；书房里写「返回书房」', async () => {
    await mount(true)
    expect(byName('返回书房')).toBeTruthy()
    await key('Escape')
    expect(useLayoutStore.getState().settingsOpen).toBe(false)

    await act(async () => useLayoutStore.setState({ settingsOpen: true }))
    await click(byName('返回书房'))
    expect(useLayoutStore.getState().settingsOpen).toBe(false)
  })

  it('打开作品途中的默认落点不收起设置页；去具体的阶段才收起', async () => {
    setActiveProjectSessionContext({ projectId: 'p', leaseId: 'l', projectPath: 'C:\\novels\\p' })
    useProjectStore.setState({ currentProject: { id: 'p', sessionLease: 'l', name: '灯塔', path: 'C:\\novels\\p', novelConfig: {} } as unknown as ProjectData })
    useEditorStore.setState({ tabs: [], activeTabId: null })
    navigate({ kind: 'settings', section: 'llm' })
    navigate({ kind: 'stage' })
    expect(useLayoutStore.getState().settingsOpen).toBe(true)
    navigate({ kind: 'stage', stage: 'setup' })
    expect(useLayoutStore.getState().settingsOpen).toBe(false)
  })
})
