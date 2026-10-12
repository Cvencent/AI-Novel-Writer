import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import type { ChapterBlueprint } from '../../../../services/workflows/directory-workflow'
import { editorSaveHandler, useEditorStore } from '../../../../stores/editor-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../../stores/project-store'
import StageBlueprint from '../StageBlueprint'

const PROJECT_PATH = 'C:\\novels\\stage-blueprint'
const originalEditor = useEditorStore.getState()
const originalProject = useProjectStore.getState()
const originalStage = useStageStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined
let stored: ChapterBlueprint[]
let invoke: ReturnType<typeof vi.fn>

function blueprint(chapterNumber: number, title: string): ChapterBlueprint {
  return {
    chapterNumber, title, role: '发展', purpose: '推进灯塔线索', keyEvents: '钟声提前一刻', characters: ['林岚', '守塔人'],
    suspenseHook: '', userGuidance: chapterNumber === 2 ? '节奏放慢。' : '', notes: '', notesUpdatedAt: '',
  }
}

function project(): ProjectData {
  return {
    id: 'stage-blueprint', sessionLease: 'stage-blueprint-lease', name: '灯塔', path: PROJECT_PATH,
    novelConfig: {
      genre: '悬疑', subGenre: '', targetAudience: '成人', totalChapters: 12, wordsPerChapter: 3000, plotStructure: 'three_act',
      narrativePOV: 'third_limited', coreOutline: '灯塔', worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '',
    },
    characterStates: '', createdAt: '', updatedAt: '',
  }
}

