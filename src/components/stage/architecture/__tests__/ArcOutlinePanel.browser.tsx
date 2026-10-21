import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../../index.css'
import '../../../../styles/paper-ink/index.css'
import '../../stage.css'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import ArcOutlinePanel from '../ArcOutlinePanel'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { projectId: '粗纲测试', projectPath: 'C:/novels/arc-panel', leaseId: '本次打开' }
let root: Root | undefined
let host: HTMLDivElement | undefined
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>
let originalApi: unknown

const button = (name: string) => [...document.querySelectorAll('button')]
  .find(candidate => candidate.textContent === name || candidate.getAttribute('aria-label') === name)

beforeEach(() => {
  setActiveProjectSessionContext(session)
  useProjectStore.setState({
    currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, novelConfig: { totalChapters: 300 } },
  } as never)
  useLocaleStore.setState({ locale: 'zh-CN' })

  const arcs = [
    { id: 1, arcIndex: 1, fromChapter: 1, toChapter: 40, title: '学院觉醒', summary: '主角觉醒。', beat: 'setup', status: 'confirmed', revision: 1, createdAt: '', updatedAt: '' },
    { id: 2, arcIndex: 2, fromChapter: 41, toChapter: 100, title: '源核争夺', summary: '多方争夺。', beat: 'escalation', status: 'draft', revision: 0, createdAt: '', updatedAt: '' },
  ]
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'db:arc-outline-list') return arcs
    if (channel === 'db:arc-outline-stale-list') return []
    return null
  })
  originalApi = (window as unknown as { aiNovelAPI?: unknown }).aiNovelAPI
  Object.defineProperty(window, 'aiNovelAPI', {
    configurable: true,
    writable: true,
    value: { invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn(), setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn() },
  })

  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, writable: true, value: originalApi })
  useProjectStore.setState({ currentProject: null } as never)
})

async function render(embedded = false) {
  await act(async () => { root!.render(<ArcOutlinePanel projectKey={session.projectPath} embedded={embedded} />) })
  await act(async () => { await Promise.resolve() })
}

describe('ArcOutlinePanel', () => {
  it('列出粗纲段与章数区间', async () => {
    await render()
    const textContent = document.body.textContent ?? ''
    expect(textContent).toContain('粗纲')
    expect(textContent).toContain('第 1–40 章')
    expect(textContent).toContain('学院觉醒')
    expect(textContent).toContain('第 41–100 章')
  })

  it('显示两个生成模式按钮', async () => {
    await render()
    expect(button('等我确认')).toBeTruthy()
    expect(button('跳过确认')).toBeTruthy()
  })

  it('默认等我确认处于按下状态', async () => {
    await render()
    expect(button('等我确认')!.getAttribute('aria-pressed')).toBe('true')
    expect(button('跳过确认')!.getAttribute('aria-pressed')).toBe('false')
  })

  it('点击跳过确认后切换按下状态', async () => {
    await render()
    await act(async () => { button('跳过确认')!.click() })
    expect(button('跳过确认')!.getAttribute('aria-pressed')).toBe('true')
    expect(button('等我确认')!.getAttribute('aria-pressed')).toBe('false')
  })

  it('嵌入架构页时也给出模式切换与一键生成全部粗纲', async () => {
    // 回归：这些控件过去只在独立面板的 header 里，而嵌入模式整个 header 都不渲染，
    // 结果架构页上既选不了模式，也没有「一键生成全部粗纲」。
    await render(true)
    expect(button('等我确认')).toBeTruthy()
    expect(button('跳过确认')).toBeTruthy()
    expect(button('一键生成全部粗纲')).toBeTruthy()
  })

  it('嵌入架构页时点「跳过确认」能切换模式', async () => {
    await render(true)
    expect(button('等我确认')!.getAttribute('aria-pressed')).toBe('true')
    await act(async () => { button('跳过确认')!.click() })
    expect(button('跳过确认')!.getAttribute('aria-pressed')).toBe('true')
  })

  it('粗纲已铺满全书时不再显示一键生成全部', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:arc-outline-list') {
        return [{ id: 1, arcIndex: 1, fromChapter: 1, toChapter: 300, title: '全书', summary: '方向', beat: 'setup', status: 'confirmed', revision: 1, createdAt: '', updatedAt: '' }]
      }
      if (channel === 'db:arc-outline-stale-list') return []
      return null
    })
    await render(true)
    expect(button('一键生成全部粗纲')).toBeUndefined()
  })

  it('存在过期细纲时列出需要重生成的章号', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:arc-outline-list') return []
      if (channel === 'db:arc-outline-stale-list') return [41, 42, 43]
      return null
    })
    await render()
    const textContent = document.body.textContent ?? ''
    expect(textContent).toContain('41、42、43')
    expect(textContent).toContain('需要重新生成')
  })
})
