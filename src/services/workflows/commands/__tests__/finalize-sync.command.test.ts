import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLLMStore } from '../../../../stores/llm-store'
import { useProjectStore } from '../../../../stores/project-store'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import { FinalizeSyncCommand } from '../finalize-sync.command'

const PROJECT_PATH = 'C:\\novels\\finalize-sync'
const PROJECT_SESSION = Object.freeze({
  projectId: 'finalize-sync',
  leaseId: 'lease-finalize-sync',
  projectPath: PROJECT_PATH,
})
const CONTENT = '周叙把短褂撕成布条，缠住手腕的绳痕——他记得岸上有人在等。'

const originalGenerateStream = useLLMStore.getState().generateStream
const originalDefaultModelId = useLLMStore.getState().defaultModelId

function workflowContext(uiLocale: 'zh-CN' | 'en-US' = 'zh-CN'): WorkflowContext {
  return {
    runId: 'finalize-sync-run',
    projectPath: PROJECT_PATH,
    projectSession: PROJECT_SESSION,
    generationModelId: 'finalize-sync-model',
    writingLanguage: 'zh-CN',
    uiLocale,
    data: {},
    cancelled: false,
  }
}

function callbacks(): StepCallbacks {
  return {
    log: vi.fn(),
    setProgress: vi.fn(),
    appendText: vi.fn(),
  }
}

/** 模型回复：一章的 JSON 校正方案。 */
function planJson(outlineEntry: string): string {
  return JSON.stringify({
    outlineEntry,
    blueprint: { role: '过渡', purpose: '交代周叙的伤情', keyEvents: '周叙包扎手腕' },
    notes: ['蓝图 suspenseHook 与正文不符'],
  })
}

interface IpcHarness {
  invoke: ReturnType<typeof vi.fn>
  outlineWrites: Array<{ chapter: number; entry: string }>
  blueprintPatches: Array<{ chapter: number; patch: Record<string, unknown> }>
  prompts: string[]
  execute: ReturnType<typeof vi.fn>
}

/**
 * 模型回复内容（本次 generation:execute 的结果）。用模块级变量而非重新 stub 全局：
 * 主进程持账通道在一次 execute 内只读一次运行视图。
 */
let modelContent = ''

/** 主进程持账通道：finalize-sync 走 workflow-main-generation，模型请求经 generation:execute。 */
function installIpc(options: { synopsis: string; blueprint: Record<string, unknown> | null }): IpcHarness {
  const outlineWrites: Array<{ chapter: number; entry: string }> = []
  const blueprintPatches: Array<{ chapter: number; patch: Record<string, unknown> }> = []
  const prompts: string[] = []
  const view = {
    handle: { projectId: PROJECT_SESSION.projectId, epoch: PROJECT_SESSION.leaseId, rootActionId: 'finalize-sync-root', runId: 'finalize-sync-run' },
    status: 'running',
    nonReplayable: false,
    artifacts: [],
    budget: { maxAttempts: 32, maxRequestedOutputTokens: 2097152, maxRequestedOutputTokensPerAttempt: 32768, deadlineAt: 9_999_999_999_999 },
  }
  const execute = vi.fn(async (request: { task: { messages: Array<{ content: string }> } }) => {
    const prompt = request.task.messages.map(message => message.content).join(String.fromCharCode(10) + String.fromCharCode(10))
    prompts.push(prompt)
    const outcome = { status: 'completed', content: modelContent, finishReason: 'stop', receipt: { finishReason: 'stop' } }
    return { run: structuredClone(view), outcome }
  })
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    switch (channel) {
      case 'generation:begin':
      case 'generation:read':
      case 'generation:read-visible-composition':
        return channel === 'generation:read-visible-composition' ? null : structuredClone(view)
      case 'generation:execute':
        return execute(args[0] as { task: { messages: Array<{ content: string }> } })
      case 'db:project-core-get':
        return { synopsis: options.synopsis }
      case 'db:blueprint-get':
        return options.blueprint
      case 'db:stage-review-apply-outline':
        outlineWrites.push({ chapter: args[0] as number, entry: args[1] as string })
        return { success: true }
      case 'db:stage-review-apply-blueprint':
        blueprintPatches.push({ chapter: args[0] as number, patch: args[1] as Record<string, unknown> })
        return { success: true }
      default:
        throw new Error(`未预期的 IPC 通道：${channel}`)
    }
  })
  vi.stubGlobal('window', { aiNovelAPI: { invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn() } })
  return { invoke, outlineWrites, blueprintPatches, prompts, execute }
}

