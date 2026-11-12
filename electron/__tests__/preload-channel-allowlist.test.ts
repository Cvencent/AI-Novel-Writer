import { describe, expect, it, vi } from 'vitest'
import type { AiNovelAPI } from '../../src/shared/desktop-api'

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), once: vi.fn(), send: vi.fn(), removeListener: vi.fn() },
  webFrame: { setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn() },
}))
vi.mock('electron', () => electron)
await import('../preload')

function bridge(): AiNovelAPI {
  const [, api] = electron.contextBridge.exposeInMainWorld.mock.calls[0] as [string, AiNovelAPI]
  return api
}

describe('preload IPC channel allowlist', () => {
  it('forwards a declared channel to ipcRenderer', async () => {
    electron.ipcRenderer.invoke.mockResolvedValue({ success: true })
    await expect(bridge().invoke('project:open', '合成项目')).resolves.toEqual({ success: true })
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('project:open', '合成项目')
  })

  it('rejects an undeclared channel without touching ipcRenderer.invoke', async () => {
    electron.ipcRenderer.invoke.mockClear()
    await expect(bridge().invoke('shell:open-external', 'https://evil.invalid')).rejects.toThrow('not allowed')
    expect(electron.ipcRenderer.invoke).not.toHaveBeenCalled()
  })

  it('ignores undeclared channels for on/once/send', () => {
    electron.ipcRenderer.on.mockClear()
    electron.ipcRenderer.once.mockClear()
    electron.ipcRenderer.send.mockClear()
    const unsubscribe = bridge().on('evil:channel', vi.fn())
    expect(unsubscribe).toBeTypeOf('function')
    unsubscribe()
    bridge().once('evil:channel', vi.fn())
    bridge().send('evil:channel', {})
    expect(electron.ipcRenderer.on).not.toHaveBeenCalled()
    expect(electron.ipcRenderer.once).not.toHaveBeenCalled()
    expect(electron.ipcRenderer.send).not.toHaveBeenCalled()
  })

  it('still subscribes to a declared event channel', () => {
    electron.ipcRenderer.on.mockClear()
    bridge().on('llm:stream-chunk', vi.fn())
    expect(electron.ipcRenderer.on).toHaveBeenCalledWith('llm:stream-chunk', expect.any(Function))
  })
})