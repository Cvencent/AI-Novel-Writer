/* global process */
/**
 * better-sqlite3 原生二进制的 ABI 缓存（发布加速）。
 *
 * 问题：better-sqlite3 只有一份 `build/Release/better_sqlite3.node`，Node ABI(127)
 * 与 Electron ABI 每轮发布要来回切两次，每次都靠 @electron/rebuild / prebuild-install
 * 现编或现下——这是发布链里少数几个真正耗时的步骤之一，而且一旦忘记切回 Node ABI，
 * 下一次 vitest 会全线崩。
 *
 * 做法：把两种 ABI 的产物各存一份在 `.runtime/native-abi-cache/`，按
 * (better-sqlite3 版本, 目标 runtime 版本, ABI) 命名。需要哪种就整文件拷过去，
 * 命中缓存时是单次文件复制，且**可校验**：拷完立刻探测。
 *
 * 用法：
 *   node scripts/native-abi-cache.mjs save node|electron   # 把当前产物存进缓存
 *   node scripts/native-abi-cache.mjs restore node|electron # 从缓存恢复（未命中则退出码 3）
 *   node scripts/native-abi-cache.mjs status
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..')
const require = createRequire(import.meta.url)

/** 期望的文件大小（字节）：与 ABI 一一对应，用来做零成本的健全性检查。 */
export const EXPECTED_SIZE = Object.freeze({ node: 1902080, electron: 1903104 })

export function bindingPath(root = repositoryRoot) {
  return path.join(root, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
}

function packageVersion(root, name) {
  return JSON.parse(readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version
}

/** 缓存键：同一份 better-sqlite3 对同一目标 runtime 版本的产物唯一。 */
export function cacheKey(target, root = repositoryRoot) {
  if (target !== 'node' && target !== 'electron') throw new Error(`Unknown native target: ${target}`)
  const betterSqliteVersion = packageVersion(root, 'better-sqlite3')
  const runtimeVersion = target === 'electron'
    ? packageVersion(root, 'electron')
    : process.versions.node
  return { target, betterSqliteVersion, runtimeVersion, fileName: `better_sqlite3.${target}.${betterSqliteVersion}.${runtimeVersion}.node` }
}

export function cacheDir(root = repositoryRoot) {
  return path.join(root, '.runtime', 'native-abi-cache')
}

export function cacheEntryPath(target, root = repositoryRoot) {
  return path.join(cacheDir(root), cacheKey(target, root).fileName)
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 把当前产物存进缓存（附带 size/hash 便于校验），返回缓存条目路径。 */
export function save(target, root = repositoryRoot) {
  const from = bindingPath(root)
  if (!existsSync(from)) throw new Error(`Native binding not found: ${from}`)
  const entry = cacheEntryPath(target, root)
  mkdirSync(cacheDir(root), { recursive: true })
  copyFileSync(from, entry)
  const size = statSync(entry).size
  writeFileSync(`${entry}.json`, `${JSON.stringify({ ...cacheKey(target, root), size, sha256: sha256(entry) }, null, 2)}\n`)
  return entry
}

/**
 * 从缓存恢复到 node_modules。未命中返回 false（调用方回退到编译/下载）。
 * 校验 size 与 hash：缓存本身被截断或污染时必须拒绝，不能把坏文件装进去。
 */
export function restore(target, root = repositoryRoot) {
  const entry = cacheEntryPath(target, root)
  const metaPath = `${entry}.json`
  if (!existsSync(entry) || !existsSync(metaPath)) return false
  let meta
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  } catch {
    return false
  }
  if (meta?.size !== statSync(entry).size || meta?.sha256 !== sha256(entry)) return false
  const to = bindingPath(root)
  mkdirSync(path.dirname(to), { recursive: true })
  copyFileSync(entry, to)
  return true
}

export function status(root = repositoryRoot) {
  const binding = bindingPath(root)
  const current = existsSync(binding) ? statSync(binding).size : 0
  const known = Object.entries(EXPECTED_SIZE).find(([, size]) => size === current)?.[0] ?? 'unknown'
  return {
    binding,
    currentSize: current,
    currentAbi: known,
    cached: {
      node: existsSync(cacheEntryPath('node', root)),
      electron: existsSync(cacheEntryPath('electron', root)),
    },
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const [, , command, targetArg] = process.argv
  const target = targetArg === 'electron' ? 'electron' : targetArg === 'node' ? 'node' : undefined
  if (command === 'status') {
    const result = status()
    console.log(`better-sqlite3 ABI: ${result.currentAbi} (${result.currentSize} bytes)`)
    console.log(`cache: node=${result.cached.node ? 'hit' : 'miss'} electron=${result.cached.electron ? 'hit' : 'miss'}`)
  } else if (command === 'save' && target) {
    console.log(`cached ${target}: ${save(target)}`)
  } else if (command === 'restore' && target) {
    if (restore(target)) {
      console.log(`restored ${target} ABI from cache (${statSync(bindingPath()).size} bytes)`)
    } else {
      console.log(`no usable ${target} cache entry`)
      process.exit(3)
    }
  } else {
    console.error('usage: native-abi-cache.mjs <save|restore|status> [node|electron]')
    process.exit(2)
  }
}
