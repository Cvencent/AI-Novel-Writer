import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import '../../../../index.css'

import type { ModelProfile, ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { blueprintWritePrefill } from '../../../../services/workflows/chapter-write-launch'
import type { ChapterBlueprint } from '../../../../services/workflows/directory-workflow'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { useWorkflowStore, type WorkflowDefinition } from '../../../../stores/workflow-store'
import BatchWriteDialog from '../../blueprint/BatchWriteDialog'
import WriteChapterPopover from '../WriteChapterPopover'

const createChapterWorkflow = vi.hoisted(() => vi.fn())
// 用以 /src 开头的路径：检出路径含空格时（本机 Vibe Coding Project），浏览器模式匹配不到相对路径的模拟。
vi.mock('/src/services/workflows/chapter-workflow.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../services/workflows/chapter-workflow')>()
  createChapterWorkflow.mockImplementation(actual.createChapterWorkflow)
  return { ...actual, createChapterWorkflow }
})

const PROJECT_PATH = 'C:\\novels\\write-popover'
const SESSION = { projectId: 'write-popover', leaseId: 'write-popover-lease', projectPath: PROJECT_PATH }
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
let exemptionSave: () => Promise<{ success: boolean; error?: string }>
let continuityGate: Promise<void> | null = null
// issue #55：让守卫按「第 N 章后处理未完成」阻断，用来断言弹层给出出口。
let blockedPreviousChapter: number | null = null
// issue #224：同章已有草稿的簿记提示——测试用它摆出「本章已有未定稿草稿」的现场。
let draftListOverride: Array<{ version: number; status: string; wordCount: number }> | null = null

const DEAD_KEEPER = [{
  draftId: 1, chapterNumber: 1, chapterTitle: '终局', chapterNotes: '老周死亡',
  source: { draftId: 1, finalizationId: 'finalization-1', chapterNumber: 1, contentHash: 'a'.repeat(64) },
  sourceStatus: 'current',
  facts: [{ category: 'character-state', entities: ['老周'], statement: '老周已经死亡。', sourceChapter: 1, evidence: '老周停止了呼吸。' }],
}]

const BLUEPRINT: ChapterBlueprint = {
  chapterNumber: 5,
  title: '不要回头',
  role: '转折',
  purpose: '让林舟第一次违背信上的警告。',
  keyEvents: '阅读灯熄灭三次；老周查票时叫出林舟母亲的名字。',
  characters: ['林舟', '老周', '阿满'],
  suspenseHook: '座位上放着一张 1998 年的车票。',
  costsAndTurns: '林舟错过了下车的时机。',
  foreshadowing: '埋下车票与母亲名字的关联。',
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
      status: 'continuous', lastChapterNumber: blockedPreviousChapter ?? 4, nextChapterNumber: blockedPreviousChapter ? blockedPreviousChapter + 1 : 5,
      duplicateChapterNumbers: [], authorityFingerprint: 'e'.repeat(64),
    }
    if (channel === 'db:blueprint-get-all') {
      return blockedPreviousChapter ? [BLUEPRINT, { ...BLUEPRINT, chapterNumber: blockedPreviousChapter + 1 }] : [BLUEPRINT]
    }
    if (channel === 'db:blueprint-get') return BLUEPRINT
    if (channel === 'db:character-get-all') return [{ id: 1 }]
    /**
     * issue #211：这个 mock 缺了名册通道（`readConsistencyPreflight` 走
     * `db:character-roster-read`）。缺了它 → `.catch(() => null)` → 名册为空 →
     * 「未登记角色」把蓝图里三个人全报出来、`findAppearanceGaps` 再报「没有外貌/动机」，
     * 于是首次点击按设计只弹预检（#53），`startWorkflow` 自然 0 次调用。
     *
     * **点击没有被吞**——是这个 mock 与真实 IPC 面对不上：真实项目的角色卡有名册、
     * 有动机与外貌，这一章就不会带预检。把卡填全，测试才回到它本来要断言的
     * 「同一蓝图下直接写作」那条路径上。
     */
    if (channel === 'db:character-roster-read') return {
      entries: [
        { name: '林舟', role: 'protagonist', motivation: '想查清母亲留下的那张车票。', appearance: '瘦高，左手无名指缺半节，常穿深灰夹克。' },
        { name: '老周', role: 'supporting', motivation: '把当年的事压住。', appearance: '矮胖，戴旧式圆框眼镜，制服领口发亮。' },
        { name: '阿满', role: 'supporting', motivation: '跟着林舟。', appearance: '十七八岁，短发，右耳有一颗痣。' },
      ],
    }
    if (channel === 'db:draft-get-finalized') return { chapterNumber: Number(args[0]) }
    if (channel === 'db:post-process-get-latest-run') {
      if (!blockedPreviousChapter) return null
      return { id: 'run-blocked', sourceLabel: `第${blockedPreviousChapter}章定稿`, createdAt: '', updatedAt: '', allCriticalPassed: false }
    }
    if (channel === 'db:post-process-get-steps') {
      if (!blockedPreviousChapter) return []
      return [{ stepKey: 'chapter_notes', label: '章节剧情要点', critical: true, ok: false, errorMsg: '' }]
    }
    if (channel === 'db:continuity-list-before') {
      await continuityGate
      return continuityProjections
    }
    if (channel === 'db:consistency-exemption-list') return exemptions
    if (channel === 'db:consistency-exemption-save') {
      const result = await exemptionSave()
      if (result.success) exemptions = [...exemptions, { stableFactKey: String(args[0]), reason: String(args[1]), revoked: false }]
      return result
    }
    if (channel === 'db:consistency-exemption-revoke') {
      exemptions = exemptions.map(item => item.stableFactKey === args[0] ? { ...item, revoked: true } : item)
      return { success: true }
    }
    if (channel === 'fs:read-json') return { success: false }
    if (channel === 'db:draft-list') return draftListOverride ?? []
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

