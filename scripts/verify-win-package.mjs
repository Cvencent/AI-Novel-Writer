import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..')

export function findLanceBinding(unpackedDir) {
  const packageDir = path.join(
    unpackedDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    '@lancedb',
    'lancedb-win32-x64-msvc',
  )
  if (!existsSync(packageDir)) return null

  const pending = [packageDir]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(fullPath)
      if (entry.isFile() && entry.name.endsWith('.node')) return fullPath
    }
  }
  return null
}

export function findBetterSqliteBinding(unpackedDir) {
  const binding = path.join(
    unpackedDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
  )
  return existsSync(binding) ? binding : null
}

export function findWindowsSafeFileSystemHelper(unpackedDir) {
  const helper = path.join(
    unpackedDir,
    'resources',
    'security',
    'windows-safe-file-system.ps1',
  )
  return existsSync(helper) ? helper : null
}

/** PS1 运行时读取的 C# 安全核（唯一源；原生 exe 也编译它）。 */
export function findWindowsSafeFileSystemCore(unpackedDir) {
  const core = path.join(
    unpackedDir,
    'resources',
    'security',
    'windows-safe-file-system.core.cs',
  )
  return existsSync(core) ? core : null
}

/**
 * 原生助手（可选加速器）。
 *
 * 与 PS1 核不同，这里**不**硬性要求存在：没有它运行时退回 PS1，功能完整。
 * 但一旦打包进了一个，就必须是像样的 PE32+ 可执行文件——半个残件比没有更危险
 * （会以「起不来」的形式把每次 fs 操作拖成超时）。
 */
export function findWindowsNativeHelper(unpackedDir) {
  const helper = path.join(
    unpackedDir,
    'resources',
    'security',
    'windows-safe-file-system.exe',
  )
  if (!existsSync(helper)) return null
  const header = readFileSync(helper).subarray(0, 2)
  if (header[0] !== 0x4d || header[1] !== 0x5a) {
    throw new Error(`Packaged native secure file-system helper is not a PE executable: ${helper}`)
  }
  if (statSync(helper).size < 4096) {
    throw new Error(`Packaged native secure file-system helper is implausibly small: ${helper}`)
  }
  return helper
}

export function verifyWindowsPackage(unpackedDir) {
  const asar = path.join(unpackedDir, 'resources', 'app.asar')
  const executable = path.join(unpackedDir, 'AI小说作家.exe')
  for (const required of [asar, executable]) {
    if (!existsSync(required)) throw new Error(`Missing required package file: ${required}`)
  }

  const nativeBinding = findLanceBinding(unpackedDir)
  if (!nativeBinding) throw new Error('Missing LanceDB Windows native binding')
  const betterSqliteBinding = findBetterSqliteBinding(unpackedDir)
  if (!betterSqliteBinding) throw new Error('Missing better-sqlite3 Windows native binding')
  const secureFileSystemHelper = findWindowsSafeFileSystemHelper(unpackedDir)
  if (!secureFileSystemHelper) throw new Error('Missing Windows secure file-system helper')
  const secureFileSystemCore = findWindowsSafeFileSystemCore(unpackedDir)
  if (!secureFileSystemCore) throw new Error('Missing Windows secure file-system C# core')
  // 原生助手是可选的：null 表示这份包只有 PS1 后端（运行时自动退回）。
  const nativeSecureFileSystemHelper = findWindowsNativeHelper(unpackedDir)

  return { asar, executable, nativeBinding, betterSqliteBinding, secureFileSystemHelper,
    secureFileSystemCore, nativeSecureFileSystemHelper }
}

export function verifyPackagedLanceLoad(unpackedDir, runner = spawnSync) {
  const executable = path.join(unpackedDir, 'AI小说作家.exe')
  const marker = 'PACKAGED_LANCEDB_LOAD_OK'
  const result = runner(
    executable,
    [
      '-e',
      `require('./resources/app.asar/node_modules/@lancedb/lancedb'); process.stdout.write('${marker}')`,
    ],
    {
      cwd: unpackedDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      windowsHide: true,
    },
  )

  if (result.status !== 0) {
    throw new Error(`Packaged LanceDB load failed: ${String(result.stderr ?? '').trim()}`)
  }
  if (!String(result.stdout ?? '').includes(marker)) {
    throw new Error('Packaged LanceDB load did not return its success marker')
  }
  return marker
}

export function verifyPackagedBetterSqliteLoad(unpackedDir, runner = spawnSync) {
  const executable = path.join(unpackedDir, 'AI小说作家.exe')
  const marker = 'PACKAGED_BETTER_SQLITE3_LOAD_OK'
  const result = runner(
    executable,
    [
      '-e',
      `const Database = require('./resources/app.asar/node_modules/better-sqlite3'); const db = new Database(':memory:'); const ok = db.prepare('select 1 as ok').get().ok; db.close(); if (ok !== 1) process.exit(2); process.stdout.write('${marker}')`,
    ],
    {
      cwd: unpackedDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      windowsHide: true,
    },
  )

  if (result.status !== 0) {
    throw new Error(`Packaged better-sqlite3 load failed: ${String(result.stderr ?? '').trim()}`)
  }
  if (!String(result.stdout ?? '').includes(marker)) {
    throw new Error('Packaged better-sqlite3 load did not return its success marker')
  }
  return marker
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'))
  const unpackedDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(repositoryRoot, 'release', packageJson.version, 'win-unpacked')
  const result = verifyWindowsPackage(unpackedDir)
  const loadMarker = verifyPackagedLanceLoad(unpackedDir)
  const betterSqliteLoadMarker = verifyPackagedBetterSqliteLoad(unpackedDir)
  console.log(`Verified Windows package: ${result.executable}`)
  console.log(`Verified LanceDB native binding: ${result.nativeBinding}`)
  console.log(`Verified better-sqlite3 native binding: ${result.betterSqliteBinding}`)
  console.log(`Verified Windows secure file-system helper: ${result.secureFileSystemHelper}`)
  console.log(`Verified Windows secure file-system C# core: ${result.secureFileSystemCore}`)
  console.log(result.nativeSecureFileSystemHelper
    ? `Verified Windows native secure file-system helper: ${result.nativeSecureFileSystemHelper}`
    : 'Windows native secure file-system helper: absent (PowerShell backend only)')
  console.log(`Verified packaged LanceDB load: ${loadMarker}`)
  console.log(`Verified packaged better-sqlite3 load: ${betterSqliteLoadMarker}`)
}
