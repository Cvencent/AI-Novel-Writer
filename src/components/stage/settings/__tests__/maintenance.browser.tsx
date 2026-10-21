import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import MaintenanceSection from '../MaintenanceSection'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { projectId: '维护测试', projectPath: 'C:/novels/maintenance', leaseId: '本次打开' }
let root: Root | undefined
let host: HTMLDivElement | undefined
let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  setActiveProjectSessionContext(session)
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({
    currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, novelConfig: { totalChapters: 300 } },
  } as never)
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'db:generation-log-stats') {
      return { totalCalls: 743, callsWithPrompt: 639, callsTrimmed: 0, promptBytes: 353 * 1048576 }
    }
    if (channel === 'db:generation-log-compact') {
      return { success: true, trimmed: 439, vacuumed: true,
        after: { totalCalls: 743, callsWithPrompt: 200, callsTrimmed: 439, promptBytes: 94 * 1048576 } }
    }
    return null
  })
  Object.defineProperty(window, 'aiNovelAPI', {
    configurable: true, writable: true,
    value: { invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn(), setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn() },
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  setActiveProjectSessionContext(null)
  useProjectStore.setState({ currentProject: null } as never)
})

async function render() {
  await act(async () => { root!.render(<MaintenanceSection />) })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

describe('MaintenanceSection', () => {
  it('显示当前 Prompt 占用与保留策略', async () => {
    await render()
    const body = document.body.textContent ?? ''
    expect(body).toContain('743 次调用')
    expect(body).toContain('639')
    expect(body).toContain('200')   // 保留上限
    expect(body).toContain('353.0 MB')
  })

  it('超出保留范围时可点回收，并按新统计更新', async () => {
    await render()
    const button = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('回收空间'))!
    expect(button.disabled).toBe(false)
    await act(async () => { button.click() })
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    expect(invoke.mock.calls.some(([channel]) => channel === 'db:generation-log-compact')).toBe(true)
    expect(document.body.textContent).toContain('已清理 439 次调用的 Prompt')
    expect(document.body.textContent).toContain('94.0 MB')
  })

  it('没有超出保留范围时按钮置灰', async () => {
    invoke.mockImplementation(async (channel: string) => channel === 'db:generation-log-stats'
      ? { totalCalls: 10, callsWithPrompt: 10, callsTrimmed: 0, promptBytes: 1024 }
      : null)
    await render()
    const button = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('回收空间'))!
    expect(button.disabled).toBe(true)
    expect(document.body.textContent).toContain('当前没有超出保留范围的 Prompt')
  })
})
