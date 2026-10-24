import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StageReviewPanel from '../StageReviewPanel'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import type { StageReviewFindingRecord } from '../../../../shared/stage-review-types'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT_PATH = 'C:/novels/stage-review-panel'
const SESSION = { projectId: '检查面板测试', projectPath: PROJECT_PATH, leaseId: '本次打开' }

let root: Root | undefined
let host: HTMLDivElement | undefined
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>
let originalApi: unknown

function finding(overrides: Partial<StageReviewFindingRecord> = {}): StageReviewFindingRecord {
  return {
    findingId: 'f1', runId: 'r1', targetIndex: 3, category: 'pacing', severity: 'warning',
    problemText: '第 3 章是流水账。', expectedText: '## 第3章：改写\n场景与出场人物：……', status: 'open',
    ...overrides,
  }
}

const button = (name: string) => [...document.querySelectorAll('button')]
  .find(candidate => candidate.textContent?.trim() === name || candidate.getAttribute('aria-label') === name)

beforeEach(() => {
  setActiveProjectSessionContext(SESSION)
  useProjectStore.setState({
    currentProject: { id: SESSION.projectId, path: PROJECT_PATH, sessionLease: SESSION.leaseId, novelConfig: { totalChapters: 300 } },
  } as never)
  useLocaleStore.setState({ locale: 'zh-CN' })

  invoke = vi.fn(async (channel: string) => {
    if (channel === 'db:stage-review-latest') {
      return { runId: 'r1', target: 'outline', selected: [3], sourceHash: 'h', createdAt: '', findings: [finding()] }
    }
    if (channel === 'db:stage-review-apply-outline') return { success: true, synopsis: 'updated' }
    if (channel === 'db:stage-review-resolve') return { success: true }
    if (channel === 'db:stage-review-accept-all') return { success: true, accepted: 1 }
    if (channel === 'db:stage-review-remove') return { success: true, removed: true }
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

async function render(applyFinding: ReturnType<typeof vi.fn<(finding: StageReviewFindingRecord) => Promise<boolean>>> = vi.fn(async () => true)) {
  await act(async () => {
    root!.render(
      <StageReviewPanel
        projectKey={PROJECT_PATH}
        target='outline'
        launchIntent={{ workflow: 'review_outline', range: { from: 3, to: 3 } }}
        canReview
        reviewBusy={false}
        onReviewBusyChange={() => {}}
        applyFinding={applyFinding}
      />,
    )
  })
  await act(async () => { await Promise.resolve() })
  return applyFinding
}


describe('StageReviewPanel', () => {
  it('loads the latest persisted review and lists its findings', async () => {
    await render()
    await vi.waitFor(() => expect(host!.textContent).toContain('第 3 章是流水账。'))
    expect(host!.textContent).toContain('节奏')
    expect(host!.textContent).toContain('第 3 章/段')
  })

  it('accepting a finding writes it back and then marks it accepted', async () => {
    const applyFinding = await render()
    await vi.waitFor(() => expect(host!.textContent).toContain('第 3 章是流水账。'))
    await act(async () => { button('接受')!.click() })
    await vi.waitFor(() => expect(applyFinding).toHaveBeenCalledOnce())
    const [applied] = applyFinding.mock.calls[0]!
    expect(applied).toMatchObject({ targetIndex: 3, category: 'pacing' })
    await vi.waitFor(() => expect(invoke.mock.calls.some(([name]) => name === 'db:stage-review-resolve')).toBe(true))
  })

  it('ignoring a finding never writes to the source document', async () => {
    const applyFinding = await render()
    await vi.waitFor(() => expect(host!.textContent).toContain('第 3 章是流水账。'))
    await act(async () => { button('忽略')!.click() })
    await vi.waitFor(() => expect(invoke.mock.calls.some(([name]) => name === 'db:stage-review-resolve')).toBe(true))
    expect(applyFinding).not.toHaveBeenCalled()
    expect(invoke.mock.calls.some(([name]) => name === 'db:stage-review-apply-outline')).toBe(false)
  })

  it('removing a run clears the cards', async () => {
    await render()
    await vi.waitFor(() => expect(host!.textContent).toContain('第 3 章是流水账。'))
    await act(async () => { button('删除')!.click() })
    await vi.waitFor(() => expect(host!.textContent).not.toContain('第 3 章是流水账。'))
  })
})
