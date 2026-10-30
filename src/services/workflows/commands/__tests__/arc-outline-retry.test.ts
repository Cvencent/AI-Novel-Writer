import { afterEach, describe, expect, it, vi } from 'vitest'

import { useLocaleStore } from '../../../../stores/locale-store'
import type { ModelExecutionLeaseReceipt } from '../../../../shared/ipc-channels'
import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import type { GenerationRuntime, GenerationRuntimeEnvironment } from '../../../generation/generation-runtime'
import { GenerateArcOutlineCommand } from '../arc-outline.command'
import type { WorkflowGenerationRuntimeDependencies } from '../base-command'

vi.mock('../../../ipc-client', () => ({
  ipc: {
    invokeWithProjectSession: vi.fn(async (_session: unknown, channel: string) => {
      if (channel === 'db:project-core-get') {
        return { premise: '# 故事前提\n\n主角追查灯塔失踪案。', worldbuilding: '# 世界观\n\n旧港与海事制度。' }
      }
      if (channel === 'db:arc-outline-list') return []
      if (channel === 'db:character-roster-read') return { entries: [] }
      if (channel === 'db:arc-outline-save') return { success: true }
      throw new Error('unexpected channel ' + channel)
    }),
  },
}))

const originalLocale = useLocaleStore.getState().locale

afterEach(() => {
  vi.restoreAllMocks()
  useLocaleStore.setState({ locale: originalLocale })
})

const context: WorkflowContext = {
  runId: 'arc-retry-probe',
  projectPath: 'C:\\novels\\probe',
  projectSession: { projectId: 'probe', leaseId: 'lease-probe', projectPath: 'C:\\novels\\probe' },
  writingLanguage: 'zh-CN',
  uiLocale: 'zh-CN',
  data: {},
  cancelled: false,
}

const callbacks: StepCallbacks = {
  log: vi.fn(),
  setProgress: vi.fn(),
  appendText: vi.fn(),
}

const snapshot = {
  expectedProjectPath: 'C:\\novels\\probe',
  novelConfig: {
    totalChapters: 40,
    wordsPerChapter: 700,
    writingLanguage: 'zh-CN',
    genre: '悬疑',
    targetAudience: '男频',
    coreOutline: '灯塔失踪案贯穿全书。',
  },
} as never

function leaseReceipt(): ModelExecutionLeaseReceipt {
  return {
    leaseId: 'arc-lease-a',
    modelId: 'model-a',
    provider: 'custom',
    protocol: 'openai',
    modelName: 'unknown-model',
    modelRevision: 'a'.repeat(64),
    endpointFingerprint: 'b'.repeat(64),
    capabilityEvidence: {
      source: { contextWindowTokens: 'unknown', maxOutputTokens: 'user-operational-cap', featureFlags: 'unknown' },
      subjectFingerprint: 'c'.repeat(64),
      contextWindowTokens: null,
      maxOutputTokens: 2048,
      reasoning: null,
      structuredOutput: true,
      usage: null,
    },
    createdAt: 1000,
    expiresAt: 61_000,
  }
}

function dependenciesFor(completeWithLease: GenerationRuntimeEnvironment['completeWithLease']): WorkflowGenerationRuntimeDependencies {
  return {
    createRuntime: async (): Promise<GenerationRuntime> => {
      const environment: GenerationRuntimeEnvironment = {
        snapshotDefaultModelId: () => 'model-a',
        beginModelExecution: vi.fn().mockResolvedValue(leaseReceipt()),
        completeWithLease,
        closeModelExecution: vi.fn().mockResolvedValue(undefined),
      }
      const { createGenerationRuntime } = await import('../../../generation/generation-runtime')
      return createGenerationRuntime({ budget: { maxAttempts: 12, maxRequestedOutputTokens: 98_304, maxRequestedOutputTokensPerAttempt: 8192, deadlineMs: 20 * 60_000 } }, environment)
    },
  }
}

const goodSegment = `## 第1–24章：灯塔异动
beat: setup
主角发现失踪者都指向废弃灯塔，支线是海事档案室的制度阻力，世界观里的潮汐规则参与因果。`

describe('GenerateArcOutlineCommand content-contract retry', () => {
  it('retries once with the rejected sample when the first reply has no parseable heading, then succeeds', async () => {
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValueOnce({ content: '好的，这是粗纲：故事从灯塔开始……（没有标题行）', finishReason: 'stop' })
      .mockResolvedValueOnce({ content: goodSegment, finishReason: 'stop' })
    const logs: string[] = []
    const command = new GenerateArcOutlineCommand(snapshot, dependenciesFor(completeWithLease))

    const result = await command.execute({ step: {}, context, callbacks: { ...callbacks, log: line => logs.push(line) } })
    expect(result).toContain('废弃灯塔')
    expect(completeWithLease).toHaveBeenCalledTimes(2)
    // corrective prompt carries the rejected sample and the format demand
    const secondCall = completeWithLease.mock.calls[1]?.[0] as unknown as { messages: readonly { content: string }[] }
    const secondPrompt = secondCall.messages.map(m => m.content).join('\n')
    expect(secondPrompt).toContain('上一次输出不合格')
    expect(secondPrompt).toContain('没有标题行')
    expect(logs.join('\n')).toContain('ARC_PARSE_NO_SEGMENT')
  })

  it('surfaces the parse code after the corrective retry also fails', async () => {
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockResolvedValue({ content: '依然没有标题行', finishReason: 'stop' })
    const command = new GenerateArcOutlineCommand(snapshot, dependenciesFor(completeWithLease))

    await expect(command.execute({ step: {}, context, callbacks })).rejects.toThrow('ARC_PARSE_NO_SEGMENT')
    expect(completeWithLease).toHaveBeenCalledTimes(2)
  })

  it('does not retry non-parse failures (transport codes are the workflow layer\'s job)', async () => {
    const completeWithLease = vi.fn<GenerationRuntimeEnvironment['completeWithLease']>()
      .mockRejectedValue(new Error('fetch failed'))
    const command = new GenerateArcOutlineCommand(snapshot, dependenciesFor(completeWithLease))

    await expect(command.execute({ step: {}, context, callbacks })).rejects.toThrow(/GENERATION_PROVIDER_FAILED/)
    expect(completeWithLease).toHaveBeenCalledTimes(1)
  })
})
