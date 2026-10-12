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
let rosterStatus: 'empty' | 'ready'
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
/** 启动的工作流只含勾选的那几节，步骤 key 就是实际交给后台的节。 */
let started: ReturnType<typeof vi.fn<(definition: { steps: { key: string }[] }) => Promise<string>>>
const launchedSteps = () => started.mock.calls.map(([definition]) => definition.steps.map(step => step.key))
const writes = () => invoke.mock.calls.filter(([channel]) => channel === 'db:project-core-update')

function filledSpine(filled: readonly string[]) {
  const architecture = Object.fromEntries(['premise', 'characters', 'worldbuilding', 'synopsis'].map(key => [key, filled.includes(key)]))
  useStageStore.setState({ work: { session, architecture, blueprints: [] } })
}

/** 已有第 1～16 章大纲（全书 24 章），分批检查点可用。 */
function seedPartialOutline() {
  const body = `Chapters 1-16: ${'The conductor keeps the lamps lit and every stop costs a name. '.repeat(4)}`.trim()
  core = { ...core, writingLanguage: 'en-US', synopsis: `# Plot Outline\n\n${body}\n\n> This outline covers chapters 1-16 of 24; the remaining chapters will be generated in later batches.` }
  partial = {
    synopsis_result: body, synopsis_incomplete: false, synopsis_covered_to: 16, synopsis_range: { from: 1, to: 16 },
    synopsis_facts_fingerprint: 'stored-inputs', synopsis_db_hash: synopsisFactsFingerprint([core.synopsis as string]),
  }
  filledSpine(['premise', 'synopsis'])
}
const mark = (step: string) => document.querySelector(`[data-step="${step}"] .arch-mark`)?.textContent
const stepChecked = (step: string) => document.querySelector<HTMLInputElement>(`[data-step="${step}"] input[type="checkbox"]`)?.checked
async function typeInto(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function render() {
  await act(async () => root!.render(<StageArchitecture projectKey={session.projectPath} />))
  await vi.waitFor(() => expect(host!.querySelector('.arch-page[data-loading], .arch-page[data-cast-loading]')).toBeNull())
}

beforeEach(() => {
  core = { premise: PREMISE, worldbuilding: '', synopsis: '', totalChapters: 24, writingLanguage: 'zh-CN' }
  partial = null
  rosterStatus = 'empty'
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'db:project-core-get') return core
    if (channel === 'fs:read-json') return partial ? { success: true, data: partial } : { success: false, error: 'not found' }
    if (channel === 'db:character-roster-read') return { schemaVersion: 1, revision: 1, migrationState: 'ready', status: rosterStatus, entries: [], renderedMarkdown: '林舟、沈砚', projectionHash: 'p', factHash: 'f' }
    if (channel === 'generation:list') return []
    if (channel === 'config:get') return { outlineTargetUnits: 300 }
    if (channel === 'config:set') return { success: true }
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
  started = vi.fn(async () => 'r1')
  useWorkflowStore.setState({ activeRuns: [], history: [], waitingRuns: {}, globalLogs: [], startWorkflow: started as never })
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
  const LONG = '内容。'.repeat(30)
  it.each([
    { state: '一节都没有', premise: '', cast: false, world: '', outline: 'none', count: 0, action: 'AI 生成架构' },
    { state: '前提与角色名单', premise: PREMISE, cast: true, world: '', outline: 'none', count: 2, action: '继续生成架构' },
    { state: '缺情节大纲', premise: PREMISE, cast: true, world: LONG, outline: 'none', count: 3, action: '继续生成架构' },
    { state: '大纲只到第 16 章', premise: PREMISE, cast: true, world: LONG, outline: 'partial', count: 3, action: '继续生成架构' },
    { state: '四节齐全', premise: PREMISE, cast: true, world: LONG, outline: 'full', count: 4, action: '下一步：章节蓝图' },
  ])('主按钮与页头计数读四节徽标：$state', async ({ premise, cast, world, outline, count, action }) => {
    if (outline === 'partial') seedPartialOutline()
    core = { ...core, premise, worldbuilding: world, ...(outline === 'full' ? { synopsis: LONG } : {}) }
    rosterStatus = cast ? 'ready' : 'empty'
    await render()
    const ready = [...host!.querySelectorAll('.arch-badge')].filter(badge => badge.textContent === '已确认').length
    expect(ready).toBe(count)
    expect(host!.querySelector('.arch-eyebrow')?.textContent).toContain(`${count} / 4 已确认`)
    expect(primary()).toBe(action)
    expect(host!.querySelectorAll('.arch-header .pi-btn--primary')).toHaveLength(1)
    const next = button('下一步：章节蓝图') as HTMLButtonElement
    expect(next.disabled).toBe(count < 4)
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

  it('角色名单保存后（修订号前进）重读名单状态，不触发修复；角色卡首次载入不多读一次', async () => {
    const rosterReads = () => invoke.mock.calls.filter(([channel]) => channel === 'db:character-roster-read').length
    await act(async () => useCharacterStore.setState({ rosterRevision: null }))
    await render()
    const afterOpen = rosterReads()
    await act(async () => useCharacterStore.setState({ rosterRevision: 1 }))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(rosterReads()).toBe(afterOpen)

    await act(async () => useCharacterStore.setState({ rosterRevision: 2 }))
    await vi.waitFor(() => expect(rosterReads()).toBe(afterOpen + 1))
    expect(invoke.mock.calls.some(([channel]) => channel === 'legacy-roster:read-source')).toBe(false)
    // 名单快照换了不必再读一遍另三节：打开时一轮，重读名单后也不加。
    expect(invoke.mock.calls.filter(([channel]) => channel === 'db:project-core-get')).toHaveLength(1)
    expect(started).not.toHaveBeenCalled()
  })

  it('清空确认打开期间换了作品，确认时什么也不写', async () => {
    filledSpine(['premise'])
    await render()
    await click('「故事前提」的更多操作')
    await click('清空此节…')
    const other = { projectId: '另一部', projectPath: 'C:/novels/other', leaseId: '另一次打开' }
    await act(async () => {
      useProjectStore.setState({ currentProject: { id: other.projectId, path: other.projectPath, sessionLease: other.leaseId, name: '另一部', novelConfig: { totalChapters: 24 } } as unknown as ProjectData })
      setActiveProjectSessionContext(other)
    })
    if (document.querySelector('[role="dialog"]')) await click('清空此节')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(writes()).toHaveLength(0)
  })

  it('大纲分批停在第 16 章：提示条说明缺的章，续写只从第 17 章起追加', async () => {
    seedPartialOutline()
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
    expect(mark('synopsis')).toBe('续写')
  })

  it('续写入口只预选情节大纲：先在别的节打开「AI 重新生成此节」再取消，不会把那一节带进续写', async () => {
    seedPartialOutline()
    await render()
    await click('「故事前提」的更多操作')
    await click('AI 重新生成此节…')
    expect(stepChecked('premise')).toBe(true)
    await click('取消')
    await vi.waitFor(() => expect(document.querySelector('[data-step="premise"]')).toBeNull())

    await click('续写第 17 章起')
    expect(stepChecked('premise')).toBe(false)
    expect(mark('premise')).toBe('保留')
    await click(/开始生成 \d 项/)
    await vi.waitFor(() => expect(launchedSteps()).toEqual([['synopsis']]))
  })

  it('大纲范围的标记与后台规则一致：第 1 章起是覆盖，紧接已有章是续写，其余起始章在对话框里就拦下', async () => {
    seedPartialOutline()
    await render()
    await click('续写第 17 章起')
    const submit = () => button(/开始生成 \d 项/) as HTMLButtonElement

    await typeInto('本次生成范围的起始章', '1')
    await typeInto('本次生成范围的结束章', '20')
    expect(mark('synopsis')).toBe('将覆盖')
    expect(submit().disabled).toBe(false)

    await typeInto('本次生成范围的结束章', '10')
    expect(document.querySelector('.arch-range-issue')?.textContent).toContain('第 11–16 章')
    expect(submit().disabled).toBe(true)

    await typeInto('本次生成范围的起始章', '17')
    await typeInto('本次生成范围的结束章', '24')
    expect(mark('synopsis')).toBe('续写')
    expect(document.querySelector('.arch-range-issue')).toBeNull()

    await typeInto('本次生成范围的起始章', '10')
    expect(mark('synopsis')).toBe('范围无效')
    expect(document.querySelector('.arch-range-issue')?.textContent).toContain('从第 17 章续写')
    expect(submit().disabled).toBe(true)
    await act(async () => submit().click())
    expect(started).not.toHaveBeenCalled()
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

    const all = document.querySelector<HTMLInputElement>('.arch-step-all input[type="checkbox"]')!
    await act(async () => all.click())
    expect(['premise', 'characters', 'worldbuilding', 'synopsis'].map(stepChecked)).toEqual([true, true, true, true])
    expect(all.checked).toBe(true)
    await act(async () => all.click())
    expect(['premise', 'characters', 'worldbuilding', 'synopsis'].map(stepChecked)).toEqual([false, false, false, false])
    expect(all.checked).toBe(false)
    expect((button(/开始生成 0 项/) as HTMLButtonElement).disabled).toBe(true)
  })

  it('分节摘要不带文档的 Markdown 标题行', async () => {
    core = { ...core, premise: `# 故事前提\n\n## 核心钩子\n\n${PREMISE}` }
    filledSpine(['premise'])
    await render()
    expect(host!.querySelector('[data-section="premise"] .arch-section-summary')?.textContent?.startsWith('收到匿名信的林舟')).toBe(true)
  })
})
