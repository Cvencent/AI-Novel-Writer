import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'

import '../../../../index.css'
import '../../../../styles/paper-ink/index.css'
import '../../stage.css'
import type { ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { synopsisFactsFingerprint } from '../../../../services/workflows/commands/architecture.command'
import { EMPTY_CARD, useCharacterStore } from '../../../../stores/character-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import StageArchitecture from '../StageArchitecture'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { projectId: '雨夜列车', projectPath: 'C:/novels/rain-train', leaseId: '本次打开' }
const PREMISE = '收到匿名信的林舟登上一座本该拆除的车站的末班车，发现每盏阅读灯都对应一个失踪者。'.repeat(2)

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [useProjectStore, useWorkflowStore, useStageStore, useLocaleStore, useEditorStore, useCharacterStore].map(store => snapshot(store as StoreApi<unknown>))

let root: Root | undefined
let host: HTMLDivElement | undefined
let core: Record<string, unknown>
let partial: Record<string, unknown> | null
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>

const button = (name: string | RegExp) => [...document.querySelectorAll('button')]
  .find(candidate => typeof name === 'string'
    ? candidate.textContent === name || candidate.getAttribute('aria-label') === name
    : name.test(candidate.textContent ?? ''))
const click = async (name: string | RegExp) => {
  const target = button(name)
  expect(target, String(name)).toBeTruthy()
  await act(async () => target!.click())
}
const primary = () => host!.querySelector('.arch-header .pi-btn--primary')?.textContent
const writes = () => invoke.mock.calls.filter(([channel]) => channel === 'db:project-core-update')

function filledSpine(filled: readonly string[]) {
  const architecture = Object.fromEntries(['premise', 'characters', 'worldbuilding', 'synopsis'].map(key => [key, filled.includes(key)]))
  useStageStore.setState({ work: { session, architecture, blueprints: [] } })
}

async function render() {
  await act(async () => root!.render(<StageArchitecture projectKey={session.projectPath} />))
  await vi.waitFor(() => expect(host!.querySelector('.arch-page[data-loading], .arch-page[data-cast-loading]')).toBeNull())
}

beforeEach(() => {
  core = { premise: PREMISE, worldbuilding: '', synopsis: '', totalChapters: 24, writingLanguage: 'zh-CN' }
  partial = null
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'db:project-core-get') return core
    if (channel === 'fs:read-json') return partial ? { success: true, data: partial } : { success: false, error: 'not found' }
    if (channel === 'db:character-roster-read') return { schemaVersion: 1, revision: 1, migrationState: 'ready', status: 'empty', entries: [], renderedMarkdown: '', projectionHash: 'p', factHash: 'f' }
    if (channel === 'generation:list') return []
    if (channel === 'config:get') return { outlineTargetUnits: 300 }
    if (channel === 'db:project-core-update') {
      Object.assign(core, args[0] as Record<string, unknown>)
      return { success: true }
    }
    throw new Error(`未配置调用：${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  useProjectStore.setState({ currentProject: {
    id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '雨夜列车',
    novelConfig: { totalChapters: 24, wordsPerChapter: 3000, genre: '悬疑', targetAudience: '成人', coreOutline: '末班车', writingLanguage: 'zh-CN' },
  } as unknown as ProjectData })
  setActiveProjectSessionContext(session)
  useWorkflowStore.setState({ activeRuns: [], history: [], waitingRuns: {}, globalLogs: [] })
  useLocaleStore.setState({ locale: 'zh-CN' })
  useCharacterStore.setState({ characters: [{ ...EMPTY_CARD, characterId: 'c1', name: '林舟' }, { ...EMPTY_CARD, characterId: 'c2', name: '沈砚' }],
    dataProjectKey: session.projectPath, loadingProjectKey: null, lastError: null })
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'width: 1100px; height: 900px; display: flex'
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

describe('架构阶段', () => {
  it('主按钮随流程脊的四节状态切换：一节没有时生成，有缺口时继续生成，四节齐了进入蓝图', async () => {
    filledSpine([])
    await render()
    expect(primary()).toBe('AI 生成架构')
    expect(host!.querySelectorAll('.arch-header .pi-btn--primary')).toHaveLength(1)

    await act(async () => filledSpine(['premise', 'characters']))
    expect(primary()).toBe('继续生成架构')
    expect(host!.querySelector('.arch-eyebrow')?.textContent).toContain('2 / 4 已确认')

    await act(async () => filledSpine(['premise', 'characters', 'worldbuilding']))
    expect(primary()).toBe('继续生成架构')

    await act(async () => filledSpine(['premise', 'characters', 'worldbuilding', 'synopsis']))
    expect(primary()).toBe('下一步：章节蓝图')
    expect(host!.querySelectorAll('.arch-header .pi-btn--primary')).toHaveLength(1)
  })

  it('清空此节先出危险确认，取消后什么也不写、摘要不变；确认后才清空', async () => {
    filledSpine(['premise'])
    await render()
    const summary = () => host!.querySelector('[data-section="premise"] .arch-section-summary')?.textContent
    const before = summary()
    expect(before).toContain('收到匿名信的林舟')
    expect(host!.querySelector('[data-section="premise"] .arch-badge')?.textContent).toBe('已确认')
    expect(host!.querySelector('[data-section="characters"] .arch-section-summary')?.textContent).toBe('2 位角色：林舟、沈砚')

    await click('「故事前提」的更多操作')
    await click('清空此节…')
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('清空「故事前提」？')
    expect(dialog?.textContent).toContain('无法撤销')
    await click('取消')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(writes()).toHaveLength(0)
    expect(summary()).toBe(before)

    await click('「故事前提」的更多操作')
    await click('清空此节…')
    await click('清空此节')
    await vi.waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0][1]).toEqual({ premise: '' })
    await vi.waitFor(() => expect(host!.querySelector('[data-section="premise"] .arch-badge')?.textContent).toBe('待生成'))
  })

  it('大纲分批停在第 16 章：提示条说明缺的章，续写只从第 17 章起追加', async () => {
    const body = `Chapters 1-16: ${'The conductor keeps the lamps lit and every stop costs a name. '.repeat(4)}`.trim()
    core = { ...core, writingLanguage: 'en-US', synopsis: `# Plot Outline\n\n${body}\n\n> This outline covers chapters 1-16 of 24; the remaining chapters will be generated in later batches.` }
    partial = {
      synopsis_result: body, synopsis_incomplete: false, synopsis_covered_to: 16, synopsis_range: { from: 1, to: 16 },
      synopsis_facts_fingerprint: 'stored-inputs', synopsis_db_hash: synopsisFactsFingerprint([core.synopsis as string]),
    }
    filledSpine(['premise', 'synopsis'])
    await render()
    const outline = host!.querySelector('[data-section="synopsis"]')!
    expect(outline.querySelector('.arch-badge')?.textContent).toBe('部分完成 · 16 / 24 章')
    expect(outline.textContent).toContain('第 17～24 章还没有大纲')
    expect(outline.textContent).toContain('续写只追加缺少的章节')

    await click('续写第 17 章起')
    const from = document.querySelector<HTMLInputElement>('input[aria-label="本次生成范围的起始章"]')
    const to = document.querySelector<HTMLInputElement>('input[aria-label="本次生成范围的结束章"]')
    expect(from?.value).toBe('17')
    expect(Number(to?.value)).toBeGreaterThanOrEqual(17)
    expect(Number(to?.value)).toBeLessThanOrEqual(24)
    expect(document.querySelector('[data-step="synopsis"] .arch-mark')?.textContent).toBe('续写')
  })

  it('生成架构对话框按新样式标出已确认的节是覆盖还是保留', async () => {
    core = { ...core, worldbuilding: '世界观。'.repeat(30) }
    filledSpine(['premise', 'worldbuilding'])
    await render()
    await click('继续生成架构')
    const mark = (step: string) => document.querySelector(`[data-step="${step}"] .arch-mark`)?.textContent
    expect(mark('premise')).toBe('保留')
    expect(mark('worldbuilding')).toBe('保留')
    expect(mark('characters')).toBe('新生成')
    expect(mark('synopsis')).toBe('新生成')
    const premise = document.querySelector<HTMLInputElement>('[data-step="premise"] input[type="checkbox"]')!
    await act(async () => premise.click())
    expect(mark('premise')).toBe('将覆盖')
    expect(button(/开始生成 3 项/)).toBeTruthy()
  })
})
