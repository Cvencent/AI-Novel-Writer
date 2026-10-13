import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { formatResourceUri } from '../../../../shared/project-paths'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useDraftStore } from '../../../../stores/draft-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { openChapterPlan } from '../../../../stores/navigation/stage-navigation'
import { openDraftTab } from '../../../../stores/open-draft-tab'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import StageWorkspace from '../../StageWorkspace'
import { AI_REVIEW, BLUEPRINT, ORIGINAL, REVISED, SESSION, chapterProject, createChapterBackend, generationModel } from './chapter-fixture'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const original = {
  editor: useEditorStore.getState(), project: useProjectStore.getState(), drafts: useDraftStore.getState(),
  stage: useStageStore.getState(), llm: useLLMStore.getState(), workflow: useWorkflowStore.getState(),
}

let root: Root | undefined
let host: HTMLDivElement | undefined
let backend: ReturnType<typeof createChapterBackend>

async function mount() {
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'display:flex;flex-direction:column;height:900px;width:1028px'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<StageWorkspace library={false} focus={false} />))
}

async function loadDrafts() {
  await act(async () => { await useDraftStore.getState().loadAllDrafts(SESSION.projectPath, SESSION) })
}

async function openDraft(draftId: number) {
  await loadDrafts()
  const draft = Object.values(useDraftStore.getState().draftsByChapter).flat().find(candidate => candidate.id === draftId)!
  await act(async () => { await openDraftTab(draft, '第 3 章 · 雨夜车站', SESSION) })
}

const tabs = () => useEditorStore.getState().tabs
const activeTab = () => tabs().find(tab => tab.id === useEditorStore.getState().activeTabId)
const click = (name: string | RegExp) => act(async () => page.getByRole('button', { name, exact: typeof name === 'string' }).click())
const type = (text: string) => act(async () => useEditorStore.getState().updateTabContent(activeTab()!.id, text))
const versions = async () => {
  await act(async () => page.getByRole('button', { name: /本章版本/ }).click())
  return [...document.querySelectorAll('[role="menuitemradio"]')].map(item => item.firstElementChild?.textContent)
}

beforeEach(async () => {
  await page.viewport(1280, 900)
  backend = createChapterBackend()
  backend.install()
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: chapterProject() })
  setActiveProjectSessionContext(SESSION)
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useStageStore.setState({ work: { session: SESSION, architecture: {}, blueprints: [{ chapterNumber: 3, title: BLUEPRINT.title }] }, chapterRequest: null, writeRequest: null, sheet: null })
  useLLMStore.setState({ models: [generationModel('grok')], defaultModelId: 'grok', loaded: true })
  useWorkflowStore.setState({ activeRuns: [], history: [], startWorkflow: vi.fn(async () => 'run') as never, addLog: vi.fn() as never })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  useEditorStore.setState(original.editor, true)
  useProjectStore.setState(original.project, true)
  useDraftStore.setState(original.drafts, true)
  useStageStore.setState(original.stage, true)
  useLLMStore.setState(original.llm, true)
  useWorkflowStore.setState(original.workflow, true)
})

describe('版本切换器', () => {
  it('切到另一稿时有未保存修改：先问；继续编辑什么都不动，保存并切换先写入再在原位置换上那一稿', async () => {
    const v1 = backend.addDraft({ status: 'archived', version: 1 })
    const v2 = backend.addDraft({ status: 'draft', version: 2, content: REVISED })
    await mount()
    await act(async () => openChapterPlan(5, '第五章', SESSION))
    await openDraft(v2.id)
    await type(`${REVISED}\n\n新加的一段。`)
    expect(await versions()).toEqual(['草稿 v2 · 当前'])
    await act(async () => page.getByRole('menuitemcheckbox', { name: /显示已归档/ }).click())
    await act(async () => page.getByRole('menuitemradio', { name: /已归档 v1/ }).click())
    await expect.element(page.getByRole('dialog', { name: '切换前保存修改？' })).toBeVisible()
    await click('继续编辑')
    expect([activeTab()?.filePath, activeTab()?.dirty, backend.writes('db:draft-update-content')]).toEqual([formatResourceUri({ kind: 'draft', id: v2.id }), true, []])

    expect(await versions()).toEqual(['草稿 v2 · 当前', '已归档 v1'])
    await act(async () => page.getByRole('menuitemradio', { name: /已归档 v1/ }).click())
    await click('保存并切换')
    await vi.waitFor(() => expect(activeTab()?.filePath).toBe(formatResourceUri({ kind: 'draft', id: v1.id })))
    expect(backend.writes('db:draft-update-content').map(args => args.slice(0, 2))).toEqual([[v2.id, `${REVISED}\n\n新加的一段。`]])
    expect(tabs().map(tab => tab.filePath ?? tab.chapterNumber)).toEqual([5, formatResourceUri({ kind: 'draft', id: v1.id })])
    await expect.element(page.getByText('已归档，只读')).toBeVisible()
  })

  it('放弃修改并切换：不写入，换上那一稿', async () => {
    backend.addDraft({ status: 'archived', version: 1 })
    const v2 = backend.addDraft({ status: 'draft', version: 2 })
    await mount()
    await openDraft(v2.id)
    await type('作者打的字')
    await versions()
    await act(async () => page.getByRole('menuitemcheckbox', { name: /显示已归档/ }).click())
    await act(async () => page.getByRole('menuitemradio', { name: /已归档 v1/ }).click())
    await click('放弃修改并切换')
    await vi.waitFor(() => expect(activeTab()?.draftStatus).toBe('archived'))
    expect([tabs().length, backend.writes('db:draft-update-content')]).toEqual([1, []])
  })

  it('删除这一稿：危险确认后删除，标签留在原位换成这一章剩下的那一稿，版本切换器不再列出它', async () => {
    const v1 = backend.addDraft({ status: 'draft', version: 1 })
    const v2 = backend.addDraft({ status: 'draft', version: 2, content: REVISED })
    await mount()
    await openDraft(v2.id)
    expect(await versions()).toEqual(['草稿 v2 · 当前', '草稿 v1'])
    await act(async () => page.getByRole('menuitemradio', { name: /草稿 v2/ }).click())
    await click('更多操作')
    await act(async () => page.getByRole('menuitem', { name: '删除这一稿…' }).click())
    await expect.element(page.getByRole('dialog', { name: '删除第 3 章 v2？' })).toBeVisible()
    await click('删除这一稿')
    await vi.waitFor(() => expect(activeTab()?.filePath).toBe(formatResourceUri({ kind: 'draft', id: v1.id })))
    expect(backend.writes('db:draft-delete').map(args => args[0])).toEqual([v2.id])
    expect([tabs().length, await versions()]).toEqual([1, ['草稿 v1 · 当前']])
  })
})