beforeEach(() => {
  useProjectStore.setState({
    currentProject: {
      id: PROJECT_SESSION.projectId,
      name: 'Finalize sync',
      path: PROJECT_PATH,
      sessionLease: PROJECT_SESSION.leaseId,
      novelConfig: { writingLanguage: 'zh-CN' },
    } as never,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useLLMStore.setState({ defaultModelId: originalDefaultModelId, generateStream: originalGenerateStream })
  useProjectStore.setState({ currentProject: null })
})

const run = (params: { step?: unknown; context?: WorkflowContext; callbacks?: StepCallbacks } = {}) =>
  new FinalizeSyncCommand(4, CONTENT).execute({
    step: params.step ?? {},
    context: params.context ?? workflowContext(),
    callbacks: params.callbacks ?? callbacks(),
  })

describe('FinalizeSyncCommand 细纲/蓝图校正（issue #61）', () => {
  it('本章有细纲条目时照旧同时写回细纲与蓝图', async () => {
    const synopsis = '## 第4章：绳痕\n\n目的：交代周叙的伤情。\n'
    const harness = installIpc({ synopsis, blueprint: { chapterNumber: 4, title: '绳痕', role: '过渡', keyEvents: '旧事件' } })
    modelContent = planJson('## 第4章：绳痕\n\n目的：交代周叙的伤情与手上绳痕的来历。')

    await run()

    expect(harness.outlineWrites).toEqual([{ chapter: 4, entry: '## 第4章：绳痕\n目的：交代周叙的伤情与手上绳痕的来历。' }])
    expect(harness.blueprintPatches).toHaveLength(1)
    expect(harness.blueprintPatches[0]!.patch).toMatchObject({ chapterNumber: 4, role: '过渡' })
  })

  it('本章不在情节大纲里但蓝图存在时只校正蓝图，不写回细纲', async () => {
    // 本样本：22 章定稿而 synopsis 只覆盖第 1–3 章，第 4 章点这个入口原本必然失败。
    const synopsis = '## 第1章：开局\n\n目的：开场。\n\n## 第2章：暗流\n\n目的：铺垫。\n\n## 第3章：钟楼\n\n目的：揭露。\n'
    const harness = installIpc({ synopsis, blueprint: { chapterNumber: 4, title: '绳痕', role: '过渡', keyEvents: '旧事件' } })
    modelContent = planJson('')
    const logs: string[] = []
    await run({ callbacks: { ...callbacks(), log: (message: string) => { logs.push(message) } } })

    expect(harness.outlineWrites).toEqual([])
    expect(harness.blueprintPatches).toEqual([{ chapter: 4, patch: {
      chapterNumber: 4, role: '过渡', purpose: '交代周叙的伤情', keyEvents: '周叙包扎手腕',
    } }])
    const prompt = harness.prompts[0]!
    expect(prompt).toContain('本章在「情节大纲」里没有条目')
    expect(prompt).not.toContain('【当前细纲条目】')
    expect(logs.some(message => message.includes('本次只校正蓝图'))).toBe(true)
    expect(logs.some(message => message.includes('大纲目前覆盖 第 1–3 章'))).toBe(true)
    expect(logs.at(-1)).toContain('蓝图已按定稿正文校正（本章不在情节大纲里，细纲未改动）')
  })

  it('既没有蓝图也不在情节大纲里时给出可操作的错误（点名大纲覆盖范围）', async () => {
    const synopsis = '## 第1章：开局\n\n目的：开场。\n'
    const harness = installIpc({ synopsis, blueprint: null })

    await expect(run())
      .rejects.toThrow(/既没有蓝图、也不在情节大纲里（大纲目前覆盖 第 1–1 章）/)

    expect(harness.outlineWrites).toEqual([])
    expect(harness.blueprintPatches).toEqual([])
  })

  it('空大纲同样给出可操作提示（覆盖范围显示为「（空）」）', async () => {
    const harness = installIpc({ synopsis: '', blueprint: null })

    await expect(run())
      .rejects.toThrow(/大纲目前覆盖 （空）/)

    expect(harness.invoke).toHaveBeenCalledWith('db:blueprint-get', 4, PROJECT_PATH, PROJECT_SESSION)
    expect(harness.outlineWrites).toEqual([])
  })
})