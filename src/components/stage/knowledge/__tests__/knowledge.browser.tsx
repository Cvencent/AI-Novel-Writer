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
import { saveDirtyEditorChangesForExit, useEditorStore } from '../../../../stores/editor-store'
import { useLayoutStore } from '../../../../stores/layout-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import { toast } from '../../../ui/Toast'
import StageWorkspace from '../../StageWorkspace'
import { requestCloseTab } from '../../tab-close'
import { useStageShortcuts } from '../../use-stage-shortcuts'
import KnowledgeIndexSection from '../KnowledgeIndexSection'
import StageKnowledge from '../StageKnowledge'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { projectId: '雨夜列车', projectPath: 'C:/novels/night-train', leaseId: '本次打开' }
const KB_TAB = `knowledge-base:${encodeURIComponent(session.projectPath)}`
const project = (extra: Record<string, unknown> = {}) => ({ id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '雨夜列车', novelConfig: {}, ...extra }) as unknown as ProjectData
const IMPLEMENTATION_TERMS = /LanceDB|FTS|BM25|Embedding|向量|vector|chunk|query|MCP|token/i

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [useProjectStore, useLocaleStore, useLayoutStore, useEditorStore, useStageStore, useLLMStore, useWorkflowStore].map(store => snapshot(store as StoreApi<unknown>))

const copies: Record<string, string> = {
  station: '本报讯 三月十二日深夜，北郊车站三号站台发生一起列车事故。',
  people: '林舟，二十九岁，铁路调度员。',
  ch2: '林舟在抽屉底下翻出一张旧照片。',
}

let root: Root | undefined
let host: HTMLDivElement | undefined
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>

