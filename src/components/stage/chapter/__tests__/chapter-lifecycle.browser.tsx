import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { parseHumanConfirmedReviewSnapshot } from '../../../../shared/human-confirmed-review'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useDraftStore } from '../../../../stores/draft-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { openChapterPlan } from '../../../../stores/navigation/stage-navigation'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import { openDraftTab } from '../../../../stores/open-draft-tab'
import StageWorkspace from '../../StageWorkspace'
import { BLUEPRINT, ORIGINAL, REVISED, SESSION, chapterProject, createChapterBackend, generationModel } from './chapter-fixture'

const workflows = vi.hoisted(() => ({
  createChapterWorkflow: vi.fn(),
  createReviewOnlyWorkflow: vi.fn(),
  createRefineOnlyWorkflow: vi.fn(),
  createRefineFromReviewWorkflow: vi.fn(),
  createFinalizeWorkflow: vi.fn(),
  createRepairFinalizeWorkflow: vi.fn(),
}))
// 用以 /src 开头的路径：检出路径含空格时（本机 Vibe Coding Project），浏览器模式匹配不到相对路径的模拟。
vi.mock('/src/services/workflows/chapter-workflow.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../services/workflows/chapter-workflow')>()
  for (const [name, spy] of Object.entries(workflows)) spy.mockImplementation(actual[name as keyof typeof workflows] as never)
  return { ...actual, ...workflows }
})

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const original = {
  editor: useEditorStore.getState(), project: useProjectStore.getState(), drafts: useDraftStore.getState(),
  stage: useStageStore.getState(), llm: useLLMStore.getState(), workflow: useWorkflowStore.getState(),
}

let root: Root | undefined
let host: HTMLDivElement | undefined
let backend: ReturnType<typeof createChapterBackend>
let startWorkflow: ReturnType<typeof vi.fn>

async function mount() {
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'display:flex;flex-direction:column;height:900px;width:1028px'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<StageWorkspace library={false} focus={false} />))
}

/** 按流程脊的方式载入这一章的稿，再打开它的单章视图。 */
async function openDraft(draftId: number) {
  await act(async () => { await useDraftStore.getState().loadAllDrafts(SESSION.projectPath, SESSION) })
  const draft = Object.values(useDraftStore.getState().draftsByChapter).flat().find(candidate => candidate.id === draftId)!
  await act(async () => { await openDraftTab(draft, '第 3 章 · 雨夜车站', SESSION) })
}

const activeTab = () => useEditorStore.getState().tabs.find(tab => tab.id === useEditorStore.getState().activeTabId)
const click = (name: string | RegExp) => act(async () => page.getByRole('button', { name, exact: typeof name === 'string' }).click())
/** 勾选框藏在纸墨的方框后面，作者点的是整行标签。 */
const toggle = (name: RegExp) => act(async () => page.getByRole('checkbox', { name }).element().closest('label')!.click())
/** 工作流定义里能比较的字段：类型与标题。 */
const started = () => startWorkflow.mock.calls.map(([definition]) => ({ type: definition.type, title: definition.title }))

beforeEach(async () => {
  await page.viewport(1280, 900)
  backend = createChapterBackend()
  backend.install()
  for (const spy of Object.values(workflows)) spy.mockClear()
  startWorkflow = vi.fn(async () => 'chapter-run')
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: chapterProject() })
  setActiveProjectSessionContext(SESSION)
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useStageStore.setState({ work: { session: SESSION, architecture: {}, blueprints: [{ chapterNumber: 3, title: BLUEPRINT.title }] }, chapterRequest: null, writeRequest: null, sheet: null })
  useLLMStore.setState({ models: [generationModel('glm'), generationModel('grok')], defaultModelId: 'grok', loaded: true })
  useWorkflowStore.setState({ activeRuns: [], history: [], startWorkflow: startWorkflow as never, addLog: vi.fn() as never, getResourceConflict: (() => null) as never })
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

