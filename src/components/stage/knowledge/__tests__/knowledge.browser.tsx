import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'

import '../../../../index.css'
import '../../../../styles/paper-ink/index.css'
import '../../stage.css'
import type { Locale } from '../../../../i18n/types'
import type { ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import KnowledgeIndexSection from '../KnowledgeIndexSection'
import StageKnowledge from '../StageKnowledge'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { projectId: '雨夜列车', projectPath: 'C:/novels/night-train', leaseId: '本次打开' }
const IMPLEMENTATION_TERMS = /LanceDB|FTS|BM25|Embedding|向量|query|MCP|token/i

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [useProjectStore, useLocaleStore, useLayoutStore].map(store => snapshot(store as StoreApi<unknown>))

const copies: Record<string, string> = {
  station: '本报讯 三月十二日深夜，北郊车站三号站台发生一起列车事故。',
  people: '林舟，二十九岁，铁路调度员。',
}

let root: Root | undefined
let host: HTMLDivElement | undefined
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>

beforeEach(() => {
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'kb:list-documents') return [
      { id: 'station', fileName: '车站档案.md', importedAt: '', chunkCount: 3, filePath: 'knowledge-copy:station' },
      { id: 'people', fileName: '林舟人物小传.txt', importedAt: '', chunkCount: 2, filePath: 'knowledge-copy:people' },
      { id: 'ch2', fileName: '第2章 母亲的旧照片.md', importedAt: '', chunkCount: 4, filePath: 'chapters/2.md' },
    ]
    if (channel === 'kb:stats') return { documentCount: 3, totalChunks: 9, vectorDimension: 0 }
    if (channel === 'kb:get-vector-rebuild-status') return { embeddingConfigured: true, canRebuild: true, totalChunks: 9, vectorlessCount: 4, activeVectorDimension: 0 }
    if (channel === 'kb:read-document-copy') {
      const content = copies[args[0] as string]
      return content ? { available: true, content, contentHash: `h-${args[0]}`, edited: false, indexStatus: 'current' } : { available: false, indexStatus: 'unavailable' }
    }
    if (channel === 'kb:search') return [
      { text: '……最后一次被人看见，是在三号站台的候车长椅上，此后失踪。', score: 0.5, fileName: '失踪者名单.md' },
      { text: '……北郊车站三号站台发生一起列车事故……', score: 0.5, fileName: '车站档案.md' },
    ]
    if (channel === 'kb:clear-all') return { success: true }
    if (channel === 'kb:backfill-vectors') return { success: true, processed: 4, failed: 0 }
    throw new Error(`未配置调用：${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '雨夜列车', novelConfig: {} } as unknown as ProjectData })
  setActiveProjectSessionContext(session)
  useLocaleStore.setState({ locale: 'zh-CN' })
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'width: 1280px; height: 800px; display: flex'
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
  .find(candidate => typeof name === 'string'
    ? candidate.textContent?.trim() === name || candidate.getAttribute('aria-label') === name
    : name.test(candidate.textContent ?? ''))
const click = async (name: string | RegExp) => {
  const target = button(name)
  expect(target, String(name)).toBeTruthy()
  await act(async () => target!.click())
}
const reads = () => invoke.mock.calls.filter(([channel]) => channel === 'kb:read-document-copy').map(([, id]) => id)

async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!
  await act(async () => {
    setter.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function renderPage() {
  await act(async () => root!.render(<StageKnowledge />))
  await vi.waitFor(() => expect(button(/车站档案/)).toBeTruthy())
}

/** 页面上作者能读到的全部文字：正文、可访问名称、提示与占位。 */
function visibleWords(): string {
  const attributes = [...document.querySelectorAll('[aria-label], [title], [placeholder]')]
    .flatMap(node => ['aria-label', 'title', 'placeholder'].map(name => node.getAttribute(name) ?? ''))
  return [document.body.textContent ?? '', ...attributes].join('\n')
}

describe('知识库', () => {
  for (const locale of ['zh-CN', 'en-US'] as Locale[]) {
    it(`${locale} 下资料、原文、查找、索引提示与确认里都没有实现术语`, async () => {
      useLocaleStore.setState({ locale })
      await renderPage()
      await click(/车站档案/)
      await vi.waitFor(() => expect(document.querySelector('textarea')).toBeTruthy())
      await type(document.querySelector<HTMLInputElement>('input[type="search"], form[role="search"] input')!, '三号站台 失踪')
      await act(async () => document.querySelector<HTMLFormElement>('form[role="search"]')!.requestSubmit())
      await vi.waitFor(() => expect(document.querySelectorAll('mark').length).toBeGreaterThan(0))
      await click(locale === 'zh-CN' ? '清空知识库…' : 'Clear knowledge base…')
      expect(document.querySelector('[role="dialog"]')).toBeTruthy()
      expect(visibleWords()).not.toMatch(IMPLEMENTATION_TERMS)
    })
  }

  it('查找结果里标出查找词，定稿章节分开列出', async () => {
    await renderPage()
    await type(document.querySelector<HTMLInputElement>('form[role="search"] input')!, '三号站台 失踪')
    await act(async () => document.querySelector<HTMLFormElement>('form[role="search"]')!.requestSubmit())
    await vi.waitFor(() => expect(document.body.textContent).toContain('找到 2 条'))
    expect([...document.querySelectorAll('mark')].map(node => node.textContent)).toEqual(expect.arrayContaining(['三号站台', '失踪']))
    expect(invoke.mock.calls.find(([channel]) => channel === 'kb:search')?.slice(1, 3)).toEqual(['三号站台 失踪', 10])

    expect(button(/母亲的旧照片/)).toBeUndefined()
    await click(/定稿章节 1/)
    await click(/母亲的旧照片/)
    await vi.waitFor(() => expect(document.body.textContent).toContain('这一章由定稿自动收入'))
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('项目副本有未保存修改时切换资料先确认；继续编辑留住修改，放弃才切换', async () => {
    await renderPage()
    await click(/车站档案/)
    const editor = await vi.waitFor(() => {
      const textarea = document.querySelector('textarea')
      expect(textarea).toBeTruthy()
      return textarea!
    })
    await type(editor, `${copies.station}站台已封闭。`)
    expect(document.body.textContent).toContain('有未保存的修改')

    await click(/林舟人物小传/)
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('放弃未保存的修改？')
    expect(dialog.textContent).toContain('「车站档案」的项目副本有未保存的修改')
    expect(reads()).toEqual(['station'])

    await click('继续编辑')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('textarea')!.value).toBe(`${copies.station}站台已封闭。`)
    expect(reads()).toEqual(['station'])

    await click(/林舟人物小传/)
    await click('放弃并切换')
    await vi.waitFor(() => expect(document.querySelector('textarea')?.value).toBe(copies.people))
    expect(reads()).toEqual(['station', 'people'])
  })

  it('没有修改时直接切换，不弹确认', async () => {
    await renderPage()
    await click(/车站档案/)
    await vi.waitFor(() => expect(document.querySelector('textarea')).toBeTruthy())
    await click(/林舟人物小传/)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await vi.waitFor(() => expect(document.querySelector('textarea')?.value).toBe(copies.people))
  })

  it('清空知识库先危险确认，确认后才清空', async () => {
    await renderPage()
    await click('清空知识库…')
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('kb:clear-all')
    await click('清空知识库')
    await vi.waitFor(() => expect(invoke.mock.calls.map(([channel]) => channel)).toContain('kb:clear-all'))
  })

  it('知识库页没有重建索引；它在设置的检索模型页里', async () => {
    await renderPage()
    expect(button(/重建/)).toBeUndefined()
    expect(document.body.textContent).toContain('有 4 段资料还不能按意思查找')
    await click('去设置补全')
    expect(useLayoutStore.getState()).toMatchObject({ settingsOpen: true, settingsSection: 'embedding' })

    await act(async () => root!.render(<KnowledgeIndexSection />))
    await vi.waitFor(() => expect(button(/检查并重建/)).toBeTruthy())
    await click(/检查并重建/)
    await vi.waitFor(() => expect(invoke.mock.calls.map(([channel]) => channel)).toContain('kb:backfill-vectors'))
  })
})