beforeEach(() => {
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'kb:list-documents') return [
      { id: 'station', fileName: '车站档案.md', importedAt: '', chunkCount: 3, filePath: 'knowledge-copy:station' },
      { id: 'people', fileName: '林舟人物小传.txt', importedAt: '', chunkCount: 2, filePath: 'knowledge-copy:people' },
      // 定稿经 kb:import-text 收入，和导入资料一样有项目副本；只有定稿登记里的章号能把它认出来。
      { id: 'ch2', fileName: '第2章 母亲的旧照片.txt', importedAt: '', chunkCount: 4, filePath: 'knowledge-copy:ch2', finalizedChapter: 2 },
      // 旧版导入、没有项目副本的资料。
      { id: 'legacy', fileName: '旧版地名表.txt', importedAt: '', chunkCount: 1, filePath: '' },
    ]
    if (channel === 'kb:stats') return { documentCount: 4, totalChunks: 9, vectorDimension: 0 }
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
    if (channel === 'kb:save-document-copy') return { success: true }
    if (channel === 'kb:backfill-vectors') return { success: true, processed: 4, failed: 0 }
    if (channel === 'db:blueprint-get-all') return []
    if (channel === 'dialog:select-knowledge-files') return [{ grantId: 'grant-1', displayName: '守塔人小传.txt' }]
    if (channel === 'fs:grant-read-file') return { success: true, content: '守塔人姓周，在灯塔守了三十年。' }
    throw new Error(`未配置调用：${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  useProjectStore.setState({ currentProject: project() })
  useEditorStore.setState({
    tabs: [
      { id: KB_TAB, name: '知识库', type: 'knowledge', projectKey: session.projectPath },
      { id: `version-history:${encodeURIComponent(session.projectPath)}`, name: '版本历史', type: 'version-history', projectKey: session.projectPath },
    ],
    activeTabId: KB_TAB,
  })
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

async function editorArea() {
  return vi.waitFor(() => {
    const textarea = document.querySelector('textarea')
    expect(textarea).toBeTruthy()
    return textarea!
  })
}

async function renderPage() {
  await act(async () => root!.render(<StageKnowledge tabId={KB_TAB} />))
  await vi.waitFor(() => expect(button(/车站档案/)).toBeTruthy())
}

/** 页面上作者能读到的全部文字：正文、可访问名称、提示与占位。 */
function visibleWords(): string {
  const attributes = [...document.querySelectorAll('[aria-label], [title], [placeholder]')]
    .flatMap(node => ['aria-label', 'title', 'placeholder'].map(name => node.getAttribute(name) ?? ''))
  return [document.body.textContent ?? '', ...attributes].join('\n')
}

/** 作者在页面与提示里读到的全部文字：每一步收一次页面，再加上弹过的提示。 */
function wordCollector() {
  const toasts: string[] = []
  for (const kind of ['success', 'error', 'warning', 'info'] as const) {
    vi.spyOn(toast, kind).mockImplementation(message => { toasts.push(message) })
  }
  const pages: string[] = []
  return { snap: () => { pages.push(visibleWords()) }, all: () => [...pages, ...toasts].join('\n'), toasts }
}

describe('知识库', () => {
  for (const locale of ['zh-CN', 'en-US'] as Locale[]) {
    const say = (zh: string, en: string) => locale === 'zh-CN' ? zh : en

    it(`${locale} 下资料、原文不可用、保存、查找、清空与外发提取确认里都没有实现术语`, async () => {
      useLocaleStore.setState({ locale })
      useLLMStore.setState({ loaded: true, models: [{ id: 'm1', name: '夹具模型', modelName: 'fixture', baseUrl: 'http://127.0.0.1:9', purposes: ['generation'] }] as never, defaultModelId: 'm1' })
      useWorkflowStore.setState({ startWorkflow: async () => 'local-run', history: [{ id: 'local-run', status: 'completed' }] as never })
      const words = wordCollector()
      await renderPage()
      words.snap()
      await click(/旧版地名表/)
      await vi.waitFor(() => expect(document.body.textContent).toContain(say('完整原文不可用', 'The full text is unavailable')))
      words.snap()
      await click(say('定稿章节 1', 'Final chapters 1'))
      await click(/母亲的旧照片/)
      words.snap()
      await click(say('我导入的 3', 'Imported 3'))
      await click(/车站档案/)
      await type(await editorArea(), `${copies.station}站台已封闭。`)
      await click(say('保存副本', 'Save copy'))
      await vi.waitFor(() => expect(words.toasts.length).toBeGreaterThan(0))
      await type(document.querySelector<HTMLInputElement>('form[role="search"] input')!, '三号站台 失踪')
      await act(async () => document.querySelector<HTMLFormElement>('form[role="search"]')!.requestSubmit())
      await vi.waitFor(() => expect(document.querySelectorAll('mark').length).toBeGreaterThan(0))
      words.snap()
      await click(say('清空知识库…', 'Clear knowledge base…'))
      expect(document.querySelector('[role="dialog"]')).toBeTruthy()
      words.snap()
      await click(say('取消', 'Cancel'))
      await click(say('导入创作资料', 'Import planning material'))
      await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('http://127.0.0.1:9'))
      words.snap()
      expect(words.all()).not.toMatch(IMPLEMENTATION_TERMS)
    })

    it(`${locale} 下空知识库、可按意思查找与检索检查的提示里都没有实现术语`, async () => {
      useLocaleStore.setState({ locale })
      const plain = invoke.getMockImplementation()!
      invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
        if (channel === 'kb:list-documents') return []
        if (channel === 'kb:stats') return { documentCount: 0, totalChunks: 0, vectorDimension: 768 }
        return plain(channel, ...args)
      })
      const words = wordCollector()
      await act(async () => root!.render(<StageKnowledge tabId={KB_TAB} />))
      await vi.waitFor(() => expect(document.body.textContent).toContain(say('知识库里还没有资料', 'No material yet')))
      expect(document.body.textContent).toContain(say('可以按意思和字词查找。', 'Search by meaning and by words.'))
      words.snap()
      await act(async () => root!.render(<KnowledgeIndexSection />))
      await vi.waitFor(() => expect(document.querySelector('section button')).toBeTruthy())
      await act(async () => document.querySelector<HTMLButtonElement>('section button')!.click())
      await vi.waitFor(() => expect(words.toasts.length).toBeGreaterThan(0))
      expect(words.toasts.join('\n')).not.toMatch(IMPLEMENTATION_TERMS)
      expect(words.all()).not.toMatch(IMPLEMENTATION_TERMS)
    })
  }

  it('查找结果里标出查找词，定稿章节分开列出', async () => {
    await renderPage()
    await type(document.querySelector<HTMLInputElement>('form[role="search"] input')!, '三号站台 失踪')
    await act(async () => document.querySelector<HTMLFormElement>('form[role="search"]')!.requestSubmit())
    await vi.waitFor(() => expect(document.body.textContent).toContain('找到 2 条'))
    expect([...document.querySelectorAll('mark')].map(node => node.textContent)).toEqual(expect.arrayContaining(['三号站台', '失踪']))
    expect(invoke.mock.calls.find(([channel]) => channel === 'kb:search')?.slice(1, 3)).toEqual(['三号站台 失踪', 10])

  })

  it('定稿章节按定稿登记分架：有项目副本也不进「我导入的」，旧版无副本的导入资料不算定稿', async () => {
    await renderPage()
    expect(button(/我导入的 3/)).toBeTruthy()
    expect(button(/旧版地名表/)).toBeTruthy()
    expect(button(/母亲的旧照片/)).toBeUndefined()

    await click(/旧版地名表/)
    await vi.waitFor(() => expect(document.body.textContent).toContain('完整原文不可用'))
    expect(document.body.textContent).not.toContain('这一章由定稿自动收入')

    await click(/定稿章节 1/)
    expect(button(/车站档案/)).toBeUndefined()
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

  it('外壳快捷键也在时，Ctrl S 保存项目副本', async () => {
    function WithShell() {
      useStageShortcuts({ library: false, focus: false, mac: false })
      return <StageKnowledge tabId={KB_TAB} />
    }
    await act(async () => root!.render(<WithShell />))
    await vi.waitFor(() => expect(button(/车站档案/)).toBeTruthy())
    await click(/车站档案/)
    const editor = await vi.waitFor(() => {
      const textarea = document.querySelector('textarea')
      expect(textarea).toBeTruthy()
      return textarea!
    })
    await type(editor, `${copies.station}站台已封闭。`)
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true })) })
    await vi.waitFor(() => expect(invoke.mock.calls.filter(([channel]) => channel === 'kb:save-document-copy').map(([, id, content]) => [id, content]))
      .toEqual([['station', `${copies.station}站台已封闭。`]]))
  })

  it('Ctrl S 连按两次只保存一次', async () => {
    let finishSave: (value: unknown) => void = () => {}
    const plain = invoke.getMockImplementation()!
    invoke.mockImplementation((channel: string, ...args: unknown[]) => channel === 'kb:save-document-copy'
      ? new Promise(resolve => { finishSave = resolve })
      : plain(channel, ...args))
    function WithShell() {
      useStageShortcuts({ library: false, focus: false, mac: false })
      return <StageKnowledge tabId={KB_TAB} />
    }
    await act(async () => root!.render(<WithShell />))
    await vi.waitFor(() => expect(button(/车站档案/)).toBeTruthy())
    await click(/车站档案/)
    await type(await editorArea(), `${copies.station}站台已封闭。`)
    const ctrlS = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true }))
    await act(async () => { ctrlS(); ctrlS() })
    await act(async () => finishSave({ success: true }))
    await vi.waitFor(() => expect(document.body.textContent).not.toContain('有未保存的修改'))
    expect(invoke.mock.calls.filter(([channel]) => channel === 'kb:save-document-copy')).toHaveLength(1)
  })

  describe('新外壳里未保存的项目副本不会悄悄丢掉', () => {
    async function editStation() {
      await vi.waitFor(() => expect(button(/车站档案/)).toBeTruthy())
      await click(/车站档案/)
      await type(await editorArea(), `${copies.station}站台已封闭。`)
    }

    it('切到别的标签再切回来，修改还在，标签带着未保存标记', async () => {
      await act(async () => root!.render(<StageWorkspace library={false} focus={false} />))
      await editStation()
      await act(async () => useEditorStore.getState().setActiveTab(`version-history:${encodeURIComponent(session.projectPath)}`))
      expect(document.querySelector('textarea')).toBeNull()
      expect(useEditorStore.getState().tabs.find(tab => tab.id === KB_TAB)?.dirty).toBe(true)
      await act(async () => useEditorStore.getState().setActiveTab(KB_TAB))
      await vi.waitFor(() => expect(document.querySelector('textarea')?.value).toBe(`${copies.station}站台已封闭。`))
      expect(document.body.textContent).toContain('有未保存的修改')
    })

    it('切走标签后退出前保存，仍把改动存进项目副本并清掉未保存标记', async () => {
      await act(async () => root!.render(<StageWorkspace library={false} focus={false} />))
      await editStation()
      await act(async () => useEditorStore.getState().setActiveTab(`version-history:${encodeURIComponent(session.projectPath)}`))
      await act(async () => saveDirtyEditorChangesForExit(session.projectPath))
      expect(invoke.mock.calls.filter(([channel]) => channel === 'kb:save-document-copy').map(([, id, content, hash]) => [id, content, hash]))
        .toEqual([['station', `${copies.station}站台已封闭。`, 'h-station']])
      expect(useEditorStore.getState().tabs.find(tab => tab.id === KB_TAB)?.dirty).toBe(false)
    })

    it('关闭标签（含 Ctrl W）先请作者确认', async () => {
      await act(async () => root!.render(<StageWorkspace library={false} focus={false} />))
      await editStation()
      await act(async () => requestCloseTab(KB_TAB))
      expect(useStageStore.getState().closingTabId).toBe(KB_TAB)
      expect(useEditorStore.getState().tabs.some(tab => tab.id === KB_TAB)).toBe(true)
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('「知识库」有未保存的修改')
    })

    it('切走前点的资料读得慢，切回后改了另一份资料，迟到的读取不会盖掉这些修改', async () => {
      let releaseFirstRead: () => void = () => {}
      let heldFirstRead = false
      const plain = invoke.getMockImplementation()!
      invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
        if (channel === 'kb:read-document-copy' && args[0] === 'station' && !heldFirstRead) {
          heldFirstRead = true
          await new Promise<void>(resolve => { releaseFirstRead = resolve })
        }
        return plain(channel, ...args)
      })
      await act(async () => root!.render(<StageWorkspace library={false} focus={false} />))
      await vi.waitFor(() => expect(button(/车站档案/)).toBeTruthy())
      await click(/车站档案/)
      await act(async () => useEditorStore.getState().setActiveTab(`version-history:${encodeURIComponent(session.projectPath)}`))
      await act(async () => useEditorStore.getState().setActiveTab(KB_TAB))
      await vi.waitFor(() => expect(document.querySelector('textarea')?.value).toBe(copies.station))
      await click(/林舟人物小传/)
      await vi.waitFor(() => expect(document.querySelector('textarea')?.value).toBe(copies.people))
      await type(await editorArea(), `${copies.people}左手有旧伤。`)
      await act(async () => { releaseFirstRead(); await new Promise(resolve => setTimeout(resolve, 20)) })
      expect(document.querySelector('textarea')?.value).toBe(`${copies.people}左手有旧伤。`)
      expect(document.querySelector('[aria-current="true"]')?.textContent).toContain('林舟人物小传')
      expect(useEditorStore.getState().tabs.find(tab => tab.id === KB_TAB)?.dirty).toBe(true)
    })

    it('保存还没返回时切走再切回，再按 Ctrl S 不重复保存', async () => {
      let finishSave: (value: unknown) => void = () => {}
      const plain = invoke.getMockImplementation()!
      invoke.mockImplementation((channel: string, ...args: unknown[]) => channel === 'kb:save-document-copy'
        ? new Promise(resolve => { finishSave = resolve })
        : plain(channel, ...args))
      function WithShell() {
        useStageShortcuts({ library: false, focus: false, mac: false })
        return <StageWorkspace library={false} focus={false} />
      }
      await act(async () => root!.render(<WithShell />))
      await editStation()
      const ctrlS = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true }))
      await act(async () => ctrlS())
      await act(async () => useEditorStore.getState().setActiveTab(`version-history:${encodeURIComponent(session.projectPath)}`))
      await act(async () => useEditorStore.getState().setActiveTab(KB_TAB))
      await vi.waitFor(() => expect(document.querySelector('textarea')?.value).toBe(`${copies.station}站台已封闭。`))
      await act(async () => ctrlS())
      await act(async () => finishSave({ success: true }))
      expect(invoke.mock.calls.filter(([channel]) => channel === 'kb:save-document-copy')).toHaveLength(1)
    })

    it('同一次打开里作品数据换成新对象（后台运行写回设定），修改还在', async () => {
      await renderPage()
      await click(/车站档案/)
      await type(await editorArea(), `${copies.station}站台已封闭。`)
      await act(async () => useProjectStore.setState({ currentProject: project({ novelConfig: { topic: '后台写回' } }) }))
      await act(async () => { await Promise.resolve() })
      expect(document.querySelector('textarea')?.value).toBe(`${copies.station}站台已封闭。`)
      expect(reads()).toEqual(['station'])
    })
  })

  it('先点的资料读得慢，后点的资料不会被它盖掉', async () => {
    let releaseStation: () => void = () => {}
    const plain = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'kb:read-document-copy' && args[0] === 'station') await new Promise<void>(resolve => { releaseStation = resolve })
      return plain(channel, ...args)
    })
    await renderPage()
    await click(/车站档案/)
    await click(/林舟人物小传/)
    await vi.waitFor(() => expect(document.querySelector('textarea')?.value).toBe(copies.people))
    await act(async () => { releaseStation(); await Promise.resolve() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(document.querySelector('textarea')?.value).toBe(copies.people)
    expect(document.querySelector('[aria-current="true"]')?.textContent).toContain('林舟人物小传')
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
