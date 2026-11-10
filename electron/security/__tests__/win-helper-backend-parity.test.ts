import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 两个 Windows 助手后端的**协议一致性**（issue #245）。
 *
 * 原生 exe（windows-safe-file-system.exe）与 PowerShell 脚本编的是同一个
 * `windows-safe-file-system.core.cs`，但宿主与请求解析是两份代码（exe 多了 host.cs）。
 * 一旦两边对同一请求给出不同判定——尤其是**路径校验/错误码**不同——就等于既有的安全
 * 边界随「用了哪个后端」而变。所以这里逐条比对：同样的请求列表，两边必须给出**逐字相同**
 * 的响应行。
 *
 * 覆盖点：读/列/建目录/存在性、write 的两阶段（prepare→commit / prepare→cancel）、
 * 越界路径、缺失文件、目录当文件读、maxBytes 缺失/负数/超限、rootIdentity 不符、
 * 未知 operation，以及 5 种畸形请求。
 *
 * exe 不存在时（未装 .NET Framework 的构建机）整个文件跳过：它只是加速器。
 */
const PS1 = path.resolve('electron/security/windows-safe-file-system.ps1')
const EXE = path.resolve('electron/security/windows-safe-file-system.exe')
const hasWindowsPowerShell = process.platform === 'win32'

interface Backend {
  ask: (request: unknown) => Promise<string>
  close: () => void
}

/**
 * 起一个 `--serve` 后端并按行读响应。
 *
 * 只认以 `{` 开头的行：`powershell.exe -File` 会在 stdout 顶上打
 * "Windows PowerShell / Copyright" 横幅，其余行不是协议内容。
 */
function startBackend(command: string, args: string[]): Backend {
  const child: ChildProcessWithoutNullStreams = spawn(command, args, {
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  const waiters: Array<(line: string) => void> = []
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line.startsWith('{')) {
        const waiter = waiters.shift()
        if (waiter) waiter(line)
      }
      index = buffer.indexOf('\n')
    }
  })
  child.stderr.resume()
  return {
    ask: request => new Promise<string>(resolve => {
      waiters.push(resolve)
      child.stdin.write(`${typeof request === 'string' ? request : JSON.stringify(request)}\n`, 'utf8')
    }),
    close: () => { child.kill() },
  }
}

describe.skipIf(!hasWindowsPowerShell || !existsSync(EXE))('Windows helper backend parity (issue #245)', () => {
  it('answers every request identically on the PowerShell and native backends', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'win-helper-parity-'))
    mkdirSync(path.join(root, 'sub'))
    writeFileSync(path.join(root, 'sub', 'a.txt'), '中文正文 content', 'utf8')
    const info = statSync(root, { bigint: true })
    const rootIdentity = { volumeSerialNumber: String(info.dev), fileIndex: String(info.ino) }
    const base = { rootPath: root, rootIdentity }

    const requests: unknown[] = [
      { ...base, operation: 'exists', relativePath: 'sub/a.txt' },
      { ...base, operation: 'exists', relativePath: 'sub/missing.txt' },
      { ...base, operation: 'read', relativePath: 'sub/a.txt', maxBytes: 1048576 },
      { ...base, operation: 'read', relativePath: 'sub/missing.txt', maxBytes: 1048576 },
      { ...base, operation: 'read', relativePath: 'sub', maxBytes: 1048576 },
      { ...base, operation: 'read', relativePath: 'sub/a.txt' },
      { ...base, operation: 'read', relativePath: 'sub/a.txt', maxBytes: -1 },
      { ...base, operation: 'read', relativePath: 'sub/a.txt', maxBytes: 99999999 },
      { ...base, operation: 'list', relativePath: 'sub' },
      { ...base, operation: 'list', relativePath: '' },
      { ...base, operation: 'mkdir', relativePath: 'newdir/deep' },
      { ...base, operation: 'mkdir', relativePath: 'sub/../escape' },
      { ...base, operation: 'unknown-operation', relativePath: 'sub/a.txt' },
      { ...base, operation: 'write', relativePath: 'sub/new.txt', contentBase64: Buffer.from('新建', 'utf8').toString('base64') },
      { ...base, operation: 'write', relativePath: 'sub/a.txt' },
      { ...base, operation: 'write', relativePath: 'sub/never.txt', contentBase64: Buffer.from('x', 'utf8').toString('base64'), mustAlreadyExist: true },
      { ...base, operation: 'read', relativePath: '../outside.txt', maxBytes: 100 },
      { ...base, operation: 'read', relativePath: 'sub/a.txt', maxBytes: 1048576, rootIdentity: { volumeSerialNumber: '1', fileIndex: '1' } },
      // 畸形请求：两边都必须拒绝，且给出同一码值。
      '{}',
      'not json',
      '{"operation":"read"}',
      '""',
      '{"operation":"read","rootPath":1,"relativePath":[],"rootIdentity":{}}',
    ]

    const powershell = startBackend('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, '--serve',
    ])
    const native = startBackend(EXE, ['--serve'])
    try {
      const differences: string[] = []
      for (const [index, request] of requests.entries()) {
        const left = await powershell.ask(request)
        const right = await native.ask(request)
        if (left !== right) {
          differences.push(`#${index} ${JSON.stringify(request).slice(0, 120)}\n  ps1=${left}\n  exe=${right}`)
        }
      }
      expect(differences.join('\n')).toBe('')
    } finally {
      powershell.close()
      native.close()
    }
  }, 120_000)

  it('commits and cancels an atomic write identically on both backends', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'win-helper-atomic-'))
    mkdirSync(path.join(root, 'sub'))
    const info = statSync(root, { bigint: true })
    const rootIdentity = { volumeSerialNumber: String(info.dev), fileIndex: String(info.ino) }
    const backends: Array<[string, Backend]> = [
      ['powershell', startBackend('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, '--serve'])],
      ['native', startBackend(EXE, ['--serve'])],
    ]
    const results: string[] = []
    try {
      for (const [label, backend] of backends) {
        // create（不要求已存在）→ commit。正文两个后端必须用**同一份**，
        // 否则比较的是我这份载荷的长度差而不是后端行为差。
        const create = await backend.ask({
          operation: 'write', rootPath: root, rootIdentity, relativePath: `${label}-create.txt`,
          contentBase64: Buffer.from('CREATED-PAYLOAD', 'utf8').toString('base64'),
        })
        const committed = await backend.ask({ command: 'commit' })
        const created = statSync(path.join(root, `${label}-create.txt`)).size
        // prepare → cancel：不得落盘
        writeFileSync(path.join(root, `${label}-cancel.txt`), 'ORIGINAL', 'utf8')
        const prepared = await backend.ask({
          operation: 'write', rootPath: root, rootIdentity, relativePath: `${label}-cancel.txt`,
          contentBase64: Buffer.from('MUST-NOT-APPLY', 'utf8').toString('base64'), mustAlreadyExist: true,
        })
        const cancelled = await backend.ask({ command: 'cancel' })
        const cancelledSize = statSync(path.join(root, `${label}-cancel.txt`)).size
        // 归一化掉文件名里的后端名，只比较结构化的时序与结果码。
        results.push(JSON.stringify({
          create: create.replace(new RegExp(label, 'g'), 'X'),
          committed,
          created,
          prepared: prepared.replace(new RegExp(label, 'g'), 'X'),
          cancelled,
          cancelledSize,
        }))
      }
      expect(results[0]).toBe(results[1])
    } finally {
      for (const [, backend] of backends) backend.close()
    }
  }, 120_000)
})