/** 写作按钮与页面里一样靠右，弹层向左展开。 */
async function render(node: React.ReactNode) {
  await act(async () => root?.render(<div className="paper-ink"><div style={{ display: 'flex', justifyContent: 'flex-end' }}>{node}</div></div>))
}

beforeEach(async () => {
  await page.viewport(1280, 900)
  // 视口变化的 resize 事件可能晚于渲染才到，浮层收到 resize 会关闭：先等它派发完。
  await vi.waitFor(() => expect([window.innerWidth, window.innerHeight]).toEqual([1280, 900]))
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  createChapterWorkflow.mockClear()
  writtenLogs = []
  continuityProjections = []
  exemptions = []
  exemptionSave = async () => ({ success: true })
  continuityGate = null
  startWorkflow = vi.fn(async () => 'write-popover-run')
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: project() })
  setActiveProjectSessionContext(SESSION)
  useLLMStore.setState({ models: [model('glm'), model('grok')], defaultModelId: 'grok', loaded: true })
  useWorkflowStore.setState({ activeRuns: [], history: [], startWorkflow: startWorkflow as never, addLog: vi.fn() as never })
  useStageStore.setState({ writeRequest: null })
  draftListOverride = null
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

/** 旧的章节创作对话框在同一蓝图下交给工作流的全部输入（RD-10 删除对话框前从它取得），弹层必须与它一致。 */
function expectedLaunch(changes: { generationModelId: string; userGuidance: string; knowledgeQueryHint?: string }) {
  const { generationModelId, userGuidance, knowledgeQueryHint } = changes
  return {
    chapterInfo: {
      projectPath: PROJECT_PATH, chapterNumber: 5, title: '不要回头', role: '转折', purpose: '让林舟第一次违背信上的警告。',
      characters: ['林舟', '老周', '阿满'], keyEvents: '阅读灯熄灭三次；老周查票时叫出林舟母亲的名字。',
      suspenseHook: '座位上放着一张 1998 年的车票。', costsAndTurns: '林舟错过了下车的时机。',
      foreshadowing: '埋下车票与母亲名字的关联。',
      userGuidance, wordsTarget: 2600, knowledgeQueryHint,
    },
    session: SESSION,
    options: { generationModelId },
    fields: { type: 'chapter_creation', projectPath: PROJECT_PATH, uiLocale: 'zh-CN', generationModelId, chapterWordsTarget: 2600,
      resourceKeys: ['chapter:5'], readResourceKeys: ['novel-config', 'architecture', 'blueprints'], title: '第 5 章 · 写稿' },
    projectSession: SESSION,
    steps: ['写稿'],
    onComplete: '第5章草稿已生成',
    stepByStep: false,
    savedParams: { chapterNumber: 5, title: '不要回头', role: '转折', purpose: '让林舟第一次违背信上的警告。',
      keyEvents: '阅读灯熄灭三次；老周查票时叫出林舟母亲的名字。', characters: '林舟、老周、阿满', userGuidance, wordsTarget: 2600 },
  }
}

