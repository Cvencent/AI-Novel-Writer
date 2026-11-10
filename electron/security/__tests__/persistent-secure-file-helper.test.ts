import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { PersistentSecureFileHelper } from '../persistent-secure-file-helper'

type Responder = (request: Record<string, unknown>, index: number) => string | null

/** 假助手：逐行读请求，按脚本回一行 JSON；返回 null 表示不回（模拟挂起）。 */
function fakeHelper(respond: Responder): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let index = 0
  let buffer = ''
  stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let cut = buffer.indexOf('\n')
    while (cut >= 0) {
      const line = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 1)
      if (line.trim()) {
        const reply = respond(JSON.parse(line) as Record<string, unknown>, index)
        index += 1
        if (reply !== null) stdout.write(reply + '\n')
      }
      cut = buffer.indexOf('\n')
    }
  })
  const child = new PassThrough() as unknown as ChildProcessWithoutNullStreams
  Object.assign(child, { stdin, stdout, stderr, kill: vi.fn() })
  return child
}

function helper(respond: Responder) {
  return new PersistentSecureFileHelper({
    spawnHelper: () => ({ command: 'fake', args: [] }),
    spawnProcess: () => fakeHelper(respond),
    timeoutMs: 5_000,
    idleTimeoutMs: 0,
  })
}

describe('persistent secure file helper (issue #245)', () => {
  it('round-trips sequential requests on one process', async () => {
    let spawned = 0
    const instance = new PersistentSecureFileHelper({
      spawnHelper: () => ({ command: 'fake', args: [] }),
      spawnProcess: () => { spawned += 1; return fakeHelper((_request, index) => `{"ok":true,"n":${index}}`) },
      timeoutMs: 5_000,
      idleTimeoutMs: 0,
    })
    expect(JSON.parse(await instance.request({ operation: 'list' }))).toEqual({ ok: true, n: 0 })
    expect(JSON.parse(await instance.request({ operation: 'list' }))).toEqual({ ok: true, n: 1 })
    expect(JSON.parse(await instance.request({ operation: 'exists' }))).toEqual({ ok: true, n: 2 })
    expect(spawned).toBe(1)
    instance.dispose()
  })

  // 回归：`powershell.exe -File` 会在 stdout 顶上打 "Windows PowerShell / Copyright"
  // 横幅（一次性模式靠「取最后一行」侥幸绕过）。常驻模式读第一行当响应，必须跳过非 JSON 行，
  // 否则首请求永远被解析成坏响应 → 退回一次性模式（本机实测开书仍卡 0.5s/次）。
  it('skips the PowerShell banner lines printed before the first response', async () => {
    const instance = new PersistentSecureFileHelper({
      spawnHelper: () => ({ command: 'fake', args: [] }),
      spawnProcess: () => {
        const child = fakeHelper(() => '{"ok":true,"pong":1}')
        ;(child.stdout as PassThrough).write('Windows PowerShell\r\nCopyright (C) Microsoft Corporation. All rights reserved.\r\n\r\n')
        return child
      },
      timeoutMs: 3_000,
      idleTimeoutMs: 0,
    })
    expect(JSON.parse(await instance.request({ operation: 'list' }))).toEqual({ ok: true, pong: 1 })
    instance.dispose()
  })

  it('keeps serving after a request the helper rejects', async () => {
    const instance = helper((request, index) => request.operation === 'bad'
      ? '{"ok":false,"code":"SECURE_FS_INVALID_OPERATION"}'
      : `{"ok":true,"n":${index}}`)
    expect(JSON.parse(await instance.request({ operation: 'bad' }))).toEqual({ ok: false, code: 'SECURE_FS_INVALID_OPERATION' })
    expect(JSON.parse(await instance.request({ operation: 'list' }))).toEqual({ ok: true, n: 1 })
    instance.dispose()
  })

  it('runs the atomic write guard between prepare and commit on the same process', async () => {
    const seen: string[] = []
    const instance = helper(request => {
      seen.push(String(request.operation ?? request.command))
      if (request.operation === 'write') return '{"ok":true,"phase":"ready"}'
      if (request.command === 'commit') return '{"ok":true}'
      return '{"ok":false,"code":"SECURE_FS_INVALID_OPERATION"}'
    })
    const guard = vi.fn()
    expect(JSON.parse(await instance.atomicWrite({ operation: 'write' }, guard))).toEqual({ ok: true })
    expect(guard).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['write', 'commit'])
    instance.dispose()
  })

  it('cancels and rethrows the guard error without committing', async () => {
    const seen: string[] = []
    const instance = helper(request => {
      seen.push(String(request.operation ?? request.command))
      if (request.operation === 'write') return '{"ok":true,"phase":"ready"}'
      return '{"ok":true}'
    })
    await expect(instance.atomicWrite({ operation: 'write' }, () => { throw new Error('guard rejected') }))
      .rejects.toThrow('guard rejected')
    expect(seen).toEqual(['write', 'cancel'])
    instance.dispose()
  })

  it('marks a commit-phase channel failure as unknown, never as not-committed', async () => {
    const instance = new PersistentSecureFileHelper({
      spawnHelper: () => ({ command: 'fake', args: [] }),
      spawnProcess: () => fakeHelper(request => request.operation === 'write' ? '{"ok":true,"phase":"ready"}' : null),
      timeoutMs: 300,
      idleTimeoutMs: 0,
    })
    await expect(instance.atomicWrite({ operation: 'write' }, () => {})).rejects.toMatchObject({ commitState: 'unknown' })
    instance.dispose()
  })

  it('marks a prepare-phase failure as not-committed', async () => {
    const instance = helper(() => '{"ok":false,"code":"SECURE_FS_INVALID_PATH"}')
    await expect(instance.atomicWrite({ operation: 'write' }, () => {})).rejects.toMatchObject({ commitState: 'not_committed' })
    instance.dispose()
  })

  it('fails every pending request when the process dies', async () => {
    let current: ChildProcessWithoutNullStreams | null = null
    let spawned = 0
    const instance = new PersistentSecureFileHelper({
      spawnHelper: () => ({ command: 'fake', args: [] }),
      spawnProcess: () => { spawned += 1; current = fakeHelper(() => null); return current },
      timeoutMs: 5_000,
      idleTimeoutMs: 0,
    })
    const pending = instance.request({ operation: 'list' })
    await new Promise(resolve => setTimeout(resolve, 20))
    current!.emit('close')
    await expect(pending).rejects.toThrow('SECURE_FS_HELPER_UNAVAILABLE')
    expect(spawned).toBe(1)
    instance.dispose()
  })

  it('never starts a new process after dispose', async () => {
    let spawned = 0
    const instance = new PersistentSecureFileHelper({
      spawnHelper: () => ({ command: 'fake', args: [] }),
      spawnProcess: () => { spawned += 1; return fakeHelper(() => '{"ok":true}') },
      timeoutMs: 1_000,
      idleTimeoutMs: 0,
    })
    instance.dispose()
    await expect(instance.request({ operation: 'list' })).rejects.toThrow('SECURE_FS_HELPER_UNAVAILABLE')
    expect(spawned).toBe(0)
  })
})
