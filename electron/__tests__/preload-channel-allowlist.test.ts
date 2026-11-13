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
/**
 * issue #245 现场：白名单是自动生成的，但生成脚本只认字面量 `ipcMain.handle('...')`，
 * 于是漏掉了两类真实存在的注册方式——
 *   ① 依赖注入式 `deps.ipc.handle('cloud-backup:backup', ...)`；
 *   ② 只写在类型契约里的 `startup:get-state`（`startup-contract.ts` 的 StartupChannels）。
 * 而 preload 现在会**拒绝**任何不在白名单里的通道，所以
 * `startup:get-state` 一漏 → 渲染层连"主进程就绪"都问不到 → 工作台卡在启动页，
 * 用户看到「启动尚未完成 … 工作台尚未加载」。整个软件打不开。
 *
 * 这条测试把「渲染层实际使用的通道 ⊆ 白名单」变成硬约束：
 * 以后谁再新增通道而忘了重新生成白名单，测试当场就红。
 */
describe('every renderer-used channel is allowlisted (issue #245 现场)', () => {
  it('has no renderer channel missing from the allowlist', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { IPC_CHANNEL_ALLOWLIST } = await import('../../src/shared/ipc-channel-registry')
    const isChannel = (s: string) => /^[a-z][a-z0-9-]*(:[a-z0-9-]+)+$/.test(s)
    const used = new Map<string, string[]>()
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (['__tests__', 'node_modules', '.runtime'].includes(e.name)) continue
          walk(fp)
        } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) && !/\.browser\./.test(e.name)) {
          const text = fs.readFileSync(fp, 'utf8')
          /**
           * ⚠️ `invokeWithProjectSession` 的通道是**第二个参数**（第一个是项目会话），
           * 写成 `ipc.invokeWithProjectSession(session, 'review-revision:prepare', ...)`。
           * 只匹配 `invoke('channel'` 会把这一整类漏掉——正是 review-revision:prepare
           * 没被发现的原因。所以要分别匹配两种形状。
           */
          for (const re of [
            /ipc\.invokeWithProjectSession\(\s*[^,]+,\s*'([^']+)'/g,
            /ipc\.invoke\(\s*'([^']+)'/g,
            /ipc\.on\(\s*'([^']+)'/g,
            /ipc\.send\(\s*'([^']+)'/g,
          ]) {
            let m: RegExpExecArray | null
            while ((m = re.exec(text))) if (isChannel(m[1])) {
              if (!used.has(m[1])) used.set(m[1], [])
              used.get(m[1])!.push(path.relative(process.cwd(), fp))
            }
          }
        }
      }
    }
    walk(path.join(process.cwd(), 'src'))
    const missing = [...used.keys()].filter(c => !IPC_CHANNEL_ALLOWLIST.has(c)).sort()
    expect(missing, `这些渲染层通道不在白名单里，preload 会拒绝、界面会静默失效：\n`
      + missing.map(c => `  ${c} ← ${used.get(c)!.slice(0, 2).join(', ')}`).join('\n')
      + `\n请运行 node scripts/generate-ipc-channel-registry.mjs 重新生成。`).toEqual([])
  })
})


/**
 * 反向也要查：主进程注册的通道必须全在白名单里。
 *
 * 生成脚本靠扫源码，而注册写法有好几种（`ipcMain.handle`、`deps.ipc.handle`、
 * 控制器内部的 `register('channel', 1, fn)` 助手）。少扫一种，白名单就少一批通道，
 * 渲染层调用时当场 `IPC channel not allowed`——现场是 `review-revision:prepare`
 * 漏登记，作者一点 AI 审稿就报错。
 */
describe('every main-registered channel is allowlisted (issue #245 现场)', () => {
  it('has no registered channel missing from the allowlist', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { IPC_CHANNEL_ALLOWLIST } = await import('../../src/shared/ipc-channel-registry')
    const isChannel = (s: string) => /^[a-z][a-z0-9-]*(:[a-z0-9-]+)+$/.test(s)
    const found = new Map<string, string[]>()
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (['__tests__', 'node_modules'].includes(e.name)) continue
          walk(fp)
        } else if (e.name.endsWith('.ts') && !/\.test\.ts$/.test(e.name)) {
          const t = fs.readFileSync(fp, 'utf8')
          for (const re of [/(?:ipcMain|\.ipc)\.(?:handle|handleOnce|on)\(\s*'([^']+)'/g, /register\(\s*'([^']+)'/g]) {
            let m: RegExpExecArray | null
            while ((m = re.exec(t))) if (isChannel(m[1])) {
              if (!found.has(m[1])) found.set(m[1], [])
              found.get(m[1])!.push(path.relative(process.cwd(), fp))
            }
          }
        }
      }
    }
    walk(path.join(process.cwd(), 'electron'))
    const missing = [...found.keys()].filter(c => !IPC_CHANNEL_ALLOWLIST.has(c)).sort()
    expect(missing, '这些主进程注册的通道不在白名单里，渲染层调用会被 preload 拒绝：\n'
      + missing.map(c => `  ${c} ← ${found.get(c)!.slice(0, 2).join(', ')}`).join('\n')
      + '\n请运行 node scripts/generate-ipc-channel-registry.mjs 重新生成。').toEqual([])
  })
})