describe('写作此章弹层', () => {
  it('同一蓝图下直接写作，交给工作流的参数与旧的章节创作对话框一致', async () => {
    const prefill = blueprintWritePrefill(BLUEPRINT)
    await render(<WriteChapterPopover chapterNumber={BLUEPRINT.chapterNumber} blueprint={prefill} label="写第 5 章" />)
    await act(async () => page.getByRole('button', { name: '写第 5 章' }).click())
    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())

    expect(launched()).toEqual(expectedLaunch({ generationModelId: 'grok', userGuidance: '母亲的声音只出现一次，不要解释来源。' }))
    expect(page.getByRole('dialog', { name: '本次写作选项' }).query()).toBeNull()
  })

  it('弹层改了模型、指导与检索关键词时，结果与旧对话框改同样三项一致', async () => {
    const prefill = blueprintWritePrefill(BLUEPRINT)
    await render(<WriteChapterPopover chapterNumber={BLUEPRINT.chapterNumber} blueprint={prefill} label="写第 5 章" />)
    await act(async () => page.getByRole('button', { name: '本次写作选项' }).click())
    const popover = page.getByRole('dialog', { name: '本次写作选项' })
    await expect.element(popover.getByLabelText(/作者微操指导/)).toHaveValue('母亲的声音只出现一次，不要解释来源。')
    await act(async () => popover.getByLabelText(/本次模型/).selectOptions('glm'))
    await act(async () => popover.getByLabelText(/作者微操指导/).fill('结尾停在回头之前。'))
    await popover.getByText('更多').click()
    await act(async () => popover.getByLabelText(/知识库检索关键词/).fill('列车时刻表'))
    await act(async () => page.getByRole('button', { name: '写第 5 章' }).click())
    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())

    expect(launched()).toEqual(expectedLaunch({ generationModelId: 'glm', userGuidance: '结尾停在回头之前。', knowledgeQueryHint: '列车时刻表' }))
  })

  it('选项只用于这一次：写完后再打开，指导、模型与检索关键词回到蓝图与默认', async () => {
    await render(<WriteChapterPopover chapterNumber={5} blueprint={blueprintWritePrefill(BLUEPRINT)} label="写第 5 章" />)
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
    await render(<WriteChapterPopover chapterNumber={5} blueprint={blueprintWritePrefill(BLUEPRINT)} label="写第 5 章" />)
    await act(async () => page.getByRole('button', { name: '本次写作选项' }).click())
    const popover = page.getByRole('dialog', { name: '本次写作选项' })
    await expect.element(popover).toBeVisible()
    const labels = [...popover.element().querySelectorAll('label')].map(label => label.textContent)
    expect(labels).toEqual(['本次模型 只用于这一次', '作者微操指导 可选', '知识库检索关键词 可选'])
    expect(popover.element().querySelector('details')?.open).toBe(false)
    expect(popover.element().textContent).not.toMatch(/章节号|目标字数|章节定位|出场角色|关键事件/)
  })

  it('一致性预检有提醒时首次点击只弹层说明；主按钮再点即带提醒开写', async () => {
    continuityProjections = [{
      draftId: 1, chapterNumber: 1, chapterTitle: '终局', chapterNotes: '老周死亡',
      source: { draftId: 1, finalizationId: 'finalization-1', chapterNumber: 1, contentHash: 'a'.repeat(64) },
      sourceStatus: 'current',
      facts: [{ category: 'character-state', entities: ['老周'], statement: '老周已经死亡。', sourceChapter: 1, evidence: '老周停止了呼吸。' }],
    }]
    await render(<WriteChapterPopover chapterNumber={5} blueprint={blueprintWritePrefill(BLUEPRINT)} label="写第 5 章" />)
    await act(async () => page.getByRole('button', { name: '写第 5 章' }).click())
    const popover = page.getByRole('dialog', { name: '本次写作选项' })
    await expect.element(popover.getByRole('region', { name: '一致性预检' })).toBeVisible()
    await expect.element(popover.getByText(/一致性预检 · 1 条线索提醒/)).toBeVisible()
    expect(startWorkflow).not.toHaveBeenCalled()

    // 提醒已展示：再点主按钮视为作者已读过，带提醒直接开写（页脚也如实说明）。
    await act(async () => page.getByRole('button', { name: '写第 5 章' }).click())
    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
    expect(exemptions).toEqual([])
  })

  it('预检弹层里「带提醒继续写」与「改蓝图后重检」各自生效', async () => {
    continuityProjections = [{
      draftId: 1, chapterNumber: 1, chapterTitle: '终局', chapterNotes: '老周死亡',
      source: { draftId: 1, finalizationId: 'finalization-1', chapterNumber: 1, contentHash: 'a'.repeat(64) },
      sourceStatus: 'current',
      facts: [{ category: 'character-state', entities: ['老周'], statement: '老周已经死亡。', sourceChapter: 1, evidence: '老周停止了呼吸。' }],
    }]
    await render(<WriteChapterPopover chapterNumber={5} blueprint={blueprintWritePrefill(BLUEPRINT)} label="写第 5 章" />)
    await act(async () => page.getByRole('button', { name: '写第 5 章' }).click())
    const popover = page.getByRole('dialog', { name: '本次写作选项' })
    await expect.element(popover.getByRole('region', { name: '一致性预检' })).toBeVisible()
    expect(startWorkflow).not.toHaveBeenCalled()

    await act(async () => popover.getByRole('button', { name: '改蓝图后重检' }).click())
    await expect.element(popover.getByRole('region', { name: '一致性预检' })).toBeVisible()
    expect(startWorkflow).not.toHaveBeenCalled()

    await act(async () => popover.getByRole('button', { name: '带提醒继续写' }).click())
    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
    expect(exemptions).toEqual([])
  })

  /**
   * ⚠️ 行为在 issue #170 变了，测试没跟上（issue #211 顺带修）：
   *
   * 原实现在「保存安排」落库后 `await start(false)` —— **重算整份预检并开写**。
   * #170 把这一段删掉是有原因的：`readConsistencyPreflight` 的返回值不含模型判据的结论，
   * 重算会把刚花两万 tok 核出来的卡片整体清空（现场 60 → 50、模型条目 0 条）。
   * 所以现在「保存安排」= **只动这一条**（落库 → 从 findings 里去掉它 → 进 exemptions），
   * 弹层留着、不重算、也不自动开写——作者接着处理下一条，或自己点主按钮。
   *
   * 但 #170 没改这条测试，于是它一直在断言「保存后 startWorkflow 会被调用一次」，
   * 也就一直红着（#211 里 12 条失败的其中 1 条）。
   */
  it('保存安排只动这一条（不重算、也不自动开写），已保存的安排可以在弹层里撤销', async () => {
    continuityProjections = [{
      draftId: 1, chapterNumber: 1, chapterTitle: '终局', chapterNotes: '老周死亡',
      source: { draftId: 1, finalizationId: 'finalization-1', chapterNumber: 1, contentHash: 'a'.repeat(64) },
      sourceStatus: 'current',
      facts: [{ category: 'character-state', entities: ['老周'], statement: '老周已经死亡。', sourceChapter: 1, evidence: '老周停止了呼吸。' }],
    }]
    await render(<WriteChapterPopover chapterNumber={5} blueprint={blueprintWritePrefill(BLUEPRINT)} label="写第 5 章" />)
    await act(async () => page.getByRole('button', { name: '写第 5 章' }).click())
    const popover = page.getByRole('dialog', { name: '本次写作选项' })
    await act(async () => popover.getByLabelText('安排说明').fill('老周以幽灵身份出现，是刻意安排。'))
    await act(async () => popover.getByRole('button', { name: '保存安排' }).click())
    // 落库成功即可断言（不再等 startWorkflow —— 它按设计不会被调用）。
    await vi.waitFor(() => expect(exemptions).toMatchObject([{ reason: '老周以幽灵身份出现，是刻意安排。', revoked: false }]))
    // 只动这一条：被保存的那条从提醒里消失，**别的提醒还在**（不重算 → 不会被清空）。
    await expect.element(popover.getByRole('region', { name: '一致性预检' })).toBeVisible()
    expect(popover.getByText('老周已经死亡')).toBeTruthy()
    // 不自动开写：作者接着处理下一条，或自己点主按钮。
    expect(startWorkflow).not.toHaveBeenCalled()

    // 弹层这时**已经关着**（「保存安排」不重开它，也不自动开写）；直接展开「已保存安排」。
    // 原来这里先点了一次「本次写作选项」箭头 —— 那会**打开**弹层，随后在展开的分组上再点
    // 一次反而关掉它，于是等不到『已保存安排（1）』（旧实现保存后会重开弹层，所以那时是对的）。
    await popover.getByText('已保存安排（1）').click()
    await act(async () => popover.getByRole('button', { name: '撤销' }).click())
    await vi.waitFor(() => expect(exemptions).toMatchObject([{ revoked: true }]))
  })

  it('前置条件不满足时弹层打开并写明原因，不启动', async () => {
    await render(<WriteChapterPopover chapterNumber={7} blueprint={blueprintWritePrefill(BLUEPRINT)} label="写第 7 章" />)
    await act(async () => page.getByRole('button', { name: '写第 7 章' }).click())
    await expect.element(page.getByRole('dialog', { name: '本次写作选项' }).getByRole('alert')).toHaveTextContent('当前权威定稿之后只能创作第 5 章')
    expect(startWorkflow).not.toHaveBeenCalled()
  })

  it('定稿后打开下一章等请求：挂着这一章按钮的弹层自己打开并清掉请求', async () => {
    await render(<WriteChapterPopover chapterNumber={5} blueprint={blueprintWritePrefill(BLUEPRINT)} label="写第 5 章" />)
    expect(page.getByRole('dialog', { name: '本次写作选项' }).query()).toBeNull()
    await act(async () => useStageStore.setState({ writeRequest: { session: SESSION, chapterNumber: 5 } }))
    await expect.element(page.getByRole('dialog', { name: '本次写作选项' })).toBeVisible()
    expect(useStageStore.getState().writeRequest).toBeNull()
    expect(startWorkflow).not.toHaveBeenCalled()
  })

  it('被挡下时作者改过的选项都留着，改好条件后照原样再试', async () => {
    await render(<WriteChapterPopover chapterNumber={7} blueprint={blueprintWritePrefill(BLUEPRINT)} label="写第 7 章" />)
    await act(async () => page.getByRole('button', { name: '本次写作选项' }).click())
    const popover = page.getByRole('dialog', { name: '本次写作选项' })
    await act(async () => popover.getByLabelText(/本次模型/).selectOptions('glm'))
    await act(async () => popover.getByLabelText(/作者微操指导/).fill('被挡下前写的指导'))
    await act(async () => popover.getByText('更多').click())
    await act(async () => popover.getByLabelText(/知识库检索关键词/).fill('列车时刻表'))
    await act(async () => page.getByRole('button', { name: '写第 7 章' }).click())
    await expect.element(popover.getByRole('alert')).toHaveTextContent('当前权威定稿之后只能创作第 5 章')
    await expect.element(popover.getByLabelText(/作者微操指导/)).toHaveValue('被挡下前写的指导')
    await expect.element(popover.getByLabelText(/本次模型/)).toHaveValue('glm')
    await expect.element(popover.getByLabelText(/知识库检索关键词/)).toHaveValue('列车时刻表')
  })

  it('一致性预检提醒时作者改过的选项都留着，带提醒继续写后按这些选项写', async () => {
    continuityProjections = DEAD_KEEPER
    await render(<WriteChapterPopover chapterNumber={5} blueprint={blueprintWritePrefill(BLUEPRINT)} label="写第 5 章" />)
    await act(async () => page.getByRole('button', { name: '本次写作选项' }).click())
    const popover = page.getByRole('dialog', { name: '本次写作选项' })
    await act(async () => popover.getByLabelText(/作者微操指导/).fill('预检前写的指导'))
    await act(async () => popover.getByText('更多').click())
    await act(async () => popover.getByLabelText(/知识库检索关键词/).fill('列车时刻表'))
    await act(async () => page.getByRole('button', { name: '写第 5 章' }).click())
    await expect.element(popover.getByRole('region', { name: '一致性预检' })).toBeVisible()
    await expect.element(popover.getByLabelText(/作者微操指导/)).toHaveValue('预检前写的指导')
    await expect.element(popover.getByLabelText(/知识库检索关键词/)).toHaveValue('列车时刻表')
    await act(async () => popover.getByRole('button', { name: '带提醒继续写' }).click())
    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
    expect(launched().chapterInfo).toMatchObject({ userGuidance: '预检前写的指导', knowledgeQueryHint: '列车时刻表' })
  })

  it.each([[1280, 720], [1024, 640]])('%i×%i 下三条预检提醒时弹层停在视口内，内部滚到底点得到「带提醒继续写」，内部滚动不关闭弹层', async (width, height) => {
    await page.viewport(width, height)
    await vi.waitFor(() => expect([window.innerWidth, window.innerHeight]).toEqual([width, height]))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    continuityProjections = [{
      ...DEAD_KEEPER[0],
      facts: ['老周', '阿满', '林舟'].map(name => ({ category: 'character-state', entities: [name], statement: `${name}已经死亡。`, sourceChapter: 1, evidence: `${name}停止了呼吸。` })),
    }]
    await act(async () => root?.render(
      <div className="paper-ink stage-shell" style={{ paddingTop: 120, display: 'flex', justifyContent: 'flex-end' }}>
        <WriteChapterPopover chapterNumber={5} blueprint={blueprintWritePrefill(BLUEPRINT)} label="写第 5 章" />
      </div>,
    ))
    await act(async () => page.getByRole('button', { name: '写第 5 章' }).click())
    const popover = page.getByRole('dialog', { name: '本次写作选项' })
    await expect.element(popover.getByText(/一致性预检 · 3 条线索提醒/)).toBeVisible()
    const layer = popover.element() as HTMLElement
    await Promise.all(layer.getAnimations().map(animation => animation.finished))
    expect(layer.getBoundingClientRect().bottom).toBeLessThanOrEqual(height - 8)
    await act(async () => {
      layer.scrollTop = layer.scrollHeight
      await new Promise(resolve => layer.addEventListener('scroll', resolve, { once: true }))
    })
    const ignore = popover.getByRole('button', { name: '带提醒继续写' }).element()
    const rect = ignore.getBoundingClientRect()
    expect(rect.bottom).toBeLessThanOrEqual(layer.getBoundingClientRect().bottom)
    expect(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)).toBe(ignore)
    await page.screenshot({ path: `../../../../../.runtime/rdx3-shots/write-popover-${width}x${height}.png` })
    await act(async () => (ignore as HTMLButtonElement).click())
    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
  })

  it('在新外壳里 Tab 到拆分主按钮的两半，各自都有焦点环', async () => {
    await act(async () => root?.render(
      <div className="paper-ink stage-shell"><WriteChapterPopover chapterNumber={5} blueprint={blueprintWritePrefill(BLUEPRINT)} label="写第 5 章" /></div>,
    ))
    const ring = (element: Element) => getComputedStyle(element).boxShadow
    await userEvent.tab()
    expect(document.activeElement?.textContent).toBe('写第 5 章')
    expect(ring(document.activeElement!)).toMatch(/^rgb\(255, 254, 251\) 0px 0px 0px 2px, rgb\(44, 74, 140\) 0px 0px 0px 4px, /)
    await userEvent.tab()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('本次写作选项')
    expect(ring(document.activeElement!)).toMatch(/^rgb\(255, 254, 251\) 0px 0px 0px 2px, rgb\(44, 74, 140\) 0px 0px 0px 4px, /)
  })

  it('拆分主按钮：开始写作期间主体是加载中（aria-busy）而不是退成未上墨，箭头半边不带 aria-busy', async () => {
    let release: () => void = () => {}
    continuityGate = new Promise(resolve => { release = resolve })
    await render(<WriteChapterPopover chapterNumber={5} blueprint={blueprintWritePrefill(BLUEPRINT)} label="写第 5 章" />)
    const main = page.getByRole('button', { name: '写第 5 章' }).element() as HTMLButtonElement
    const toggle = page.getByRole('button', { name: '本次写作选项' }).element() as HTMLButtonElement
    const split = main.closest('.pi-split')!
    expect(main.classList.contains('pi-split-main')).toBe(true)
    expect(toggle.classList.contains('pi-split-toggle')).toBe(true)
    expect(split.classList.contains('pi-split--main-off')).toBe(false)
    await act(async () => main.click())
    expect(main.disabled).toBe(true)
    expect(main.getAttribute('aria-busy')).toBe('true')
    expect(toggle.getAttribute('aria-busy')).toBeNull()
    expect(split.classList.contains('pi-split--main-off')).toBe(false)
    continuityGate = null
    await act(async () => release())
    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(main.getAttribute('aria-busy')).toBeNull())
    expect(main.disabled).toBe(false)
  })

  /**
   * issue #210：「点下去」到「弹层出现」之间必须有可读的状态。
   *
   * 现场：点「写第 31 章」后 10 分钟零反馈——没有弹层、没有 chapter-draft 运行、
   * 没有模型调用、界面一个字都没变，作者无从判断是坏了还是在等。
   * #192 已经把「弹层内的等待」做出了秒数；这一条是同一个原则往上一层。
   */
  it('主按钮在进行中改写成带秒数的准备文案（issue #210）', async () => {
    let release: () => void = () => {}
    continuityGate = new Promise(resolve => { release = resolve })
    await render(<WriteChapterPopover chapterNumber={5} blueprint={blueprintWritePrefill(BLUEPRINT)} label="写第 5 章" />)
    const main = page.getByRole('button', { name: '写第 5 章' }).element() as HTMLButtonElement
    expect(main.textContent).toBe('写第 5 章')
    await act(async () => main.click())
    // 点下去立刻换成「正在准备一致性预检… 已等 N 秒」，不再只有一个不动的标签。
    expect(main.textContent).toContain('正在准备一致性预检')
    expect(main.textContent).toMatch(/已等 \d+ 秒/u)
    // 秒数要真的在走（等 1.2 秒后应至少到 1）。
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1200)) })
    const waited = Number(/已等 (\d+) 秒/u.exec(main.textContent ?? '')?.[1] ?? 0)
    expect(waited).toBeGreaterThanOrEqual(1)
    continuityGate = null
    await act(async () => release())
    await vi.waitFor(() => expect(main.textContent).toBe('写第 5 章'))
  })

  it('保存安排时按钮不可再点；保存失败写明原因，不开始写', async () => {
    continuityProjections = DEAD_KEEPER
    let finishSave: (result: { success: boolean; error?: string }) => void = () => {}
    exemptionSave = () => new Promise(resolve => { finishSave = resolve })
    await render(<WriteChapterPopover chapterNumber={5} blueprint={blueprintWritePrefill(BLUEPRINT)} label="写第 5 章" />)
    await act(async () => page.getByRole('button', { name: '写第 5 章' }).click())
    const popover = page.getByRole('dialog', { name: '本次写作选项' })
    await act(async () => popover.getByLabelText('安排说明').fill('老周以幽灵身份出现，是刻意安排。'))
    await act(async () => popover.getByRole('button', { name: '保存安排' }).click())
    await expect.element(popover.getByRole('button', { name: '保存安排' })).toBeDisabled()
    await expect.element(popover.getByRole('button', { name: '带提醒继续写' })).toBeDisabled()
    const main = page.getByRole('button', { name: '写第 5 章' }).element() as HTMLButtonElement
    expect(main.disabled).toBe(true)
    expect(main.getAttribute('aria-busy')).toBeNull()
    expect(main.closest('.pi-split')!.classList.contains('pi-split--main-off')).toBe(true)
    await act(async () => finishSave({ success: false, error: '数据库只读' }))
    await expect.element(popover.getByRole('alert')).toHaveTextContent('数据库只读')
    await expect.element(popover.getByRole('button', { name: '保存安排' })).toBeEnabled()
    expect(startWorkflow).not.toHaveBeenCalled()
  })

  it('英文界面下保存安排被拒、又没带原因时，提示也是英文', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    continuityProjections = DEAD_KEEPER
    exemptionSave = async () => ({ success: false })
    await render(<WriteChapterPopover chapterNumber={5} blueprint={blueprintWritePrefill(BLUEPRINT)} label="Write chapter 5" />)
    await act(async () => page.getByRole('button', { name: 'Write chapter 5' }).click())
    const popover = page.getByRole('dialog', { name: 'Options for this run' })
    await act(async () => popover.getByLabelText('Why this is intentional').fill('The keeper appears as a ghost on purpose.'))
    await act(async () => popover.getByRole('button', { name: 'Save arrangement' }).click())
    await expect.element(popover.getByRole('alert')).toHaveTextContent(/^Could not save the consistency arrangement.$/)
    expect(startWorkflow).not.toHaveBeenCalled()
  })

  it('保存安排还没返回时换了作品：保存成功后不在新作品里按旧蓝图开始写', async () => {
    continuityProjections = DEAD_KEEPER
    let finishSave: (result: { success: boolean }) => void = () => {}
    exemptionSave = () => new Promise(resolve => { finishSave = resolve })
    await render(<WriteChapterPopover chapterNumber={5} blueprint={blueprintWritePrefill(BLUEPRINT)} label="写第 5 章" />)
    await act(async () => page.getByRole('button', { name: '写第 5 章' }).click())
    const popover = page.getByRole('dialog', { name: '本次写作选项' })
    await act(async () => popover.getByLabelText('安排说明').fill('老周以幽灵身份出现，是刻意安排。'))
    await act(async () => popover.getByRole('button', { name: '保存安排' }).click())
    const other = { projectId: 'harbor', leaseId: 'harbor-lease', projectPath: 'C:\\novels\\harbor' }
    setActiveProjectSessionContext(other)
    await act(async () => useProjectStore.setState({ currentProject: { ...project(), id: 'harbor', sessionLease: 'harbor-lease', name: '港口', path: other.projectPath } }))
    await act(async () => finishSave({ success: true }))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    expect(createChapterWorkflow).not.toHaveBeenCalled()
    expect(startWorkflow).not.toHaveBeenCalled()
  })

  it('批量创作的预检里保存安排失败也写明原因，保存中不可再点', async () => {
    continuityProjections = DEAD_KEEPER
    let finishSave: (result: { success: boolean; error?: string }) => void = () => {}
    exemptionSave = () => new Promise(resolve => { finishSave = resolve })
    await render(<BatchWriteDialog isOpen startChapterNumber={5} onClose={vi.fn()} />)
    const dialog = page.getByRole('dialog', { name: '批量创作' })
    await act(async () => dialog.getByLabelText(/写几章/).fill('1'))
    await act(async () => dialog.getByRole('button', { name: '开始写 1 章' }).click())
    await expect.element(dialog.getByRole('region', { name: '一致性预检' })).toBeVisible()
    await act(async () => dialog.getByLabelText('安排说明').fill('老周以幽灵身份出现，是刻意安排。'))
    await act(async () => dialog.getByRole('button', { name: '保存安排' }).click())
    await expect.element(dialog.getByRole('button', { name: '保存安排' })).toBeDisabled()
    await act(async () => finishSave({ success: false, error: '数据库只读' }))
    await expect.element(dialog.getByRole('alert')).toHaveTextContent('数据库只读')
    await expect.element(dialog.getByRole('button', { name: '保存安排' })).toBeEnabled()
    expect(startWorkflow).not.toHaveBeenCalled()
  })
})

