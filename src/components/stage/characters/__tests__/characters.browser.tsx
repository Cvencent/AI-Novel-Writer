import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'

import '../../../../index.css'
import '../../../../styles/paper-ink/index.css'
import '../../stage.css'
import type { PendingFinalizedCharacterStateCandidate } from '../../../../shared/finalized-continuity'
import type { ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { EMPTY_CARD, useCharacterStore, type CharacterCard } from '../../../../stores/character-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import StageCharacters from '../StageCharacters'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { projectId: '雨夜列车', projectPath: 'C:/novels/rain-train', leaseId: '本次打开' }
const card = (characterId: string, name: string, role: CharacterCard['role'] = 'supporting'): CharacterCard =>
  ({ ...EMPTY_CARD, characterId, name, role })
const linzhou = card('c-linzhou', '林舟', 'protagonist')
const shenyan = card('c-shenyan', '沈砚')
const stateCandidate = (key: string, field: PendingFinalizedCharacterStateCandidate['field'], value: string): PendingFinalizedCharacterStateCandidate => ({
  candidateKey: key, characterId: linzhou.characterId!, characterName: '林舟', displayName: '林舟', selectionKey: `state:${key}`,
  field, value, reason: 'author-protected', expectedFieldRevision: 3, expectedFieldValueHash: 'b'.repeat(64),
  source: { draftId: 7, finalizationId: 'final-7', chapterNumber: 7, contentHash: 'c'.repeat(64) },
})

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [useProjectStore, useWorkflowStore, useStageStore, useLocaleStore, useEditorStore, useCharacterStore]
  .map(store => snapshot(store as StoreApi<unknown>))

let root: Root | undefined
let host: HTMLDivElement | undefined
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>
let pendingStates: PendingFinalizedCharacterStateCandidate[]
let pendingDecisions: number
let store: {
  saveAll: ReturnType<typeof vi.fn>
  deleteCharacter: ReturnType<typeof vi.fn>
  load: ReturnType<typeof vi.fn>
}

const button = (name: string | RegExp) => [...document.querySelectorAll('button')]
  .find(candidate => typeof name === 'string'
    ? candidate.textContent === name || candidate.getAttribute('aria-label') === name
    : name.test(candidate.textContent ?? ''))
const click = async (name: string | RegExp) => {
  const target = button(name)
  expect(target, String(name)).toBeTruthy()
  await act(async () => target!.click())
}
const banner = () => host!.querySelector('[aria-label="待处理的角色建议"]')

async function render() {
  await act(async () => root!.render(<StageCharacters projectKey={session.projectPath} />))
}

beforeEach(() => {
  pendingStates = []
  pendingDecisions = 0
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'character-proposal:list-pending-finalized') return Array.from({ length: pendingDecisions }, (_, index) =>
      ({ proposalBatchId: `cpb-${index}`, revision: 1, finalizationId: `final-${index}` }))
    if (channel === 'finalized-character:list-state-candidates') return pendingStates.map(candidate => ({
      draftId: 7, candidateKey: candidate.candidateKey, finalizationId: 'final-7',
      characterId: candidate.characterId, characterName: candidate.characterName, field: candidate.field }))
    if (channel === 'finalized-character:read-state-candidate') {
      const { candidateKey } = args[0] as { candidateKey: string }
      return pendingStates.find(candidate => candidate.candidateKey === candidateKey)
    }
    if (channel === 'finalized-character:decide-state-candidate') {
      const { candidateKey } = args[0] as { candidateKey: string }
      pendingStates = pendingStates.filter(candidate => candidate.candidateKey !== candidateKey)
      return { candidateKey, operationId: 'decision', payloadHash: 'd'.repeat(64), decision: 'accept', idempotent: false }
    }
    if (channel === 'character-avatar:read-batch') return { success: true, avatars: [] }
    if (channel === 'db:project-core-get') return null
    throw new Error(`未配置调用：${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '雨夜列车', novelConfig: {} } as unknown as ProjectData })
  setActiveProjectSessionContext(session)
  useWorkflowStore.setState({ activeRuns: [], history: [], waitingRuns: {}, globalLogs: [] })
  useLocaleStore.setState({ locale: 'zh-CN' })
  store = {
    saveAll: vi.fn(async () => undefined),
    deleteCharacter: vi.fn(async () => true),
    load: vi.fn(async () => undefined),
  }
  useCharacterStore.setState({
    characters: [linzhou, shenyan], dataProjectKey: session.projectPath, dataProjectSession: session, loadingProjectKey: null, lastError: null,
    identityBusy: false, saving: false, selectedId: linzhou.characterId, rosterRevision: 1, ...store,
  } as never)
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'width: 1200px; height: 900px; display: flex'
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

describe('角色名单', () => {
  it('名单列出全部角色，改动后保存角色走名单的保存', async () => {
    await render()
    const rows = [...host!.querySelectorAll('.cast-row')].map(row => row.querySelector('.cast-row-name')?.textContent)
    expect(rows).toEqual(['林舟', '沈砚'])
    expect(host!.querySelector('.cast-profile-name')?.textContent).toBe('林舟')

    const motivation = [...host!.querySelectorAll('.cast-field')].find(field => field.textContent?.startsWith('动机'))!.querySelector('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(motivation, '弄清母亲为什么登上那班车')
      motivation.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(useCharacterStore.getState().characters[0].motivation).toBe('弄清母亲为什么登上那班车')

    expect(host!.querySelectorAll('.pi-btn--primary')).toHaveLength(1)
    await click('保存角色')
    expect(store.saveAll).toHaveBeenCalledWith(session.projectPath)
  })

  it('删除角色先出危险确认，取消不删；确认后删除选中的那位', async () => {
    await render()
    await click('角色的更多操作')
    await click('删除角色「林舟」…')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('删除角色「林舟」？')
    await click('取消')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(store.deleteCharacter).not.toHaveBeenCalled()

    await click('角色的更多操作')
    await click('删除角色「林舟」…')
    await click('删除角色')
    await vi.waitFor(() => expect(store.deleteCharacter).toHaveBeenCalledWith(linzhou.characterId, session.projectPath))
  })

  it('角色决策与状态建议合成一条提示条，接受一条后它从提示条消失并重读名单', async () => {
    pendingDecisions = 1
    pendingStates = [stateCandidate('s-location', 'location', '北塔'), stateCandidate('s-items', 'keyItems', '第三封信')]
    await render()
    await vi.waitFor(() => expect(banner()?.textContent).toContain('3 项待处理的角色建议'))
    expect(host!.querySelectorAll('.cast-suggestions')).toHaveLength(1)
    expect(host!.querySelectorAll('.cast-suggestion[data-kind="decision"]')).toHaveLength(1)
    expect(host!.querySelectorAll('.cast-suggestion[data-kind="state"]')).toHaveLength(2)

    const review = [...host!.querySelectorAll('.cast-suggestion[data-kind="state"]')]
      .find(row => row.textContent?.includes('位置'))!.querySelector('button')!
    await act(async () => review.click())
    await vi.waitFor(() => expect(banner()?.textContent).toContain('建议：北塔'))
    await click('接受状态建议')

    await vi.waitFor(() => expect(banner()?.textContent).toContain('2 项待处理的角色建议'))
    expect(store.load).toHaveBeenCalled()
    expect(invoke.mock.calls.find(([channel]) => channel === 'finalized-character:decide-state-candidate')?.[1])
      .toMatchObject({ candidateKey: 's-location', decision: 'accept' })
    expect(banner()?.textContent).not.toContain('位置')
    expect(banner()?.textContent).toContain('关键物品')
  })

  it('没有待处理的建议时不显示提示条', async () => {
    await render()
    await vi.waitFor(() => expect(invoke.mock.calls.some(([channel]) => channel === 'finalized-character:list-state-candidates')).toBe(true))
    expect(banner()).toBeNull()
  })
})
