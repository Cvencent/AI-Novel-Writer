import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ModelProfile, ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { blueprintWritePrefill } from '../../../../services/workflows/chapter-write-launch'
import type { ChapterBlueprint } from '../../../../services/workflows/directory-workflow'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { useWorkflowStore, type WorkflowDefinition } from '../../../../stores/workflow-store'
import ChapterCreationDialog from '../../../dialogs/ChapterCreationDialog'
import WriteChapterPopover from '../WriteChapterPopover'

const createChapterWorkflow = vi.hoisted(() => vi.fn())
// 用以 /src 开头的路径：检出路径含空格时（本机 Vibe Coding Project），浏览器模式匹配不到相对路径的模拟。
vi.mock('/src/services/workflows/chapter-workflow.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../services/workflows/chapter-workflow')>()
  createChapterWorkflow.mockImplementation(actual.createChapterWorkflow)
  return { ...actual, createChapterWorkflow }
})

const PROJECT_PATH = 'C:\\novels\\write-popover'
const originalLLM = useLLMStore.getState()
const originalProject = useProjectStore.getState()
const originalWorkflow = useWorkflowStore.getState()
const originalStage = useStageStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined
let startWorkflow: ReturnType<typeof vi.fn>
let writtenLogs: unknown[]
let continuityProjections: unknown[]
let exemptions: { stableFactKey: string; reason: string; revoked: boolean }[]

const BLUEPRINT: ChapterBlueprint = {
  chapterNumber: 5,
  title: '不要回头',
  role: '转折',
  purpose: '让林舟第一次违背信上的警告。',
  keyEvents: '阅读灯熄灭三次；老周查票时叫出林舟母亲的名字。',
  characters: ['林舟', '老周', '阿满'],
  suspenseHook: '座位上放着一张 1998 年的车票。',
  userGuidance: '母亲的声音只出现一次，不要解释来源。',
  notes: '列车驶出站台后，窗外停在 1998 年。',
  notesUpdatedAt: '',
}

function project(): ProjectData {
  return {
    id: 'write-popover',
    sessionLease: 'write-popover-lease',
    name: '雨夜列车',
    path: PROJECT_PATH,
    novelConfig: {
      genre: '悬疑', subGenre: '', targetAudience: '成人', totalChapters: 24, wordsPerChapter: 2600,
      plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '雨夜列车', worldSetting: '',
      goldenFinger: '', protagonistProfile: '', globalGuidance: '',
    },
    characterStates: '',
    createdAt: '',
    updatedAt: '',
  }
}

function model(id: string): ModelProfile {
  return {
    id, name: id.toUpperCase(), provider: 'custom', protocol: 'openai', modelName: id, apiKey: 'test-only-key',
    baseUrl: 'https://models.example/v1', temperature: 0.7, maxTokens: 4096, purposes: ['generation'],
  }
}

