import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'

import '../../../../index.css'
import '../../../../styles/paper-ink/index.css'
import '../../stage.css'
import type { ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useDraftStore } from '../../../../stores/draft-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import StageHistory from '../StageHistory'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { projectId: '雨夜列车', projectPath: 'C:/novels/night-train', leaseId: '本次打开' }

interface Draft { id: number; chapterNumber: number; version: number; status: string; content: string }

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [useProjectStore, useLocaleStore, useEditorStore, useDraftStore].map(store => snapshot(store as StoreApi<unknown>))

let root: Root | undefined
let host: HTMLDivElement | undefined
let drafts: Draft[]
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>

const meta = (draft: Draft) => ({ id: draft.id, chapterNumber: draft.chapterNumber, version: draft.version, status: draft.status,
  wordCount: draft.content.length, createdAt: `2026-10-0${draft.version}T12:00:00.000Z`, dependenciesStale: false })

beforeEach(() => {
  drafts = [
    { id: 11, chapterNumber: 3, version: 1, status: 'draft', content: '雨从傍晚开始就没有停过。\n林舟攥着那封灰色的信。' },
    { id: 12, chapterNumber: 3, version: 2, status: 'draft', content: '雨从傍晚开始就没有停过。\n林舟攥着那封没有署名的信。\n他想起母亲说过的话。' },
  ]
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'db:blueprint-get-all') return [{ chapterNumber: 3, title: '雨夜车站' }, { chapterNumber: 4, title: '第三节车厢' }]
    if (channel === 'db:draft-list') return drafts.filter(draft => draft.chapterNumber === args[0]).map(meta)
    if (channel === 'db:draft-get-full') return drafts.find(draft => draft.id === args[0]) ?? null
    if (channel === 'db:draft-get-latest') {
      const own = drafts.filter(draft => draft.chapterNumber === args[0]).sort((a, b) => b.version - a.version)
      return own[0] ? meta(own[0]) : null
    }
    if (channel === 'db:draft-next-version') return Math.max(0, ...drafts.filter(draft => draft.chapterNumber === args[0]).map(draft => draft.version)) + 1
    if (channel === 'db:draft-create') {
      const input = args[0] as { chapterNumber: number; version: number; content: string }
      drafts.push({ id: 100 + drafts.length, chapterNumber: input.chapterNumber, version: input.version, status: 'draft', content: input.content })
      return { success: true, id: 100 + drafts.length }
    }
    if (channel === 'db:draft-list-all') return drafts.map(meta)
    throw new Error(`未配置调用：${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '雨夜列车', novelConfig: {} } as unknown as ProjectData })
  setActiveProjectSessionContext(session)
  useLocaleStore.setState({ locale: 'zh-CN' })
  useEditorStore.setState({ tabs: [], activeTabId: null })
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'width: 1200px; height: 800px; display: flex'
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

const button = (name: string | RegExp) => [...document.querySelectorAll('button')]
  .find(candidate => typeof name === 'string' ? candidate.textContent?.trim() === name : name.test(candidate.textContent ?? ''))
const click = async (name: string | RegExp) => {
  const target = button(name)
  expect(target, String(name)).toBeTruthy()
  await act(async () => target!.click())
}
const channels = () => invoke.mock.calls.map(([channel]) => channel)

async function openChapterThree() {
  await act(async () => root!.render(<StageHistory projectKey={session.projectPath} />))
  await vi.waitFor(() => expect(button(/雨夜车站/)).toBeTruthy())
  await click(/雨夜车站/)
  await vi.waitFor(() => expect(button(/草稿 v1/)).toBeTruthy())
}

describe('版本历史', () => {
  it('对比是只读的差异视图：标出增删、没有可编辑的地方、不打开修稿合并', async () => {
    await openChapterThree()
    await click(/草稿 v1/)
    const diff = await vi.waitFor(() => {
      const article = host!.querySelector('article[aria-readonly="true"]')
      expect(article).toBeTruthy()
      return article!
    })
    expect([...diff.querySelectorAll('del')].map(node => node.textContent).join('')).toContain('灰色的')
    expect([...diff.querySelectorAll('ins')].map(node => node.textContent).join('')).toContain('没有署名的')
    expect(diff.textContent).toContain('他想起母亲说过的话。')
    expect(host!.textContent).toContain('只读对比')

    const column = host!.querySelector('[aria-label="对比"]')!
    expect(column.querySelector('textarea, input, [contenteditable="true"], .cm-editor')).toBeNull()
    expect(host!.textContent).not.toContain('完成合并')
    expect(useEditorStore.getState().tabs).toHaveLength(0)
    expect(channels().filter(channel => channel === 'db:draft-create' || channel === 'db:draft-update-status')).toHaveLength(0)
  })

  it('回退到 v1 先说明会新建 v3，确认后新建回滚草稿，v1、v2 都保留', async () => {
    await openChapterThree()
    await click(/草稿 v1/)
    await vi.waitFor(() => expect(button('回退到此版本…')).toBeTruthy())
    await click('回退到此版本…')

    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('回退到草稿 v1？')
    expect(dialog.textContent).toContain('新建一份草稿 v3')
    expect(dialog.textContent).toContain('现在的草稿 v2和所有历史版本都会保留')
    expect(channels()).not.toContain('db:draft-create')

    await click('新建回滚草稿')
    await vi.waitFor(() => expect(button(/草稿 v3/)).toBeTruthy())
    const created = invoke.mock.calls.find(([channel]) => channel === 'db:draft-create')![1] as { chapterNumber: number; version: number; content: string }
    expect(created).toMatchObject({ chapterNumber: 3, version: 3, content: drafts[0].content })
    const timeline = host!.querySelector('[aria-label="版本时间线"]')!
    expect([...timeline.querySelectorAll('.stage-hist-version-name')].map(node => node.firstChild?.textContent)).toEqual(['草稿 v3', '草稿 v2', '草稿 v1'])
    expect(timeline.querySelector('li:first-child')!.textContent).toContain('当前')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('取消回退不写入任何稿', async () => {
    await openChapterThree()
    await click(/草稿 v1/)
    await vi.waitFor(() => expect(button('回退到此版本…')).toBeTruthy())
    await click('回退到此版本…')
    await click('取消')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(channels()).not.toContain('db:draft-create')
  })

  it('当前稿没有回退按钮', async () => {
    await openChapterThree()
    await click(/草稿 v2/)
    await vi.waitFor(() => expect(host!.textContent).toContain('与当前稿相同'))
    expect(button('回退到此版本…')).toBeUndefined()
  })
})