// issue #55：守卫阻断（上一章后处理未完成）时，弹层此前一个按钮都没有，
// 底部脚注却还写着「点它开始」——按脚注做就回到同一个阻断，被读成「点了没反应」。
describe('守卫阻断时的弹层出口（issue #55）', () => {
  it('给出「去修复第 N 章的定稿后处理」，脚注不再承诺必然被拒绝的动作', async () => {
    blockedPreviousChapter = 12
    try {
      const prefill = { ...blueprintWritePrefill(BLUEPRINT), chapterNumber: 13 }
      await render(<WriteChapterPopover chapterNumber={13} blueprint={prefill} label="写第 13 章" />)
      await act(async () => page.getByRole('button', { name: '写第 13 章' }).click())
      const popover = page.getByRole('dialog', { name: '本次写作选项' })
      await expect.element(popover.getByRole('button', { name: '去修复第 12 章的定稿后处理' })).toBeVisible()
      await expect.element(popover.getByRole('button', { name: '留在蓝图' })).toBeVisible()
      // 脚注必须改成「先补完第 12 章」，不能再说「点它就开写」
      await expect.element(popover).toHaveTextContent('这一步要先补完第 12 章的定稿后处理才能继续写')
      await expect.element(popover).not.toHaveTextContent('点「写第 13 章」开始')
    } finally {
      blockedPreviousChapter = null
    }
  })
})