function installIpc() {
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'db:draft-authority-sequence') return {
      status: 'continuous', lastChapterNumber: 4, nextChapterNumber: 5, duplicateChapterNumbers: [], authorityFingerprint: 'e'.repeat(64),
    }
    if (channel === 'db:blueprint-get-all') return [BLUEPRINT]
    if (channel === 'db:blueprint-get') return BLUEPRINT
    if (channel === 'db:character-get-all') return [{ id: 1 }]
    if (channel === 'db:draft-get-finalized') return { chapterNumber: Number(args[0]) }
    if (channel === 'db:post-process-get-latest-run') return null
    if (channel === 'db:continuity-list-before') return continuityProjections
    if (channel === 'db:consistency-exemption-list') return exemptions
    if (channel === 'db:consistency-exemption-save') {
      exemptions = [...exemptions, { stableFactKey: String(args[0]), reason: String(args[1]), revoked: false }]
      return { success: true }
    }
    if (channel === 'db:consistency-exemption-revoke') {
      exemptions = exemptions.map(item => item.stableFactKey === args[0] ? { ...item, revoked: true } : item)
      return { success: true }
    }
    if (channel === 'fs:read-json') return { success: false }
    if (channel === 'fs:write-json') {
      writtenLogs.push(args[1])
      return { success: true }
    }
    throw new Error(`unexpected IPC ${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn(), setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn(() => 0) },
  })
}

/** 一次启动交给工作流的全部输入：ChapterInfo、选项，以及工作流定义里可比较的字段。 */
function launched() {
  expect(createChapterWorkflow).toHaveBeenCalledOnce()
  expect(startWorkflow).toHaveBeenCalledOnce()
  const [chapterInfo, session, options] = createChapterWorkflow.mock.calls[0]
  const definition = startWorkflow.mock.calls[0][0] as WorkflowDefinition
  const { steps, onComplete, projectSession, ...fields } = definition
  const [log] = writtenLogs as { lastUsed: unknown }[]
  return {
    chapterInfo, session, options, fields, projectSession,
    steps: steps.map(step => step.name), onComplete: onComplete?.message,
    stepByStep: startWorkflow.mock.calls[0][1],
    savedParams: log?.lastUsed,
  }
}

async function render(node: React.ReactNode) {
  await act(async () => root?.render(<div className="paper-ink">{node}</div>))
}

function reset() {
  createChapterWorkflow.mockClear()
  startWorkflow.mockClear()
  writtenLogs = []
}

beforeEach(async () => {
  await page.viewport(1280, 900)
  createChapterWorkflow.mockClear()
  writtenLogs = []
  continuityProjections = []
  exemptions = []
  startWorkflow = vi.fn(async () => 'write-popover-run')
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: project() })
  setActiveProjectSessionContext({ projectId: 'write-popover', leaseId: 'write-popover-lease', projectPath: PROJECT_PATH })
  useLLMStore.setState({ models: [model('glm'), model('grok')], defaultModelId: 'grok', loaded: true })
  useWorkflowStore.setState({ activeRuns: [], history: [], startWorkflow: startWorkflow as never, addLog: vi.fn() as never })
  useStageStore.setState({ writeRequest: null })
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
  useLLMStore.setState(originalLLM)
  useProjectStore.setState(originalProject)
  useWorkflowStore.setState(originalWorkflow)
  useStageStore.setState(originalStage)
})

describe('写作此章弹层', () => {
  it('同一蓝图下直接写作，交给工作流的参数与旧的章节创作对话框完全一致', async () => {
    const prefill = blueprintWritePrefill(BLUEPRINT)
    await render(<ChapterCreationDialog isOpen onClose={vi.fn()} prefill={{ ...prefill, chapterNumber: BLUEPRINT.chapterNumber }} />)
    await expect.element(page.getByRole('button', { name: '开始创作' })).toBeEnabled()
    await act(async () => page.getByRole('button', { name: '开始创作' }).click())
    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
    const fromDialog = launched()

    reset()
    await act(async () => root?.render(null))
    await render(<WriteChapterPopover chapterNumber={BLUEPRINT.chapterNumber} blueprint={prefill} label="写第 5 章" align="start" />)
    await act(async () => page.getByRole('button', { name: '写第 5 章' }).click())
    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
    const fromPopover = launched()

    expect(fromPopover).toEqual(fromDialog)
    expect(fromPopover.chapterInfo).toEqual({
      projectPath: PROJECT_PATH,
      chapterNumber: 5,
      title: '不要回头',
      role: '转折',
      purpose: '让林舟第一次违背信上的警告。',
      characters: ['林舟', '老周', '阿满'],
      keyEvents: '阅读灯熄灭三次；老周查票时叫出林舟母亲的名字。',
      userGuidance: '母亲的声音只出现一次，不要解释来源。',
      wordsTarget: 2600,
      knowledgeQueryHint: undefined,
    })
    expect(fromPopover.options).toEqual({ generationModelId: 'grok' })
    expect(page.getByRole('dialog', { name: '本次写作选项' }).query()).toBeNull()
  })

  it('弹层改了模型、指导与检索关键词时，与旧对话框改同样三项的结果一致', async () => {
    const prefill = blueprintWritePrefill(BLUEPRINT)
    await render(<ChapterCreationDialog isOpen onClose={vi.fn()} prefill={{ ...prefill, chapterNumber: BLUEPRINT.chapterNumber }} />)
    await expect.element(page.getByRole('button', { name: '开始创作' })).toBeEnabled()
    await act(async () => page.getByLabelText('本次创作模型').selectOptions('glm'))
    await act(async () => page.getByPlaceholder(/特殊要求/).fill('结尾停在回头之前。'))
    await act(async () => page.getByPlaceholder(/剑法传承/).fill('列车时刻表'))
    await act(async () => page.getByRole('button', { name: '开始创作' }).click())
    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
    const fromDialog = launched()

    reset()
    await act(async () => root?.render(null))
    await render(<WriteChapterPopover chapterNumber={BLUEPRINT.chapterNumber} blueprint={prefill} label="写第 5 章" align="start" />)
    await act(async () => page.getByRole('button', { name: '本次写作选项' }).click())
    const popover = page.getByRole('dialog', { name: '本次写作选项' })
    await expect.element(popover.getByLabelText(/作者微操指导/)).toHaveValue('母亲的声音只出现一次，不要解释来源。')
    await act(async () => popover.getByLabelText(/本次模型/).selectOptions('glm'))
    await act(async () => popover.getByLabelText(/作者微操指导/).fill('结尾停在回头之前。'))
    await popover.getByText('更多').click()
    await act(async () => popover.getByLabelText(/知识库检索关键词/).fill('列车时刻表'))
    await act(async () => page.getByRole('button', { name: '写第 5 章' }).click())
    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())

    expect(launched()).toEqual(fromDialog)
    expect(fromDialog.chapterInfo).toMatchObject({ userGuidance: '结尾停在回头之前。', knowledgeQueryHint: '列车时刻表' })
    expect(fromDialog.options).toEqual({ generationModelId: 'glm' })
  })

  it('选项只用于这一次：写完后再打开，指导、模型与检索关键词回到蓝图与默认', async () => {
    await render(<WriteChapterPopover chapterNumber={5} blueprint={blueprintWritePrefill(BLUEPRINT)} label="写第 5 章" align="start" />)
    await act(async () => page.getByRole('button', { name: '本次写作选项' }).click())
    const popover = page.getByRole('dialog', { name: '本次写作选项' })
    await act(async () => popover.getByLabelText(/本次模型/).selectOptions('glm'))
    await act(async () => popover.getByLabelText(/作者微操指导/).fill('只用于第 5 章的指导'))
    await act(async () => popover.getByText('更多').click())
    await act(async () => popover.getByLabelText(/知识库检索关键词/).fill('列车时刻表'))
    await act(async () => page.getByRole('button', { name: '写第 5 章' }).click())
    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())

    await act(async () => page.getByRole('button', { name: '本次写作选项' }).click())
    await expect.element(popover.getByLabelText(/作者微操指导/)).toHaveValue(BLUEPRINT.userGuidance)
    await expect.element(popover.getByLabelText(/本次模型/)).toHaveValue('grok')
    await act(async () => popover.getByText('更多').click())
    await expect.element(popover.getByLabelText(/知识库检索关键词/)).toHaveValue('')
  })

  it('弹层只有本次模型、作者微操指导与折叠的更多，不重复蓝图字段', async () => {
    await render(<WriteChapterPopover chapterNumber={5} blueprint={blueprintWritePrefill(BLUEPRINT)} label="写第 5 章" align="start" />)
    await act(async () => page.getByRole('button', { name: '本次写作选项' }).click())
    const popover = page.getByRole('dialog', { name: '本次写作选项' })
    await expect.element(popover).toBeVisible()
    const labels = [...popover.element().querySelectorAll('label')].map(label => label.textContent)
    expect(labels).toEqual(['本次模型 只用于这一次', '作者微操指导 可选', '知识库检索关键词 可选'])
    expect(popover.element().querySelector('details')?.open).toBe(false)
    expect(popover.element().textContent).not.toMatch(/章节号|目标字数|章节定位|出场角色|关键事件/)
  })

  it('一致性预检有提醒时不启动，在弹层里说明；仅本次忽略后才开始写', async () => {
    continuityProjections = [{
      draftId: 1, chapterNumber: 1, chapterTitle: '终局', chapterNotes: '老周死亡',
      source: { draftId: 1, finalizationId: 'finalization-1', chapterNumber: 1, contentHash: 'a'.repeat(64) },
      sourceStatus: 'current',
      facts: [{ category: 'character-state', entities: ['老周'], statement: '老周已经死亡。', sourceChapter: 1, evidence: '老周停止了呼吸。' }],
    }]
    await render(<WriteChapterPopover chapterNumber={5} blueprint={blueprintWritePrefill(BLUEPRINT)} label="写第 5 章" align="start" />)
    await act(async () => page.getByRole('button', { name: '写第 5 章' }).click())
    const popover = page.getByRole('dialog', { name: '本次写作选项' })
    await expect.element(popover.getByRole('region', { name: '一致性预检' })).toBeVisible()
    await expect.element(popover.getByText(/一致性预检 · 1 条线索提醒/)).toBeVisible()
    expect(startWorkflow).not.toHaveBeenCalled()

    await act(async () => popover.getByRole('button', { name: '改蓝图后重检' }).click())
    await expect.element(popover.getByRole('region', { name: '一致性预检' })).toBeVisible()
    expect(startWorkflow).not.toHaveBeenCalled()

    await act(async () => popover.getByRole('button', { name: '仅本次忽略' }).click())
    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
    expect(exemptions).toEqual([])
  })

  it('保存安排后重检并开始写；已保存的安排可以在弹层里撤销', async () => {
    continuityProjections = [{
      draftId: 1, chapterNumber: 1, chapterTitle: '终局', chapterNotes: '老周死亡',
      source: { draftId: 1, finalizationId: 'finalization-1', chapterNumber: 1, contentHash: 'a'.repeat(64) },
      sourceStatus: 'current',
      facts: [{ category: 'character-state', entities: ['老周'], statement: '老周已经死亡。', sourceChapter: 1, evidence: '老周停止了呼吸。' }],
    }]
    await render(<WriteChapterPopover chapterNumber={5} blueprint={blueprintWritePrefill(BLUEPRINT)} label="写第 5 章" align="start" />)
    await act(async () => page.getByRole('button', { name: '写第 5 章' }).click())
    const popover = page.getByRole('dialog', { name: '本次写作选项' })
    await act(async () => popover.getByLabelText('安排说明').fill('老周以幽灵身份出现，是刻意安排。'))
    await act(async () => popover.getByRole('button', { name: '保存安排' }).click())
    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
    expect(exemptions).toMatchObject([{ reason: '老周以幽灵身份出现，是刻意安排。', revoked: false }])

    await act(async () => page.getByRole('button', { name: '本次写作选项' }).click())
    await popover.getByText('已保存安排（1）').click()
    await act(async () => popover.getByRole('button', { name: '撤销' }).click())
    await vi.waitFor(() => expect(exemptions).toMatchObject([{ revoked: true }]))
  })

  it('前置条件不满足时弹层打开并写明原因，不启动', async () => {
    await render(<WriteChapterPopover chapterNumber={7} blueprint={blueprintWritePrefill(BLUEPRINT)} label="写第 7 章" align="start" />)
    await act(async () => page.getByRole('button', { name: '写第 7 章' }).click())
    await expect.element(page.getByRole('dialog', { name: '本次写作选项' }).getByRole('alert')).toHaveTextContent('当前权威定稿之后只能创作第 5 章')
    expect(startWorkflow).not.toHaveBeenCalled()
  })

  it('定稿后打开下一章等请求：挂着这一章按钮的弹层自己打开并清掉请求', async () => {
    await render(<WriteChapterPopover chapterNumber={5} blueprint={blueprintWritePrefill(BLUEPRINT)} label="写第 5 章" align="start" />)
    expect(page.getByRole('dialog', { name: '本次写作选项' }).query()).toBeNull()
    await act(async () => useStageStore.setState({ writeRequest: { chapterNumber: 5 } }))
    await expect.element(page.getByRole('dialog', { name: '本次写作选项' })).toBeVisible()
    expect(useStageStore.getState().writeRequest).toBeNull()
    expect(startWorkflow).not.toHaveBeenCalled()
  })
})
