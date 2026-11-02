/* global process */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { restore, save } from './native-abi-cache.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..')
const require = createRequire(import.meta.url)
const electronExecutable = require('electron')
const electronVersion = require('electron/package.json').version
const successMarker = 'BETTER_SQLITE3_ELECTRON_ABI_OK'

export function probeElectronNativeBinding(runner = spawnSync) {
  const result = runner(electronExecutable, [
    '-e',
    `const Database = require('better-sqlite3'); const db = new Database(':memory:'); const ok = db.prepare('select 1 as ok').get().ok; db.close(); if (ok !== 1) process.exit(2); process.stdout.write('${successMarker}')`,
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    windowsHide: true,
  })

  return {
    ok: result.status === 0 && String(result.stdout).includes(successMarker),
    diagnostic: String(result.stderr || result.error || '').trim(),
  }
}

async function rebuildElectronNativeBinding() {
  const { rebuild } = await import('@electron/rebuild')
  await rebuild({
    buildPath: repositoryRoot,
    electronVersion,
    force: true,
    onlyModules: ['better-sqlite3'],
  })
}

export async function ensureElectronNativeBinding({
  probe = probeElectronNativeBinding,
  rebuild = rebuildElectronNativeBinding,
  restoreFromCache = () => restore('electron'),
} = {}) {
  const initial = probe()
  if (initial.ok) return { repaired: false, fromCache: false }

  // 先试 ABI 缓存（发布加速）：命中时只是一次文件复制，不必 @electron/rebuild 现编。
  // 缓存条目按 (better-sqlite3 版本, electron 版本) 命名，恢复时校验 size 与 hash。
  if (restoreFromCache() && probe().ok) return { repaired: true, fromCache: true }

  console.log(`Preparing better-sqlite3 for Electron ${electronVersion}...`)
  await rebuild()
  const repaired = probe()
  if (!repaired.ok) {
    throw new Error(
      `better-sqlite3 still cannot load in Electron ${electronVersion}: ${repaired.diagnostic || 'unknown native module error'}`,
    )
  }
  // 现编成功后存回缓存，下一轮直接命中。
  try { save('electron') } catch { /* 缓存只是优化，不承担正确性 */ }
  return { repaired: true, fromCache: false }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const result = await ensureElectronNativeBinding()
  console.log(!result.repaired
    ? `Verified better-sqlite3 for Electron ${electronVersion}`
    : result.fromCache
      ? `Restored better-sqlite3 for Electron ${electronVersion} from ABI cache`
      : `Rebuilt and verified better-sqlite3 for Electron ${electronVersion}`)
}
