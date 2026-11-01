/**
 * 工作区独占锁回归（issue #54）：
 * 并发会话共用默认隔离区时会互相 rmSync 掉对方的 temp/（本轮实测 EBUSY），
 * 并撞同一份 userData 的 Electron 单实例锁。要求：活的占用者挡住后来者；
 * 死进程留下的锁自动接管；释放只删自己的锁。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { acquireRunLock, clearStaleElectronHandles, readRunLock } from './run-lock.mjs'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const tempRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ainovel-runlock-'))
  roots.push(root)
  return root
}

describe('acquireRunLock (issue #54)', () => {
  it('第一个会话拿到锁，第二个被明确挡住（不是静默共享）', () => {
    const root = tempRoot()
    const first = acquireRunLock(root, { pid: 1111, isAlive: () => true })
    expect(first.ok).toBe(true)
    expect(readRunLock(first.file)).toMatchObject({ pid: 1111 })

    const second = acquireRunLock(root, { pid: 2222, isAlive: () => true })
    expect(second.ok).toBe(false)
    expect(second.holder).toMatchObject({ pid: 1111 })
    // 被挡住时不能改写锁文件（否则占用者的身份就丢了）
    expect(readRunLock(first.file)).toMatchObject({ pid: 1111 })
  })

  it('占用者已退出时自动接管，并记一行日志', () => {
    const root = tempRoot()
    acquireRunLock(root, { pid: 1111, isAlive: () => true })
    const logs = []
    const taken = acquireRunLock(root, { pid: 2222, isAlive: () => false, log: message => logs.push(message) })
    expect(taken.ok).toBe(true)
    expect(readRunLock(taken.file)).toMatchObject({ pid: 2222 })
    expect(logs.join('\n')).toContain('已不在运行')
  })

  it('释放只删自己的锁；被接管后不删新会话的锁', () => {
    const root = tempRoot()
    const mine = acquireRunLock(root, { pid: 1111, isAlive: () => true })
    expect(mine.release()).toBe(true)
    expect(readRunLock(mine.file)).toBeNull()

    const held = acquireRunLock(root, { pid: 1111, isAlive: () => true })
    acquireRunLock(root, { pid: 2222, isAlive: () => false })   // 接管
    expect(held.release()).toBe(false)
    expect(readRunLock(held.file)).toMatchObject({ pid: 2222 })
  })

  it('同一个进程重复取锁是幂等的（重入不报占用）', () => {
    const root = tempRoot()
    const first = acquireRunLock(root, { pid: 1111, isAlive: () => true })
    const again = acquireRunLock(root, { pid: 1111, isAlive: () => true })
    expect(first.ok).toBe(true)
    expect(again.ok).toBe(true)
  })

  it('锁文件损坏时按「无锁」处理，不把工作区永久挡死', () => {
    const root = tempRoot()
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'run.lock'), '{ 这不是 JSON')
    expect(acquireRunLock(root, { pid: 1111, isAlive: () => true }).ok).toBe(true)
  })
})

describe('clearStaleElectronHandles (issue #54)', () => {
  it('清掉残留的锁与端口文件，只动传进来的这个目录', () => {
    const root = tempRoot()
    const userData = path.join(root, 'userData')
    const other = path.join(root, 'other')
    fs.mkdirSync(userData, { recursive: true })
    fs.mkdirSync(other, { recursive: true })
    for (const name of ['SingletonLock', 'lockfile', 'DevToolsActivePort']) fs.writeFileSync(path.join(userData, name), 'x')
    fs.writeFileSync(path.join(userData, 'keep-me.json'), '{}')
    fs.writeFileSync(path.join(other, 'SingletonLock'), 'x')

    const removed = clearStaleElectronHandles(userData)
    expect(removed.sort()).toEqual(['DevToolsActivePort', 'SingletonLock', 'lockfile'])
    expect(fs.existsSync(path.join(userData, 'keep-me.json'))).toBe(true)
    expect(fs.existsSync(path.join(other, 'SingletonLock'))).toBe(true)
  })

  it('目录不存在时返回空数组，不抛错', () => {
    expect(clearStaleElectronHandles(path.join(tempRoot(), 'nope'))).toEqual([])
  })
})
