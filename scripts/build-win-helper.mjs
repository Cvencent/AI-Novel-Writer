/* global process */
/**
 * 编译 Windows 原生安全文件助手（issue #245）。
 *
 * 为什么要有原生 exe：PowerShell 助手每次要付 ~183ms 进程启动 + ~210ms Add-Type
 * 现场编译（真正干活只 1-4ms），常驻又要 84MB 内存所以只能空闲退出、一停就再付一遍。
 * 同一个 C# 安全实现（windows-safe-file-system.core.cs）编成 exe 后实测：
 *   启动 ~25ms、每请求 ~0.04ms、常驻 13MB —— 小到可以一直留着。
 *
 * 安全判据一行不改：exe 与 PS1 编的是**同一个 core.cs**，exe 只多了协议层 host.cs。
 * 两个后端的响应由 electron/security/__tests__/win-helper-backend-parity.test.ts 逐条比对。
 *
 * 构建策略（fail-open，不阻断打包）：
 * - 找到 csc 就编译；找不到（非 Windows、没有 .NET Framework、没装 MSVC）就**跳过**，
 *   产物缺失时运行时自动退回 PS1 助手，功能不受影响。
 * - 编译失败同样只警告：绝不能因为一个可选加速器让整条打包链挂掉。
 *
 * 用法：
 *   node scripts/build-win-helper.mjs            # 需要时编译（已是最新则跳过）
 *   node scripts/build-win-helper.mjs --force    # 强制重编
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const securityDirectory = path.join(repositoryRoot, 'electron', 'security')
const CORE = path.join(securityDirectory, 'windows-safe-file-system.core.cs')
const HOST = path.join(securityDirectory, 'windows-safe-file-system.host.cs')
const EXE = path.join(securityDirectory, 'windows-safe-file-system.exe')
const STAMP = `${EXE}.buildstamp`
/** 与 core.cs 里的 MaxTextBytes 同量级：源码变一点就要重编。 */
const SOURCES = [CORE, HOST]

function log(message) {
  process.stdout.write(`[win-helper] ${message}\n`)
}

/** 源码指纹：任一个源文件变了就得重编（--force 也走这条路）。 */
function sourceFingerprint() {
  const hash = createHash('sha256')
  for (const file of SOURCES) {
    hash.update(path.basename(file))
    hash.update(readFileSync(file))
  }
  // csc 版本也进指纹：换了编译工具链应当重编，而不是沿用旧二进制。
  const compiler = resolveCompiler()
  hash.update(compiler ? compiler.version : 'no-compiler')
  return hash.digest('hex')
}

const CSC_CANDIDATES = [
  // .NET Framework 4.x（所有 Windows 自带；本仓库构建机的实测路径）
  path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
]

let cachedCompiler
function resolveCompiler() {
  if (cachedCompiler !== undefined) return cachedCompiler
  if (process.platform !== 'win32') { cachedCompiler = null; return cachedCompiler }
  for (const candidate of CSC_CANDIDATES) {
    if (!existsSync(candidate)) continue
    const probe = spawnSync(candidate, ['-nologo', '-help'], { encoding: 'utf8', windowsHide: true })
    const version = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.split('\n').find(line => /version/i.test(line))?.trim()
    cachedCompiler = { path: candidate, version: version ?? 'unknown' }
    return cachedCompiler
  }
  cachedCompiler = null
  return cachedCompiler
}

function needsRebuild(force) {
  if (force) return true
  if (!existsSync(EXE)) return true
  if (!existsSync(STAMP)) return true
  try {
    return readFileSync(STAMP, 'utf8').trim() !== sourceFingerprint()
  } catch { return true }
}

export function buildWinHelper({ force = false } = {}) {
  const compiler = resolveCompiler()
  if (!compiler) {
    log('no csc.exe found — skipping native helper (runtime falls back to the PowerShell helper)')
    return { built: false, reason: 'no-compiler' }
  }
  if (!needsRebuild(force)) {
    log(`up to date (${path.basename(EXE)})`)
    return { built: false, reason: 'up-to-date' }
  }
  // 先删旧产物：编译失败时绝不能留下一个「看起来能用」的旧 exe（那会让版本漂移）。
  rmSync(EXE, { force: true })
  rmSync(STAMP, { force: true })
  const staging = `${EXE}.building`
  rmSync(staging, { force: true })
  const result = spawnSync(compiler.path, [
    '-nologo',
    '-optimize+',
    '-target:exe',
    // 与 Electron 的 win x64 目标一致；也避免在 32 位宿主上加载错位数。
    '-platform:x64',
    `-out:${staging}`,
    CORE,
    HOST,
  ], { encoding: 'utf8', windowsHide: true })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.status !== 0 || !existsSync(staging)) {
    rmSync(staging, { force: true })
    log(`compile failed (status=${result.status}) — skipping native helper, PowerShell fallback stays in use`)
    if (output) log(output.split('\n').slice(0, 20).join('\n'))
    return { built: false, reason: 'compile-failed' }
  }
  // 校验产物是一个像样的 PE32+ 可执行文件再落位（防止 csc 半途写出个残件）。
  const bytes = statSync(staging).size
  const header = readFileSync(staging).subarray(0, 2)
  if (bytes < 4096 || header[0] !== 0x4d || header[1] !== 0x5a) {
    rmSync(staging, { force: true })
    log(`compiled artifact rejected (size=${bytes}) — keeping the PowerShell fallback`)
    return { built: false, reason: 'invalid-artifact' }
  }
  writeFileSync(STAMP, `${sourceFingerprint()}\n`)
  mkdirSync(path.dirname(EXE), { recursive: true })
  rmSync(EXE, { force: true })
  // rename 而非复制：同目录内原子替换，不会留下半个文件。
  spawnSync('cmd.exe', ['/c', 'move', '/y', staging, EXE], { windowsHide: true })
  if (!existsSync(EXE)) {
    log('artifact placement failed — keeping the PowerShell fallback')
    return { built: false, reason: 'placement-failed' }
  }
  log(`built ${path.basename(EXE)} (${(bytes / 1024).toFixed(0)} KB)`)
  return { built: true, bytes }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase().endsWith('build-win-helper.mjs')
if (invokedDirectly) {
  try {
    buildWinHelper({ force: process.argv.includes('--force') })
  } catch (error) {
    // 构建脚本自身出错也不能阻断打包。
    log(`unexpected failure: ${String(error)}`)
  }
}
