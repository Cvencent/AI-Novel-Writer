import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectIpcChannels } from '../../scripts/generate-ipc-channel-registry.mjs'
import { IPC_CHANNEL_ALLOWLIST } from '../../src/shared/ipc-channel-registry'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

describe('IPC channel registry sync', () => {
  it('allowlist matches the channels declared in source (run generate-ipc-channel-registry.mjs after adding channels)', () => {
    const expected = collectIpcChannels(root)
    expect([...IPC_CHANNEL_ALLOWLIST].sort()).toEqual(expected)
  })
})