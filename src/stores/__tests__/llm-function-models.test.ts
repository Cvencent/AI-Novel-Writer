import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('../../services/ipc-client', () => ({
  ipc: {
    invoke: mocks.invoke,
    get isElectron() { return true },
  },
}))

vi.mock('../../components/ui/AlertDialog', () => ({
  alertError: vi.fn(),
}))

import { useLLMStore } from '../llm-store'
import type { ModelProfile } from '../../shared/ipc-channels'

const genModel = (id: string): ModelProfile => ({
  id, name: id, provider: 'custom', protocol: 'openai', modelName: id, apiKey: '', baseUrl: '',
  temperature: 0.7, maxTokens: 1024, purposes: ['generation'],
})

beforeEach(() => {
  vi.clearAllMocks()
  useLLMStore.setState({
    models: [],
    defaultModelId: null,
    defaultEmbeddingModelId: null,
    functionModels: {},
    activeRequests: new Map(),
    loaded: false,
  })
})

describe('function model resolution', () => {
  it('loads function assignments during init', async () => {
    mocks.invoke.mockImplementation((channel: string) => {
      if (channel === 'llm:list-models') return Promise.resolve([genModel('gen-a')])
      if (channel === 'llm:get-default-model') return Promise.resolve('gen-a')
      if (channel === 'llm:get-default-embedding-model') return Promise.resolve(null)
      if (channel === 'llm:get-function-models') return Promise.resolve({ draft_generation: 'gen-a' })
      throw new Error(`unexpected IPC ${channel}`)
    })
    await useLLMStore.getState().init()
    expect(useLLMStore.getState().functionModels).toEqual({ draft_generation: 'gen-a' })
    expect(useLLMStore.getState().modelIdForFunction('draft_generation')).toBe('gen-a')
  })

  it('falls back to the default model when unconfigured or stale', () => {
    useLLMStore.setState({
      models: [genModel('gen-a'), genModel('gen-b')],
      defaultModelId: 'gen-a',
      functionModels: { editor_ai: 'deleted-model' },
    })
    expect(useLLMStore.getState().modelIdForFunction('agent_chat')).toBe('gen-a')
    expect(useLLMStore.getState().modelIdForFunction('editor_ai')).toBe('gen-a')
  })

  it('prefers the configured function model when valid', () => {
    useLLMStore.setState({
      models: [genModel('gen-a'), genModel('gen-b')],
      defaultModelId: 'gen-a',
      functionModels: { outline_review: 'gen-b' },
    })
    expect(useLLMStore.getState().modelIdForFunction('outline_review')).toBe('gen-b')
  })

  it('refreshes function assignments after deleting a model', async () => {
    useLLMStore.setState({ models: [genModel('gen-a'), genModel('gen-b')], defaultModelId: 'gen-a', functionModels: { draft_generation: 'gen-b' } })
    mocks.invoke.mockImplementation((channel: string) => {
      if (channel === 'llm:delete-model') return Promise.resolve({ success: true, defaultModelId: 'gen-a' })
      if (channel === 'llm:list-models') return Promise.resolve([genModel('gen-a')])
      if (channel === 'llm:get-function-models') return Promise.resolve({ draft_generation: null })
      throw new Error(`unexpected IPC ${channel}`)
    })
    await expect(useLLMStore.getState().deleteModel('gen-b')).resolves.toBe(true)
    expect(useLLMStore.getState().functionModels).toEqual({ draft_generation: null })
  })
  it('persists setFunctionModel and mirrors it into state', async () => {
    useLLMStore.setState({ models: [genModel('gen-a')], defaultModelId: 'gen-a', functionModels: {} })
    mocks.invoke.mockResolvedValue({ success: true })
    await expect(useLLMStore.getState().setFunctionModel('editor_ai', 'gen-a')).resolves.toBe(true)
    expect(mocks.invoke).toHaveBeenCalledWith('llm:set-function-model', 'editor_ai', 'gen-a')
    expect(useLLMStore.getState().functionModels.editor_ai).toBe('gen-a')
  })
})

