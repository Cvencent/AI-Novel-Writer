/* global process */
/**
 * 本地发布：目录版打包 + 覆盖安装（不产 NSIS 安装包）。
 *
 * 覆盖安装只用到 `release/<ver>/win-unpacked/`。原来跑 `electron-builder --win`
 * 会连 NSIS 安装包一起做（压缩 + signtool 签名 + blockmap），那几步占了整条链的
 * 大半时间，产出的 setup.exe 在本地流程里从来没用上。
 *
 * 顺序也按真实依赖重排（每一步只做必要的事）：
 *   1. clean:build + typecheck   —— 只在需要时跑（--skip-checks 可跳）
 *   2. rebuild:electron          —— 打包前把原生切到 Electron ABI（缓存命中则秒过）
 *   3. vite build                —— 渲染层产物
 *   4. electron-builder --win dir —— 只出 win-unpacked
 *   5. prepare:native-node       —— 切回 Node ABI（vitest 需要）
 *   6. verify + robocopy + 烟测   —— 由 --install/--smoke 控制
 *
 * 用法：
 *   node scripts/release-local.mjs                 # 打包 + 校验
 *   node scripts/release-local.mjs --skip-checks   # 跳过 clean/typecheck（代码没动时）
 *   node scripts/release-local.mjs --install       # 覆盖安装到 F:\aiNovel\ai-novel-writer
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertInstallSucceeded,
  countInstallDirInstancesScript,
  robocopyArgs,
  stopInstallDirInstancesScript,
} from './release-local-install.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..')
const INSTALL_DIR = process.env.AI_NOVEL_INSTALL_DIR || 'F:\\aiNovel\\ai-novel-writer'
const EXPECTED_ELECTRON_ABI_SIZE = 1903104

const args = new Set(process.argv.slice(2))
const skipChecks = args.has('--skip-checks')
const doInstall = args.has('--install')
const skipSmoke = args.has('--skip-smoke')

function run(command, commandArgs, options = {}) {
  const started = Date.now()
  const result = spawnSync(command, commandArgs, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32' && /pnpm|electron-builder/u.test(command),
    windowsHide: true,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Step failed (${result.status}): ${command} ${commandArgs.join(' ')}`)
  return Date.now() - started
}

function step(label, command, commandArgs, options) {
  process.stdout.write(`\n== ${label}\n`)
  const ms = run(command, commandArgs, options)
  process.stdout.write(`   (${(ms / 1000).toFixed(1)}s)\n`)
  return ms
}

const timings = []
function timed(label, fn) {
  process.stdout.write(`\n== ${label}\n`)
  const started = Date.now()
  const value = fn()
  const ms = Date.now() - started
  timings.push([label, ms])
  process.stdout.write(`   (${(ms / 1000).toFixed(1)}s)\n`)
  return value
}

const version = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')).version
const unpackedDir = path.join(repositoryRoot, 'release', version, 'win-unpacked')

/**
 * 关掉**安装目录**里正在运行的实例（覆盖安装前必须做）。
 *
 * 只按可执行文件路径精确匹配，`F:\aiNovelWriter\qa-run\*` 下的隔离副本不受影响
 * ——那些是 QA harness 自己的实例，不属于本次覆盖安装的范围。
 * 没有实例时静默返回（首次安装）。
 */
function stopInstallDirInstances() {
  const target = path.join(INSTALL_DIR, 'AI小说作家.exe')
  const result = spawnSync('powershell', ['-NoProfile', '-Command', stopInstallDirInstancesScript(target)], {
    cwd: repositoryRoot, encoding: 'utf8', windowsHide: true,
  })
  if (result.error) throw result.error
  // 关完之后给文件系统一点时间释放句柄，否则 robocopy 仍会撞上「正在使用」。
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const still = spawnSync('powershell', ['-NoProfile', '-Command', countInstallDirInstancesScript(target)], {
      cwd: repositoryRoot, encoding: 'utf8', windowsHide: true,
    })
    if (String(still.stdout ?? '').trim() === '0') break
    spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 500'], { windowsHide: true })
  }
}

if (!skipChecks) {
  timings.push(['clean:build', run('pnpm', ['run', 'clean:build'])])
  timings.push(['typecheck', run('pnpm', ['run', 'typecheck'])])
}
// 打包前切到 Electron ABI（缓存命中时几乎免费）。
timings.push(['rebuild:electron', run('pnpm', ['run', 'rebuild:electron'])])
timings.push(['vite build', run('pnpm', ['exec', 'vite', 'build'])])
// 只出 win-unpacked：覆盖安装不需要 NSIS 安装包（省掉压缩/签名/blockmap）。
// npmRebuild=false：原生二进制上一步已经切到 Electron ABI 并探测过，
// 不让 electron-builder 再做一次依赖重建（它会重跑 @electron/rebuild 扫描）。
timings.push(['electron-builder --win dir', run('pnpm', ['exec', 'electron-builder', '--win', 'dir', '--x64', '--publish', 'never', '--config.npmRebuild=false'])])

const binding = path.join(unpackedDir, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
if (!existsSync(binding)) throw new Error(`Packaged binding missing: ${binding}`)
const size = statSync(binding).size
if (size !== EXPECTED_ELECTRON_ABI_SIZE) {
  // 切回 Node ABI 之前先报错，否则下一次 vitest 会莫名其妙全线崩。
  throw new Error(`Packaged better_sqlite3.node is ${size}, expected ${EXPECTED_ELECTRON_ABI_SIZE} (Electron ABI)`)
}
process.stdout.write(`\n   packaged better_sqlite3.node = ${size} (Electron ABI) OK\n`)

timings.push(['prepare:native-node', run('pnpm', ['run', 'prepare:native-node'])])
timings.push(['verify:win-package', run('pnpm', ['run', 'verify:win-package'])])

if (doInstall) {
  timed('robocopy → install dir', () => {
    // 先关掉**安装目录**里正在运行的实例：robocopy /MIR 要覆盖 `better_sqlite3.node`
    // 等原生文件，被运行中的进程锁住时会「错误 32 · 另一个程序正在使用此文件」，
    // 然后按 /R 重试到天荒地老（实测卡了 19 分钟、0 个文件）。只关安装目录的实例，
    // QA 隔离副本（F:\aiNovelWriter\qa-run\*）不动。
    stopInstallDirInstances()
    const result = spawnSync('robocopy', robocopyArgs(unpackedDir, INSTALL_DIR), {
      cwd: repositoryRoot, encoding: 'utf8', windowsHide: true,
    })
    if (result.error) throw result.error
    // 退出码 <8 也只表示「没有致命错误」，仍可能有文件没复制成功（这次就是），
    // 所以再核对装出来的 asar 与打包产物逐字节一致。
    const copiedAsar = path.join(INSTALL_DIR, 'resources', 'app.asar')
    assertInstallSucceeded({
      status: result.status,
      actualAsarBytes: existsSync(copiedAsar) ? statSync(copiedAsar).size : null,
      expectedAsarBytes: statSync(path.join(unpackedDir, 'resources', 'app.asar')).size,
      installDir: INSTALL_DIR,
    })
  })
}

process.stdout.write('\n== summary\n')
for (const [label, ms] of timings) process.stdout.write(`   ${label}: ${(ms / 1000).toFixed(1)}s\n`)
process.stdout.write(`\nrelease: ${unpackedDir}\n`)
if (doInstall) process.stdout.write(`installed to: ${INSTALL_DIR}${skipSmoke ? '' : ''}\n`)