describe('标签与外壳', () => {
  it('切到别的标签再回来，未保存的正文还在', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    await mount()
    await openDraft(draft.id)
    const chapterTab = activeTab()!.id
    await type('还没保存的一句')
    await act(async () => openChapterPlan(5, '第五章', SESSION))
    await act(async () => useEditorStore.getState().setActiveTab(chapterTab))
    await expect.element(page.getByText('还没保存的一句')).toBeVisible()
    expect(activeTab()?.dirty).toBe(true)
  })

  it('审稿完成时命令打开的审稿报告标签改道到单章视图：不留独立标签，审稿侧页展开', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    await mount()
    await openDraft(draft.id)
    const review = backend.addReview(draft)
    const sourcePath = formatResourceUri({ kind: 'draft', id: draft.id })
    await act(async () => useEditorStore.getState().openFile({
      id: `review-${sourcePath}-1`, name: '审稿报告：第3章', type: 'review-report', content: AI_REVIEW, filePath: sourcePath,
      reviewReport: AI_REVIEW, chapterNumber: 3, chapterDir: 'ai-novel://draft/ch3', reviewId: review.id, projectKey: SESSION.projectPath,
    }))
    await expect.element(page.getByRole('heading', { name: '审稿报告' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: '按 2 项意见修稿' })).toBeVisible()
    expect(tabs().map(tab => [tab.type, tab.filePath])).toEqual([['chapter', sourcePath]])
  })

  it('修稿完成时命令打开的合并标签改道到单章视图的合并视图', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    await mount()
    await openDraft(draft.id)
    const revision = backend.addRevision(draft, 'refine')
    const sourcePath = formatResourceUri({ kind: 'draft', id: draft.id })
    await act(async () => useEditorStore.getState().openFile({
      id: `diff-${sourcePath}-${revision.id}`, name: '修稿合并：第3章', type: 'diff', filePath: sourcePath, originalContent: ORIGINAL, content: REVISED,
      revisionPath: formatResourceUri({ kind: 'revision', id: revision.id }), chapterNumber: 3, chapterDir: 'ai-novel://draft/ch3', projectKey: SESSION.projectPath,
    }))
    await expect.element(page.getByRole('button', { name: '完成合并' })).toBeVisible()
    expect(tabs().map(tab => tab.type)).toEqual(['chapter'])
  })

  it('写完一章后自动打开的草稿标签顶替这一章的待写标签，留在原位置', async () => {
    await mount()
    await act(async () => openChapterPlan(3, BLUEPRINT.title, SESSION))
    await act(async () => openChapterPlan(5, '第五章', SESSION))
    const draft = backend.addDraft({ status: 'draft' })
    await loadDrafts()
    const path = formatResourceUri({ kind: 'draft', id: draft.id })
    await act(async () => useEditorStore.getState().openFile({ id: path, name: '第3章 雨夜车站 v1', type: 'chapter', filePath: path, content: ORIGINAL, savedContent: ORIGINAL, projectKey: SESSION.projectPath }))
    await vi.waitFor(() => expect(tabs().map(tab => tab.filePath ?? tab.chapterNumber)).toEqual([path, 5]))
    expect(activeTab()?.filePath).toBe(path)
  })

  it('删除正文后清理没做完：这一章的待写视图提示并可以重试清理（F-070）', async () => {
    backend.state.incompleteDeletions = [{ operationId: 'deletion-1', chapterNumber: 3, draftId: 9, chapterTitle: '雨夜车站', status: 'failed',
      manuscriptStatus: 'failed', manuscriptError: '正文文件被占用', knowledgeStatus: 'done', legacyKnowledgeAuthorization: 'not-required' }]
    await mount()
    await act(async () => openChapterPlan(3, BLUEPRINT.title, SESSION))
    await expect.element(page.getByText('删除正文后的清理没有完成')).toBeVisible()
    await expect.element(page.getByText('正文文件被占用')).toBeVisible()
    await click('重试清理')
    await vi.waitFor(() => expect(backend.writes('chapter:retry-deletion').map(args => args[0])).toEqual(['deletion-1']))
    await expect.element(page.getByText('删除正文后的清理没有完成')).not.toBeInTheDocument()
  })
})

