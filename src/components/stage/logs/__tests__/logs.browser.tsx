import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../../index.css'
import '../../../../styles/paper-ink/index.css'
import '../../stage.css'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import StageLogs from '../StageLogs'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { projectId: '日志测试', projectPath: 'C:/novels/logs', leaseId: '本次打开' }
const calls = [
  { attemptId: 'a1', runId: 'r1', purpose: 'plot-outline:chapter:151', status: 'settled', modelName: 'test-model', requestedOutputTokens: 8192, hasPrompt: true, hasOutput: true, promptTrimmed: false },
  { attemptId: 'a2', runId: 'r1', purpose: 'arc-outline:from:1', status: 'settled', modelName: 'test-model', requestedOutputTokens: 4096, hasPrompt: true, hasOutput: true, promptTrimmed: true },
]
const detail = {
  ...calls[0],
  promptMessages: [{ role: 'system', content: '系统提示词全文' }, { role: 'user', content: '用户提示词全文' }],
  output: '模型返回的完整文本',
}

let root: Root | undefined
let host: HTMLDivElement | undefined
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>
let originalApi: unknown

beforeEach(() => {
  setActiveProjectSessionContext(session)
  useProjectStore.setState({
    currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, novelConfig: { totalChapters: 300 } },
  } as never)
  useLocaleStore.setState({ locale: 'zh-CN' })
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'db:generation-log-list') return calls
    if (channel === 'db:generation-log-read') return detail
    return null
  })
  originalApi = (window as unknown as { aiNovelAPI?: unknown }).aiNovelAPI
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
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, writable: true, value: originalApi })
  useProjectStore.setState({ currentProject: null } as never)
})

async function render() {
  await act(async () => { root!.render(<StageLogs />) })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

describe('StageLogs', () => {
  it('列出每次模型调用及其阶段名', async () => {
    await render()
    const textContent = document.body.textContent ?? ''
    expect(textContent).toContain('生成日志')
    expect(textContent).toContain('plot-outline:chapter:151')
    expect(textContent).toContain('arc-outline:from:1')
  })

  it('默认折叠：不显示 Prompt 与返回正文', async () => {
    await render()
    const textContent = document.body.textContent ?? ''
    expect(textContent).not.toContain('系统提示词全文')
    expect(textContent).not.toContain('模型返回的完整文本')
  })

  it('展开后显示完整 Prompt 与返回', async () => {
    await render()
    const row = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('plot-outline:chapter:151'))!
    await act(async () => { row.click() })
    await act(async () => { await Promise.resolve() })
    const textContent = document.body.textContent ?? ''
    expect(textContent).toContain('系统提示词全文')
    expect(textContent).toContain('用户提示词全文')
    expect(textContent).toContain('模型返回的完整文本')
  })

  it('详情缺字段（没有 toolCalls）时照常展开，不整页崩', async () => {
    // 回归：真实库里的旧记录可能没有 toolCalls，渲染时直接读 .length 会把整个日志页打崩。
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:generation-log-list') return calls
      if (channel === 'db:generation-log-read') {
        return { ...calls[0], promptMessages: [{ role: 'system', content: '系统提示词全文' }], output: '模型返回的完整文本' }
      }
      return null
    })
    await render()
    const row = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('plot-outline:chapter:151'))!
    await act(async () => { row.click() })
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    expect(document.body.textContent ?? '').toContain('系统提示词全文')
    expect(document.body.textContent ?? '').toContain('模型返回的完整文本')
  })

  it('详情读不到时说明这条没有记录，而不是一直显示正在读取', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:generation-log-list') return calls
      return null
    })
    await render()
    const row = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('plot-outline:chapter:151'))!
    await act(async () => { row.click() })
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    const body = document.body.textContent ?? ''
    expect(body).toContain('这条调用没有可显示的记录。')
    expect(body).not.toContain('正在读取这次调用…')
  })

  it('列表标出 Prompt 已被保留策略清理的调用', async () => {
    await render()
    // a2 的 Prompt 已被清理，列表里要一眼能看出来
    const rows = [...document.querySelectorAll('.stage-logs-item')]
    const trimmedRow = rows.find(row => row.textContent?.includes('arc-outline:from:1'))
    expect(trimmedRow?.textContent).toContain('Prompt 已清理')
    const keptRow = rows.find(row => row.textContent?.includes('plot-outline:chapter:151'))
    expect(keptRow?.textContent).not.toContain('Prompt 已清理')
  })

  it('展开已清理的调用时说明原因，而不是显示成空记录', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:generation-log-list') return calls
      if (channel === 'db:generation-log-read') {
        return { ...calls[1], promptMessages: [], output: '返回仍在', promptTrimmed: true }
      }
      return null
    })
    await render()
    const row = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('arc-outline:from:1'))!
    await act(async () => { row.click() })
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    const body = document.body.textContent ?? ''
    expect(body).toContain('已按保留策略清理')
    expect(body).toContain('返回仍在')
    expect(body).not.toContain('这次调用没有记录 Prompt')
  })

  it('没有调用记录时给出说明', async () => {
    invoke.mockImplementation(async (channel: string) => channel === 'db:generation-log-list' ? [] : null)
    await render()
    expect(document.body.textContent ?? '').toContain('还没有模型调用记录')
  })

  it('读取失败时显示错误而不崩溃', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:generation-log-list') throw new Error('日志读取失败')
      return null
    })
    await render()
    expect(document.body.textContent ?? '').toContain('日志读取失败')
  })
})
