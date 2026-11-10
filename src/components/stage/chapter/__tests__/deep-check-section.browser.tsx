import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'

import type { ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { globalEventBus } from '../../../../shared/event-bus'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import DeepCheckSection from '../DeepCheckSection'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { projectId: '灯塔', projectPath: 'C:/novels/lighthouse', leaseId: '本次打开' }
const restores = [useProjectStore, useLocaleStore]
  .map(store => { const state = (store as StoreApi<unknown>).getState(); return () => (store as StoreApi<unknown>).setState(state, true) })

const record = (findings: Array<Record<string, unknown>>) => ({
  runId: 'deep-review:run-1', target: 'chapter', selected: [1], sourceHash: 'h', createdAt: '2026-11-10T04:20:00.000Z',
  findings,
})

let root: Root | undefined
let host: HTMLDivElement | undefined
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>
let latest: unknown

beforeEach(() => {
  latest = null
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'db:stage-review-latest') return latest
    if (channel === 'db:stage-review-resolve') return { success: true }
    if (channel === 'db:stage-review-remove') return { success: true, removed: 1 }
    throw new Error(`未配置调用：${channel} ${String(args[0])}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '灯塔', novelConfig: {} } as unknown as ProjectData })
  setActiveProjectSessionContext(session)
  useLocaleStore.setState({ locale: 'zh-CN' })
  host = document.createElement('div')
  host.className = 'paper-ink'
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  setActiveProjectSessionContext(null)
  for (const restore of restores) restore()
  vi.restoreAllMocks()
})

/**
 * issue #245 现场：深度检查跑 1 分 49 秒、13 次模型调用全部成功，但结果一个字都看不见——
 * findings 只写进 `WorkflowStep.logs`（全仓无人渲染），executor 又不返回值。作者只能切页碰运气。
 * 这个组件是它们的落地面：随审稿侧页显示，且**工作流一结束就自己重读**（不必切页）。
 */
describe('深度检查发现（issue #245）', () => {
  it('列出本章的正文层发现，且只提供复制与忽略（没有可写回的替换文本）', async () => {
    latest = record([
      { findingId: 'f1', runId: 'deep-review:run-1', targetIndex: 1, category: '物证链断裂', severity: 'warning', problemText: '第 12 段的凭证在后续拍已不在原处。', expectedText: '', status: 'open' },
      { findingId: 'f2', runId: 'deep-review:run-1', targetIndex: 1, category: '期限冲突', severity: 'warning', problemText: '同一期限被写成两种口径。', expectedText: '', status: 'open' },
    ])
    await act(async () => root!.render(<DeepCheckSection chapterNumber={1} />))
    await vi.waitFor(() => expect(host!.textContent).toContain('第 12 段的凭证'))
    expect(host!.textContent).toContain('2 条待处理')
    expect(host!.textContent).toContain('同一期限被写成两种口径')
    const labels = [...host!.querySelectorAll('button')].map(node => node.textContent)
    expect(labels).toContain('复制')
    expect(labels).toContain('忽略')
    // 正文层发现没有可机械写回的文本：不提供「接受」（那意味着写回原文）。
    expect(labels).not.toContain('接受')
  })

  it('只看本章：其它章的深度检查记录不该显示在这一章', async () => {
    latest = record([
      { findingId: 'other', runId: 'deep-review:run-1', targetIndex: 7, category: 'c', severity: 'warning', problemText: '第七章的问题。', expectedText: '', status: 'open' },
    ])
    await act(async () => root!.render(<DeepCheckSection chapterNumber={1} />))
    await act(async () => { await Promise.resolve() })
    expect(host!.textContent).not.toContain('第七章的问题')
  })

  it('工作流结束时自己重读——不必切页才看得见', async () => {
    await act(async () => root!.render(<DeepCheckSection chapterNumber={1} />))
    await vi.waitFor(() => expect(invoke.mock.calls.some(([channel, target]) => channel === 'db:stage-review-latest' && target === 'chapter')).toBe(true))
    const before = invoke.mock.calls.length
    latest = record([
      { findingId: 'f9', runId: 'deep-review:run-1', targetIndex: 1, category: 'c', severity: 'warning', problemText: '刚跑完的这一处发现。', expectedText: '', status: 'open' },
    ])
    await act(async () => { globalEventBus.emit('WORKFLOW_COMPLETE', { type: 'chapter_creation', projectPath: session.projectPath, projectSession: session, runId: 'r1' }) })
    await vi.waitFor(() => expect(host!.textContent).toContain('刚跑完的这一处发现'))
    expect(invoke.mock.calls.length).toBeGreaterThan(before)
  })

  it('没有发现时不占位', async () => {
    latest = null
    await act(async () => root!.render(<DeepCheckSection chapterNumber={1} />))
    await act(async () => { await Promise.resolve() })
    expect(host!.textContent?.trim()).toBe('')
  })

  it('忽略一条后从清单消失，并把状态写进记录', async () => {
    latest = record([
      { findingId: 'f1', runId: 'deep-review:run-1', targetIndex: 1, category: 'c', severity: 'warning', problemText: '待忽略的一处。', expectedText: '', status: 'open' },
    ])
    await act(async () => root!.render(<DeepCheckSection chapterNumber={1} />))
    await vi.waitFor(() => expect(host!.textContent).toContain('待忽略的一处'))
    const ignore = [...host!.querySelectorAll('button')].find(node => node.textContent === '忽略')!
    await act(async () => { ignore.click(); await Promise.resolve() })
    await vi.waitFor(() => expect(invoke.mock.calls.some(([channel, runId, findingId, status]) =>
      channel === 'db:stage-review-resolve' && runId === 'deep-review:run-1' && findingId === 'f1' && status === 'ignored')).toBe(true))
    await vi.waitFor(() => expect(host!.textContent).not.toContain('待忽略的一处'))
  })
})
