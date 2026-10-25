import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler)
    }),
  },
}))

let fixtureRoot = ''
let velaHome = ''

function handler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}

const profile = { id: 'gen-1', name: 'Gen 1', provider: 'custom', protocol: 'openai', modelName: 'm', apiKey: '', baseUrl: '', temperature: 0.7, maxTokens: 1024, purposes: ['generation'] }

beforeEach(async () => {
  vi.resetModules()
  mocks.handlers.clear()
  velaHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-function-models-'))
  fixtureRoot = velaHome
  velaHome = await (await import('../../services/__tests__/global-data-fixture')).prepareGlobalDataFixture(fixtureRoot)
  const { registerLLMController } = await import('../llm-controller')
  registerLLMController()
})

afterEach(() => {
  delete process.env.AI_NOVEL_VELA_HOME
  delete process.env.AI_NOVEL_APP_DATA_HOME
  fs.rmSync(fixtureRoot, { recursive: true, force: true })
})

describe('per-function model configuration', () => {
  it('round-trips a function model assignment and stores empty strings as null', async () => {
    await expect(handler('llm:set-function-model')({}, 'draft_generation', 'gen-1')).resolves.toEqual({ success: true })
    expect(JSON.parse(fs.readFileSync(path.join(velaHome, 'config.json'), 'utf8')).functionModelIds)
      .toMatchObject({ draft_generation: 'gen-1' })
    await expect(handler('llm:set-function-model')({}, 'editor_ai', '  ')).resolves.toEqual({ success: true })
    await expect(handler('llm:get-function-models')({})).resolves.toEqual({ draft_generation: 'gen-1', editor_ai: null })
  })

  it('rejects unknown keys without touching the config file', async () => {
    await expect(handler('llm:set-function-model')({}, 'draft_generation', 'gen-1')).resolves.toEqual({ success: true })
    const configPath = path.join(velaHome, 'config.json')
    const before = fs.readFileSync(configPath)
    await expect(handler('llm:set-function-model')({}, 'not_a_key', 'gen-1')).resolves.toMatchObject({ success: false })
    expect(fs.readFileSync(configPath)).toEqual(before)
  })

  it('refuses to overwrite a malformed config file', async () => {
    const configPath = path.join(velaHome, 'config.json')
    const originalBytes = Buffer.from('{BROKEN_FUNCTION_MODEL_MARKER', 'utf8')
    fs.writeFileSync(configPath, originalBytes)
    await expect(handler('llm:set-function-model')({}, 'draft_generation', 'gen-1')).resolves.toMatchObject({ success: false })
    expect(fs.readFileSync(configPath)).toEqual(originalBytes)
  })

  it('clears assignments to a deleted model', async () => {
    await expect(handler('llm:save-model')({}, profile)).resolves.toEqual({ success: true })
    await expect(handler('llm:set-function-model')({}, 'draft_generation', 'gen-1')).resolves.toEqual({ success: true })
    await expect(handler('llm:delete-model')({}, 'gen-1')).resolves.toMatchObject({ success: true })
    await expect(handler('llm:get-function-models')({})).resolves.toEqual({ draft_generation: null })
  })
})