function installIpc() {
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'db:blueprint-get-all') return stored
    if (channel === 'db:draft-authority-sequence') return {
      status: 'continuous', lastChapterNumber: 1, nextChapterNumber: 2, duplicateChapterNumbers: [], authorityFingerprint: 'a'.repeat(64),
    }
    if (channel === 'generation:list') return []
    if (channel === 'db:consistency-exemption-list') return []
    if (channel === 'db:blueprint-clear-all') {
      stored = []
      return { success: true }
    }
    if (channel === 'db:blueprint-delete') {
      stored = stored.filter(item => item.chapterNumber !== args[0])
      return { success: true }
    }
    if (channel === 'db:blueprint-upsert' || channel === 'db:blueprint-upsert-many') return { success: true }
    if (channel === 'fs:list-dir') return []
    throw new Error(`unexpected IPC ${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn(), setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn(() => 0) },
  })
}

const calls = (channel: string) => invoke.mock.calls.filter(call => call[0] === channel)

async function renderPage() {
  await act(async () => root?.render(<div className="paper-ink"><StageBlueprint projectKey={PROJECT_PATH} /></div>))
  await expect.element(page.getByRole('complementary', { name: '章节规划' })).toBeVisible()
}

beforeEach(async () => {
  await page.viewport(1280, 900)
  stored = [blueprint(1, '旧港'), blueprint(2, '北堤'), blueprint(3, '灯室')]
  useLocaleStore.setState({ locale: 'zh-CN' })
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useProjectStore.setState({ currentProject: project() })
  useStageStore.setState({ writeRequest: null, work: null })
  setActiveProjectSessionContext({ projectId: 'stage-blueprint', leaseId: 'stage-blueprint-lease', projectPath: PROJECT_PATH })
  installIpc()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  useEditorStore.setState(originalEditor)
  useProjectStore.setState(originalProject)
  useStageStore.setState(originalStage)
})

describe('蓝图阶段', () => {
  it('主按钮是写下一章的拆分按钮，点箭头只出现小弹层', async () => {
    await renderPage()
    await expect.element(page.getByRole('button', { name: '写第 2 章' })).toBeVisible()
    expect(page.getByRole('button', { name: '写第 2 章' }).element().className).toContain('pi-btn--primary')
    expect(page.getByRole('button', { name: 'AI 生成蓝图' }).element().className).toContain('pi-btn--secondary')
    await act(async () => page.getByRole('button', { name: '本次写作选项' }).click())
    await expect.element(page.getByRole('dialog', { name: '本次写作选项' })).toBeVisible()
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
  })

  it('清空全部蓝图在危险分组里，确认前不清空，确认后列表为空并出现空状态', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '更多蓝图操作' }).click())
    const dangerGroup = page.getByRole('group', { name: '危险' })
    await act(async () => dangerGroup.getByRole('menuitem', { name: '清空全部蓝图…' }).click())
    const confirm = page.getByRole('dialog', { name: '清空全部蓝图？' })
    await expect.element(confirm).toHaveTextContent('将删除全部 3 章蓝图')
    expect(calls('db:blueprint-clear-all')).toHaveLength(0)

    await act(async () => confirm.getByRole('button', { name: '取消' }).click())
    expect(calls('db:blueprint-clear-all')).toHaveLength(0)
    await expect.element(page.getByRole('button', { name: /^1\D/ })).toBeVisible()

    await act(async () => page.getByRole('button', { name: '更多蓝图操作' }).click())
    await act(async () => page.getByRole('menuitem', { name: '清空全部蓝图…' }).click())
    await act(async () => page.getByRole('dialog', { name: '清空全部蓝图？' }).getByRole('button', { name: '清空全部' }).click())
    await vi.waitFor(() => expect(calls('db:blueprint-clear-all')).toHaveLength(1))
    await expect.element(page.getByRole('heading', { name: '还没有章节蓝图' })).toBeVisible()
    expect(page.getByRole('complementary', { name: '章节规划' }).query()).toBeNull()
  })

  it('删除此章在单章的危险分组里，确认后只删这一章', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: /^3\D/ }).click())
    await act(async () => page.getByRole('button', { name: '第 3 章更多操作' }).click())
    await act(async () => page.getByRole('group', { name: '危险' }).getByRole('menuitem', { name: '删除此章…' }).click())
    const confirm = page.getByRole('dialog', { name: '删除第 3 章蓝图？' })
    await expect.element(confirm).toBeVisible()
    expect(calls('db:blueprint-delete')).toHaveLength(0)
    await act(async () => confirm.getByRole('button', { name: '删除此章' }).click())
    await vi.waitFor(() => expect(calls('db:blueprint-delete').map(call => call[1])).toEqual([3]))
    await expect.element(page.getByRole('button', { name: /^3\D/ })).not.toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: /^2\D/ })).toBeVisible()
  })

  it('改字段后由外壳的保存（⌘S 同一入口）存全部，页面里不另显示未保存', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: /^2\D/ }).click())
    await act(async () => page.getByRole('textbox', { name: '章节标题' }).fill('北堤夜雨'))
    await act(async () => page.getByLabelText(/作者微操指导/).fill('节奏放慢，只写声音。'))
    expect(container?.textContent).not.toContain('未保存')

    const save = editorSaveHandler({ id: 'chapter-card-editor', type: 'chapter-card', projectKey: PROJECT_PATH })
    expect(save).not.toBeNull()
    await act(async () => { await save!() })
    const [[, saved]] = calls('db:blueprint-upsert-many')
    expect((saved as ChapterBlueprint[]).find(item => item.chapterNumber === 2)).toMatchObject({ title: '北堤夜雨', userGuidance: '节奏放慢，只写声音。' })
  })

  it('保存此章只写当前一章', async () => {
    await renderPage()
    await act(async () => page.getByRole('textbox', { name: '章节标题' }).fill('旧港潮汐'))
    await act(async () => page.getByRole('button', { name: '保存此章' }).click())
    await vi.waitFor(() => expect(calls('db:blueprint-upsert').map(call => call[1])).toMatchObject([{ chapterNumber: 1, title: '旧港潮汐' }]))
  })

  it('出场人物可以逐个添加与移除', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '移除 守塔人' }).click())
    await act(async () => page.getByLabelText('出场人物').fill('沈砺'))
    await act(async () => page.getByLabelText('出场人物').element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    const save = editorSaveHandler({ id: 'chapter-card-editor', type: 'chapter-card', projectKey: PROJECT_PATH })
    await act(async () => { await save!() })
    const [[, saved]] = calls('db:blueprint-upsert-many')
    expect((saved as ChapterBlueprint[])[0].characters).toEqual(['林岚', '沈砺'])
  })

  it('写作请求落到这一页：可写的那一章自动弹出写作弹层，写不了的章丢掉请求', async () => {
    useStageStore.setState({ writeRequest: { chapterNumber: 2 } })
    await renderPage()
    await expect.element(page.getByRole('dialog', { name: '本次写作选项' })).toBeVisible()
    expect(useStageStore.getState().writeRequest).toBeNull()

    await act(async () => root?.render(null))
    useStageStore.setState({ writeRequest: { chapterNumber: 3 } })
    await renderPage()
    await vi.waitFor(() => expect(useStageStore.getState().writeRequest).toBeNull())
    expect(page.getByRole('dialog', { name: '本次写作选项' }).query()).toBeNull()
  })
})