/**
 * issue #224：同一章反复点「写第 N 章」零簿记提示——三条管线叠加、短纲同输入
 * 三种产出（2832/9077/13948）、僵尸 running 无人可见。修法是**入口层给信息**：
 * 弹层打开时列出本章已有未定稿草稿与活动运行。均为簿记判断，无词表、无模型。
 */
describe('同章重复写作的簿记提示 (issue #224)', () => {
  it('lists existing unfinalized drafts and warns a new version will be created', async () => {
    draftListOverride = [
      { version: 1, status: 'draft', wordCount: 641 },
      { version: 2, status: 'draft', wordCount: 890 },
    ]
    await render(<WriteChapterPopover chapterNumber={5} blueprint={blueprintWritePrefill(BLUEPRINT)} label="写第 5 章" />)
    await userEvent.click(page.getByRole('button', { name: '本次写作选项' }))
    await vi.waitFor(() => expect(page.getByText(/本章已有 2 个未定稿草稿/)).toBeVisible())
    await vi.waitFor(() => expect(page.getByText(/v1 641 字、v2 890 字/)).toBeVisible())
    await vi.waitFor(() => expect(page.getByText(/重新生成会产生新版本 v3/)).toBeVisible())
  })

  it('stays silent when the chapter has no unfinalized drafts', async () => {
    draftListOverride = [{ version: 1, status: 'finalized', wordCount: 800 }]
    await render(<WriteChapterPopover chapterNumber={5} blueprint={blueprintWritePrefill(BLUEPRINT)} label="写第 5 章" />)
    await userEvent.click(page.getByRole('button', { name: '本次写作选项' }))
    await vi.waitFor(() => expect(page.getByText('本次模型')).toBeVisible())
    expect(document.body.textContent).not.toContain('未定稿草稿')
  })

  it('shows an active run on the same chapter before the author hits start', async () => {
    await render(<WriteChapterPopover chapterNumber={5} blueprint={blueprintWritePrefill(BLUEPRINT)} label="写第 5 章" />)
    await userEvent.click(page.getByRole('button', { name: '本次写作选项' }))
    useWorkflowStore.setState({ activeRuns: [{
      id: 'run-224', projectPath: SESSION.projectPath, type: 'chapter_creation', title: '第 5 章 · 写稿',
      status: 'running', steps: [], currentStepIndex: 0, startedAt: '',
      resourceKeys: [`chapter:5`],
    } as never] })
    await vi.waitFor(() => expect(page.getByText(/上一次「第 5 章 · 写稿」还在运行中/)).toBeVisible())
  })
})