describe('定稿冲突与定稿进行中', () => {
  const conflict = { finalizationId: 'final-1', publicationStatus: 'published' as const }
  const markTab = (fields: { finalizationConflict?: typeof conflict; finalizationPublication?: 'pending' }) => act(async () => useEditorStore.setState(state => ({
    tabs: state.tabs.map(tab => tab.id === state.activeTabId ? { ...tab, ...fields } : tab),
  })))
  const finalizeItem = async () => {
    await click('更多操作')
    return page.getByRole('menuitem', { name: '定稿…' })
  }

  it('冲突保留时，「更多」里的定稿不可用', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    await mount()
    await openDraft(draft.id)
    await markTab({ finalizationConflict: conflict })
    await expect.element(page.getByText('已保留后续编辑')).toBeVisible()
    await expect.element(await finalizeItem()).toBeDisabled()
  })

  it('已修稿的稿在定稿进行中：主按钮不可用', async () => {
    const draft = backend.addDraft({ status: 'revised' })
    await mount()
    await openDraft(draft.id)
    await markTab({ finalizationPublication: 'pending' })
    await expect.element(page.getByRole('button', { name: '定稿', exact: true })).toBeDisabled()
  })

  it('确认框开着时冲突到达：确认定稿不可用，不启动定稿，冲突仍保留', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    await mount()
    await openDraft(draft.id)
    await act(async () => (await finalizeItem()).click())
    await expect.element(page.getByRole('dialog', { name: '定稿第 3 章？' })).toBeVisible()
    await markTab({ finalizationConflict: conflict })
    const confirm = page.getByRole('button', { name: '确认定稿' })
    await expect.element(confirm).toBeDisabled()
    await act(async () => confirm.element().dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(useWorkflowStore.getState().startWorkflow).not.toHaveBeenCalled()
    expect(activeTab()?.finalizationConflict).toEqual(conflict)
  })
})

describe('审稿侧页与运行侧页', () => {
  const reviewHeading = () => page.getByRole('heading', { name: '审稿报告' })
  const runHeading = () => page.getByRole('heading', { name: '运行' })

  it('同一时间只开一个：作者开着运行侧页时不抢；从「更多」打开审稿报告换掉运行侧页，纸面与侧页并排不重叠', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    backend.addReview(draft)
    await mount()
    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))
    await openDraft(draft.id)
    await expect.element(page.getByRole('button', { name: '按 2 项意见修稿' })).toBeVisible()
    await expect.element(runHeading()).toBeVisible()
    await expect.element(reviewHeading()).not.toBeInTheDocument()

    await click('更多操作')
    await act(async () => page.getByRole('menuitem', { name: '审稿报告' }).click())
    await expect.element(reviewHeading()).toBeVisible()
    await expect.element(runHeading()).not.toBeInTheDocument()
    const paper = host!.querySelector('.stage-ch-page')!.getBoundingClientRect()
    const sheet = host!.querySelector('.stage-ch-sheet-slot .pi-sheet')!.getBoundingClientRect()
    expect(paper.right).toBeLessThanOrEqual(sheet.left)

    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))
    await expect.element(runHeading()).toBeVisible()
    await expect.element(reviewHeading()).not.toBeInTheDocument()
  })

  it('审稿完成时收起跟着工作流打开的运行侧页，展开审稿侧页', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    await mount()
    await openDraft(draft.id)
    await act(async () => useStageStore.setState({ sheet: { kind: 'run', tab: 'active' } }))
    await expect.element(runHeading()).toBeVisible()
    const review = backend.addReview(draft)
    const sourcePath = formatResourceUri({ kind: 'draft', id: draft.id })
    await act(async () => useEditorStore.getState().openFile({
      id: `review-${sourcePath}-1`, name: '审稿报告：第3章', type: 'review-report', content: AI_REVIEW, filePath: sourcePath,
      reviewReport: AI_REVIEW, chapterNumber: 3, chapterDir: 'ai-novel://draft/ch3', reviewId: review.id, projectKey: SESSION.projectPath,
    }))
    await expect.element(reviewHeading()).toBeVisible()
    await expect.element(runHeading()).not.toBeInTheDocument()
  })
})
