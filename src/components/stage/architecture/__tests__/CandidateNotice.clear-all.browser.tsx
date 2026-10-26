import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CandidateNotice } from '../ArchitectureSection'
import type { ArchitectureOverview } from '../../../editor/use-architecture-overview'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function overview(): ArchitectureOverview {
  return {
    projectKey: 'C:/novels/arch-clear',
    projectMatches: true,
    loading: false,
    archStatus: { worldbuilding: true, synopsis: false, premise: true },
    planningRecovery: null,
    openRecoveryDraft: vi.fn(),
    copyCandidate: vi.fn(async () => {}),
    handleResumeSynopsis: vi.fn(async () => {}),
    handleResumeWorldBuilding: vi.fn(async () => {}),
    discardAllRecoveries: vi.fn(async () => {}),
    worldBuilding: {
      candidate: '世界观未完成草稿。',
      candidateShown: true,
      setCandidateShown: vi.fn(),
      busy: false,
      handle: { projectId: 'p', epoch: 'e', rootActionId: 'r', runId: 'run' },
      discard: vi.fn(),
    },
    synopsis: {
      candidate: '', candidateShown: false, setCandidateShown: vi.fn(), busy: false, handle: null, discard: vi.fn(),
    },
  } as unknown as ArchitectureOverview
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('CandidateNotice 一键清除全部恢复稿', () => {
  it('按钮经确认后调用 discardAllRecoveries', async () => {
    const stub = overview()
    await act(async () => root.render(<CandidateNotice sectionKey='worldbuilding' overview={stub} />))
    const button = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('一键清除全部恢复稿'))
    expect(button).toBeTruthy()
    await act(async () => { button!.click() })
    // 确认框出现
    const confirm = [...document.body.querySelectorAll('button')].find(b => b.textContent?.trim() === '一键清除')
    expect(confirm).toBeTruthy()
    await act(async () => { confirm!.click() })
    await vi.waitFor(() => expect(stub.discardAllRecoveries).toHaveBeenCalledOnce())
  })

  it('恢复稿文案可见时复制与续写入口仍在', async () => {
    await act(async () => root.render(<CandidateNotice sectionKey='worldbuilding' overview={overview()} />))
    expect([...container.querySelectorAll('button')].some(b => b.textContent?.includes('复制'))).toBe(true)
    expect([...container.querySelectorAll('button')].some(b => b.textContent?.includes('断点续写'))).toBe(true)
  })
})


