import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

import { ensureElectronNativeBinding } from '../prepare-native-for-electron.mjs'

describe('prepare native dependencies for Electron development', () => {
  it('runs the Electron ABI check before the development server', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))

    expect(packageJson.scripts.predev).toBe('node scripts/prepare-native-for-electron.mjs')
  })

  it('uses the verified Electron ABI preparation for release rebuilds', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))

    expect(packageJson.scripts['rebuild:electron']).toBe('node scripts/prepare-native-for-electron.mjs')
  })

  it('returns immediately when better-sqlite3 already loads in Electron', async () => {
    const probe = vi.fn().mockReturnValue({ ok: true, diagnostic: '' })
    const rebuild = vi.fn()
    const restoreFromCache = vi.fn()

    await expect(ensureElectronNativeBinding({ probe, rebuild, restoreFromCache })).resolves.toEqual({
      repaired: false,
      fromCache: false,
    })
    expect(probe).toHaveBeenCalledOnce()
    // 已经能加载时连缓存都不该看：一次探测就够。
    expect(restoreFromCache).not.toHaveBeenCalled()
    expect(rebuild).not.toHaveBeenCalled()
  })

  it('restores the Electron ABI from cache instead of rebuilding', async () => {
    const probe = vi.fn()
      .mockReturnValueOnce({ ok: false, diagnostic: 'ABI mismatch' })
      .mockReturnValueOnce({ ok: true, diagnostic: '' })
    const rebuild = vi.fn()

    await expect(ensureElectronNativeBinding({
      probe,
      rebuild,
      restoreFromCache: () => true,
    })).resolves.toEqual({ repaired: true, fromCache: true })
    expect(rebuild).not.toHaveBeenCalled()
  })

  it('falls back to rebuilding when the cache misses or restores an unusable binary', async () => {
    const probe = vi.fn()
      .mockReturnValueOnce({ ok: false, diagnostic: 'ABI mismatch' })
      .mockReturnValueOnce({ ok: false, diagnostic: 'still broken' })
      .mockReturnValueOnce({ ok: true, diagnostic: '' })
    const rebuild = vi.fn().mockResolvedValue(undefined)

    await expect(ensureElectronNativeBinding({
      probe,
      rebuild,
      restoreFromCache: () => true,
    })).resolves.toEqual({ repaired: true, fromCache: false })
    expect(rebuild).toHaveBeenCalledOnce()
  })

  it('rebuilds only after an Electron ABI mismatch and verifies the repaired binding', async () => {
    const probe = vi.fn()
      .mockReturnValueOnce({
        ok: false,
        diagnostic: 'NODE_MODULE_VERSION 141. This version requires NODE_MODULE_VERSION 145.',
      })
      .mockReturnValueOnce({ ok: true, diagnostic: '' })
    const rebuild = vi.fn().mockResolvedValue(undefined)

    await expect(ensureElectronNativeBinding({ probe, rebuild, restoreFromCache: () => false })).resolves.toEqual({
      repaired: true,
      fromCache: false,
    })
    expect(rebuild).toHaveBeenCalledOnce()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('stops before Vite when the rebuilt binding still cannot load in Electron', async () => {
    const probe = vi.fn().mockReturnValue({
      ok: false,
      diagnostic: 'ERR_DLOPEN_FAILED',
    })

    await expect(ensureElectronNativeBinding({
      probe,
      rebuild: vi.fn().mockResolvedValue(undefined),
      restoreFromCache: () => false,
    })).rejects.toThrow('ERR_DLOPEN_FAILED')
  })
})