describe('单章视图的主按钮随五种状态变化', () => {
  it('待写：主按钮是写作此章，按本章蓝图启动写作工作流', async () => {
    await mount()
    await act(async () => openChapterPlan(3, BLUEPRINT.title, SESSION))
    await expect.element(page.getByRole('heading', { name: '本章蓝图' })).toBeVisible()
    await click('写作此章')
    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
    const [chapterInfo] = workflows.createChapterWorkflow.mock.calls[0]
    expect({ number: chapterInfo.chapterNumber, title: chapterInfo.title, purpose: chapterInfo.purpose, characters: chapterInfo.characters })
      .toEqual({ number: 3, title: '雨夜车站', purpose: BLUEPRINT.purpose, characters: ['林舟', '老周'] })
    expect(started()[0].type).toBe('chapter_creation')
  })

  it('草稿：主按钮是 AI 审稿，按勾选的检查维度对当前正文启动审稿', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    await mount()
    await openDraft(draft.id)
    await expect.element(page.getByRole('button', { name: 'AI 审稿', exact: true })).toBeVisible()
    await click('检查维度')
    await toggle(/角色状态/)
    await click('AI 审稿')
    await vi.waitFor(() => expect(workflows.createReviewOnlyWorkflow).toHaveBeenCalledOnce())
    const [params] = workflows.createReviewOnlyWorkflow.mock.calls[0]
    expect({ draftContent: params.draftContent, reviewFocus: params.reviewFocus, source: params.sourceDraft.id })
      .toEqual({ draftContent: ORIGINAL, reviewFocus: '剧情连贯性、剧情合理性、前后章节串联', source: draft.id })
    expect(started()).toHaveLength(1)
  })

  it('已审稿：勾选数与「按 N 项意见修稿」同步；点它先确认清单，再按这份清单与本次模型修稿', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    backend.addReview(draft)
    await mount()
    await openDraft(draft.id)
    await expect.element(page.getByRole('button', { name: '按 2 项意见修稿' })).toBeVisible()
    await expect.element(page.getByText('2 / 3')).toBeVisible()
    await toggle(/本章必现/)
    await expect.element(page.getByRole('button', { name: '按 3 项意见修稿' })).toBeVisible()
    await expect.element(page.getByText('3 / 3')).toBeVisible()

    await click('修稿选项')
    await act(async () => page.getByRole('combobox', { name: /本次修稿模型/ }).selectOptions('glm'))
    await click('按 3 项意见修稿')
    await vi.waitFor(() => expect(workflows.createRefineFromReviewWorkflow).toHaveBeenCalledOnce())
    const [created] = backend.writes('db:review-create')
    const confirmed = parseHumanConfirmedReviewSnapshot((created[0] as { content: string }).content)!
    expect(confirmed.items.filter(item => item.decision === 'apply').map(item => item.category)).toEqual(['前后矛盾', '节奏', '本章必现'])
    const [params] = workflows.createRefineFromReviewWorkflow.mock.calls[0]
    expect({ reviewSourceId: params.reviewSourceId, model: params.generationModelId, content: params.draftContent })
      .toEqual({ reviewSourceId: backend.state.reviews.at(-1)!.id, model: 'glm', content: ORIGINAL })
  })

  it('人工意见进入修稿输入：添加我的意见后，它在确认的清单里并被纳入', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    backend.addReview(draft)
    await mount()
    await openDraft(draft.id)
    await click('添加我的意见')
    await act(async () => page.getByRole('textbox', { name: '审稿问题' }).fill('结尾要停在林舟回头之前。'))
    await click('按 3 项意见修稿')
    await vi.waitFor(() => expect(workflows.createRefineFromReviewWorkflow).toHaveBeenCalledOnce())
    const [params] = workflows.createRefineFromReviewWorkflow.mock.calls[0]
    const confirmed = parseHumanConfirmedReviewSnapshot(params.confirmedReviewContent)!
    expect(confirmed.items.filter(item => item.origin === 'author').map(item => [item.description, item.decision]))
      .toEqual([['结尾要停在林舟回头之前。', 'apply']])
  })

  it('有待合并修稿：直接摆出合并视图，完成合并提交选择的正文并启动合并后复验', async () => {
    const draft = backend.addDraft({ status: 'draft' })
    backend.addReview(draft)
    const revision = backend.addRevision(draft)
    await mount()
    await openDraft(draft.id)
    await expect.element(page.getByRole('button', { name: '完成合并' })).toBeVisible()
    await click('全部用修稿')
    await click('完成合并')
    await vi.waitFor(() => expect(workflows.createReviewOnlyWorkflow).toHaveBeenCalledOnce())
    const [merge] = backend.writes('db:revision-merge')
    expect(merge[0]).toMatchObject({ revisionId: revision.id, targetDraftId: draft.id, expectedDraftContent: ORIGINAL, mergedContent: REVISED })
    const [recheck] = workflows.createReviewOnlyWorkflow.mock.calls[0]
    expect({ cycle: recheck.reviewCycleId, hash: recheck.expectedMergedHash, content: recheck.draftContent })
      .toEqual({ cycle: 'cycle-1', hash: 'b'.repeat(64), content: REVISED })
    await expect.element(page.getByRole('button', { name: '定稿', exact: true })).toBeVisible()
    expect(activeTab()?.content).toBe(REVISED)
  })

  it('已修稿：主按钮是定稿，确认后以当前正文（含未保存修改）提交定稿', async () => {
    const draft = backend.addDraft({ status: 'revised' })
    await mount()
    await openDraft(draft.id)
    await act(async () => useEditorStore.getState().updateTabContent(activeTab()!.id, `${ORIGINAL}\n\n他回头了。`))
    await click('定稿')
    await expect.element(page.getByRole('dialog', { name: '定稿第 3 章？' })).toBeVisible()
    await expect.element(page.getByText('还没保存的修改会一并定稿')).toBeVisible()
    await click('确认定稿')
    await vi.waitFor(() => expect(workflows.createFinalizeWorkflow).toHaveBeenCalledOnce())
    const [params] = workflows.createFinalizeWorkflow.mock.calls[0]
    expect({ content: params.draftContent, snapshot: params.snapshot.content, draftId: params.snapshot.draftId })
      .toEqual({ content: `${ORIGINAL}\n\n他回头了。`, snapshot: `${ORIGINAL}\n\n他回头了。`, draftId: draft.id })
  })

  it('定稿：正文只读，列出后处理各步；重试失败步骤只重跑失败的，单步重试只跑那一步', async () => {
    const draft = backend.addDraft({ status: 'finalized' })
    backend.state.postProcess = { steps: [
      { stepKey: 'chapter_notes', label: '章节剧情要点', ok: true },
      { stepKey: 'character_cards', label: '角色状态更新', ok: false, errorMsg: '模型长时间没有响应', attemptCount: 1 },
      { stepKey: 'kb_import', label: '导入知识库', ok: true },
    ] }
    await mount()
    await openDraft(draft.id)
    await expect.element(page.getByText('已定稿，只读')).toBeVisible()
    await expect.element(page.getByText('2 / 3 完成')).toBeVisible()
    expect(host!.querySelector('.stage-ch-prose .cm-content')?.getAttribute('contenteditable')).toBe('false')
    await click('重试失败步骤')
    await vi.waitFor(() => expect(workflows.createRepairFinalizeWorkflow).toHaveBeenCalledOnce())
    await click('重试')
    await vi.waitFor(() => expect(workflows.createRepairFinalizeWorkflow).toHaveBeenCalledTimes(2))
    expect(workflows.createRepairFinalizeWorkflow.mock.calls.map(call => [call[0], call[3]])).toEqual([[3, undefined], [3, 'character_cards']])
  })
})
