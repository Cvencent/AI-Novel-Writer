import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, it } from 'vitest'

import {
  EXPECTED_SIZE,
  bindingPath,
  cacheEntryPath,
  cacheKey,
  restore,
  save,
  status,
} from '../native-abi-cache.mjs'

const roots = []
function scratchRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'native-abi-cache-'))
  roots.push(root)
  mkdirSync(path.join(root, 'node_modules', 'better-sqlite3', 'build', 'Release'), { recursive: true })
  mkdirSync(path.join(root, 'node_modules', 'better-sqlite3'), { recursive: true })
  mkdirSync(path.join(root, 'node_modules', 'electron'), { recursive: true })
  writeFileSync(path.join(root, 'node_modules', 'better-sqlite3', 'package.json'), '{"version":"12.8.0"}')
  writeFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), '{"version":"41.10.7"}')
  return root
}
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })

/** 写一个大小落在 Electron ABI 期望值上的假二进制，便于按 size 断言。 */
function writeBinding(root, bytes) {
  const file = bindingPath(root)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, Buffer.alloc(bytes, 7))
}

it('keys the cache entry on both the package version and the target runtime', () => {
  const root = scratchRoot()
  const electron = cacheKey('electron', root)
  assert.equal(electron.betterSqliteVersion, '12.8.0')
  assert.equal(electron.runtimeVersion, '41.10.7')
  assert.match(electron.fileName, /^better_sqlite3\.electron\.12\.8\.0\.41\.10\.7\.node$/)
  // Node 目标用当前 node 版本；键里绝不能混进 electron 版本。
  const node = cacheKey('node', root)
  assert.equal(node.runtimeVersion, process.versions.node)
  assert.notEqual(node.fileName, electron.fileName)
})

it('round-trips one ABI through the cache', () => {
  const root = scratchRoot()
  writeBinding(root, EXPECTED_SIZE.electron)
  const entry = save('electron', root)
  assert.equal(entry, cacheEntryPath('electron', root))
  assert.equal(readFileSync(entry).length, EXPECTED_SIZE.electron)

  // 换成 Node ABI，再恢复回 Electron。
  writeBinding(root, EXPECTED_SIZE.node)
  assert.equal(restore('electron', root), true)
  assert.equal(readFileSync(bindingPath(root)).length, EXPECTED_SIZE.electron)
})

it('refuses a cache entry whose contents no longer match its recorded hash', () => {
  const root = scratchRoot()
  writeBinding(root, EXPECTED_SIZE.electron)
  const entry = save('electron', root)
  // 把缓存文件尾部改一位：size 不变，hash 变了——必须拒绝，否则会把坏二进制装进去。
  const tampered = readFileSync(entry)
  tampered[tampered.length - 1] = 9
  writeFileSync(entry, tampered)
  assert.equal(restore('electron', root), false)
})

it('reports a miss instead of throwing when nothing was cached', () => {
  const root = scratchRoot()
  assert.equal(restore('electron', root), false)
  const snapshot = status(root)
  assert.deepEqual(snapshot.cached, { node: false, electron: false })
  assert.equal(snapshot.currentAbi, 'unknown')
})

it('reports the ABI of whatever binding is currently on disk', () => {
  const root = scratchRoot()
  writeBinding(root, EXPECTED_SIZE.electron)
  assert.equal(status(root).currentAbi, 'electron')
  writeBinding(root, EXPECTED_SIZE.node)
  assert.equal(status(root).currentAbi, 'node')
})

it('rejects an unknown target so a typo cannot silently write the wrong cache slot', () => {
  const root = scratchRoot()
  assert.throws(() => cacheKey('darwin', root), /Unknown native target/)
})
