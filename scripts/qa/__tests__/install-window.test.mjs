/**
 * 安装窗口判定（issue #188 / #218）。
 *
 * 现场：找茬卡与修卡每轮必撞 —— 六次 sim 崩溃（「Target page closed」）**全部落在
 * 覆盖安装 mtime 之后 61–78 秒**（61/64/65/71/78/77s），六个月里没有一次超过 90 秒。
 * 而「这次崩溃算不算产品缺陷」以前靠人每次手比 mtime —— 已经因此犯过两次错
 * （一次读旧值、一次把 27 分钟读成 27 分钟）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { asarMtimeMs, installMtimeCandidates, releaseAsarMtimes } from '../lib/install-window.mjs'

const tempDirs = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** 造一个假的安装目录：exe + resources/app.asar + unpacked 原生绑定。 */
function fakeInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-window-'))
  tempDirs.push(root)
  const exe = path.join(root, 'AI小说作家.exe')
  fs.writeFileSync(exe, 'exe')
  fs.mkdirSync(path.join(root, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release'), { recursive: true })
  fs.writeFileSync(path.join(root, 'resources', 'app.asar'), 'asar')
  fs.writeFileSync(path.join(root, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'), 'native')
  return { root, exe, asar: path.join(root, 'resources', 'app.asar'), native: path.join(root, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node') }
}

/** 用给定的 mtime（毫秒）改文件的修改时间。 */
function stamp(file, ms) {
  fs.utimesSync(file, ms / 1000, ms / 1000)
}

describe('installMtimeCandidates (issue #218)', () => {
  it('watches more than app.asar — the exe and the unpacked native binding too', () => {
    const { exe } = fakeInstall()
    const candidates = installMtimeCandidates(exe)
    expect(candidates).toHaveLength(3)
    expect(candidates.some(item => item.endsWith('app.asar'))).toBe(true)
    expect(candidates).toContain(exe)
    expect(candidates.some(item => item.endsWith('better_sqlite3.node'))).toBe(true)
  })

  it('reports the newest stamp in the set, so any replaced file is noticed', () => {
    /**
     * 这正是那次漏报的形状：安装目录的 `app.asar` **从头到尾没变**，
     * 而应用已经死了（robocopy /MIR 是整目录覆盖，先换掉别的文件就够了）。
     * 取「最新」而不是「只看 asar」，才看得见。
     */
    const { exe, asar, native } = fakeInstall()
    stamp(asar, 1_000)
    stamp(exe, 1_000)
    stamp(native, 2_000)
    expect(asarMtimeMs(exe)).toBe(2_000)
  })

  it('is null when nothing in the set exists (never guesses)', () => {
    expect(asarMtimeMs(path.join(os.tmpdir(), 'definitely-missing-install', 'AI小说作家.exe'))).toBeNull()
    expect(asarMtimeMs(null)).toBeNull()
  })
})

describe('releaseAsarMtimes：第二路证据（issue #218）', () => {
  function fakeRepo(versions) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-window-repo-'))
    tempDirs.push(root)
    for (const [version, ms] of Object.entries(versions)) {
      const asar = path.join(root, 'release', version, 'win-unpacked', 'resources', 'app.asar')
      fs.mkdirSync(path.dirname(asar), { recursive: true })
      fs.writeFileSync(asar, version)
      stamp(asar, ms)
    }
    return root
  }

  it('finds a build that landed inside the run window', () => {
    /**
     * 实测那一次：12:06:52 起跑 → 12:11:51 构建出 1.5.207 → 12:13:07 应用崩溃。
     * 安装目录的 app.asar 是 11:27:23（窗口外），所以**单看安装目录会漏报**；
     * 而 release 侧那个新 mtime 落在窗口内 —— 这就是第二路证据。
     */
    const started = Date.parse('2026-11-06T04:06:52.374Z')
    const finished = Date.parse('2026-11-06T04:13:07.540Z')
    const repo = fakeRepo({
      '1.5.206': Date.parse('2026-11-06T03:27:23.993Z'),
      '1.5.207': Date.parse('2026-11-06T04:11:51.797Z'),
    })
    const result = releaseAsarMtimes(repo, { startedAtMs: started, finishedAtMs: finished })
    expect(result.newestInRunWindow).toBe(Date.parse('2026-11-06T04:11:51.797Z'))
    expect(result.startedAtMax).toBe(Date.parse('2026-11-06T04:11:51.797Z'))
  })

  it('does not treat an earlier build (outside the window) as evidence', () => {
    const started = Date.parse('2026-11-06T04:06:52.374Z')
    const finished = Date.parse('2026-11-06T04:13:07.540Z')
    const repo = fakeRepo({ '1.5.205': Date.parse('2026-11-06T03:22:18.932Z') })
    expect(releaseAsarMtimes(repo, { startedAtMs: started, finishedAtMs: finished }).newestInRunWindow).toBeNull()
  })

  it('returns nulls rather than throwing when there is no release directory', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'install-window-bare-'))
    tempDirs.push(bare)
    expect(releaseAsarMtimes(bare, { startedAtMs: 0, finishedAtMs: 1 }))
      .toEqual({ startedAtMax: null, endedAtMax: null, newestInRunWindow: null })
  })
})
