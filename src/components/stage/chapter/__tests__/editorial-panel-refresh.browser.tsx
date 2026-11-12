import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'

import type { ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { globalEventBus } from '../../../../shared/event-bus'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import EditorialPanelSection from '../EditorialPanelSection'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { projectId: '源起', projectPath: 'C:/novels/yuanqi', leaseId: '本次打开' }
const restores = [useProjectStore, useLocaleStore]
  .map(store => { const state = (store as StoreApi<unknown>).getState(); return () => (store as StoreApi<unknown>).setState(state, true) })

const panel = {
  draftId: 30, chapterNumber: 2, contentHash: 'h',
  version: 1 as const, weightedScore: 88.75, blockingCount: 0, summary: '情节推进可读。',
  reviewedAt: '2026-11-12T13:20:40.000Z',
  roles: [
    { role: 'plot' as const, score: 90, summary: '主线清楚', findings: [] },
    { role: 'continuity' as const, score: 88, summary: '接续成立', findings: [] },
    { role: 'character' as const, score: 87, summary: '动机成立', findings: [] },
    { role: 'style' as const, score: 89, summary: '克制', findings: [] },
    { role: 'pacing' as const, score: 90, summary: '节奏可读', findings: [] },
  ],
}

/** 只提供面板所需的 checklist 表面：自动并入走 autoMergeEditorialFindings。 */
const checklist = {
  items: [] as Array<Record<string, unknown>>,
  autoMergeEditorialFindings: vi.fn(() => 0),
} as unknown as Parameters<typeof EditorialPanelSection>[0]['checklist']

let root: Root | undefined
let host: HTMLDivElement | undefined
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>
let quality: unknown

beforeEach(() => {
  quality = null
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'db:writing-intelligence-quality-get') return quality
    throw new Error(`未配置调用：${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '源起', novelConfig: {} } as unknown as ProjectData })
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
 * issue #245 现场：作者每次 AI 审稿之后，编辑部得分都要**切一次页面**才刷新出来。
 *
 * 根因：面板用 `runId === activeRunId.current` 过滤 `WORKFLOW_COMPLETE`，
 * 而那个 ref 只有「重新评估」按钮才会赋值——AI 审稿触发的 runId 永远不匹配，
 * 于是评分已落库、面板还停在空状态，必须重挂载（切页）才看得到。
 *
 * 现在改成「任何工作流结束都按当前稿重读」，靠 load 内部的 revision 守卫防陈旧回应。
 */
describe('编辑部评分随审稿自动刷新（issue #245 现场）', () => {
  it('工作流一结束就重读，不需要切页面', async () => {
    await act(async () => root!.render(<EditorialPanelSection chapterNumber={2} draftId={30} draftVersion={1} checklist={checklist} />))
    await vi.waitFor(() => expect(host!.textContent).toContain('还没有编辑部评分'))

    // 审稿跑完、评分落库，然后广播完成事件（runId 与面板记录的任何 ref 都无关）
    quality = panel
    await act(async () => { globalEventBus.emit('WORKFLOW_COMPLETE', { type: 'chapter_creation', projectPath: session.projectPath, projectSession: session, runId: 'ai-review-run-1' }) })

    await vi.waitFor(() => expect(host!.textContent).toContain('88.8'))
    expect(host!.textContent).not.toContain('还没有编辑部评分')
  })

  it('拿不到评分时明确说「没跑成」，不拿空状态冒充正常', async () => {
    await act(async () => root!.render(<EditorialPanelSection chapterNumber={2} draftId={30} draftVersion={1} checklist={checklist} />))
    await vi.waitFor(() => expect(host!.textContent).toContain('还没有编辑部评分'))
    // 审稿跑完但这一类没有评分 = 失败
    quality = null
    await act(async () => { globalEventBus.emit('WORKFLOW_COMPLETE', { type: 'chapter_creation', projectPath: session.projectPath, projectSession: session, runId: 'ai-review-run-1' }) })
    await vi.waitFor(() => expect(host!.textContent).toContain('编辑部评审没跑成'))
    expect([...host!.querySelectorAll('button')].map(node => node.textContent)).toContain('重试编辑部评审')
  })

  it('评分到达后把发现自动并入清单（作者不必再点「纳入修稿」）', async () => {
    quality = { ...panel, roles: panel.roles.map((role, index) => index === 0
      ? { ...role, findings: [{ severity: 'warning', description: '遗漏巡逻队经过的触发', evidence: '原文' }] }
      : role) }
    await act(async () => root!.render(<EditorialPanelSection chapterNumber={2} draftId={30} draftVersion={1} checklist={checklist} />))
    await vi.waitFor(() => expect(checklist!.autoMergeEditorialFindings).toHaveBeenCalled())
    expect(checklist!.autoMergeEditorialFindings).toHaveBeenCalledWith([
      { severity: 'warning', description: '遗漏巡逻队经过的触发', evidence: '原文', roleLabel: '情节' },
    ])
  })
})