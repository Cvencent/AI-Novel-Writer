/**
 * 模拟器工作区的**独占锁**（issue #54）。
 *
 * 背景：两个并发会话共用默认隔离区时会互相踩踏——后启动的那个会 `rmSync` 掉前一个的
 * `temp/`（本轮实测触发 `EBUSY: resource busy or locked, unlink ...tmp`），
 * 两边还会撞同一份 userData 的 Electron 单实例锁（`Process failed to launch!`），
 * 报错互相写进同一份报告，分不清是产品缺陷还是并发自伤。
 *
 * 这里做最小、可离线测的一件事：**同一个工作区同一时刻只允许一个会话在用**。
 * 拿不到锁时明确报错退出（而不是静默共享），锁文件残留但进程已死时自动接管
 * ——死进程留下的锁不该把下一轮挡死（这一点与 Electron 的 SingletonLock 不同：
 * 我们不能删别人的锁，但可以判断它是否还活着）。
 */
import fs from 'node:fs'
import path from 'node:path'

export const LOCK_FILE_NAME = 'run.lock'

/** 默认的「进程还活着」判据：Windows 与 POSIX 都只看信号 0。 */
export function defaultIsProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM：进程存在但不属于当前用户——仍算活着。
    return error?.code === 'EPERM'
  }
}

export function readRunLock(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    return {
      pid: Number(parsed.pid) || null,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      workRoot: typeof parsed.workRoot === 'string' ? parsed.workRoot : '',
    }
  } catch {
    return null
  }
}

/**
 * 取工作区独占锁。
 * 返回 `{ ok: true, file, release }` 或 `{ ok: false, holder }`（holder 是占用者信息）。
 */
export function acquireRunLock(workRoot, {
  pid = process.pid,
  now = () => new Date().toISOString(),
  isAlive = defaultIsProcessAlive,
  log = () => {},
} = {}) {
  const file = path.join(workRoot, LOCK_FILE_NAME)
  fs.mkdirSync(workRoot, { recursive: true })
  const existing = readRunLock(file)
  if (existing && existing.pid !== pid && isAlive(existing.pid)) {
    return { ok: false, holder: existing }
  }
  if (existing && existing.pid !== pid) {
    log(`上一个会话（pid ${existing.pid}）已不在运行，接管工作区 ${workRoot}`)
  }
  const lock = { pid, startedAt: now(), workRoot }
  fs.writeFileSync(file, JSON.stringify(lock, null, 2))
  return {
    ok: true,
    file,
    lock,
    release: () => {
      // 只删自己的锁：别人接管后（pid 变了）不删，避免把新会话的锁误删。
      const current = readRunLock(file)
      if (current && current.pid !== pid) return false
      try {
        fs.rmSync(file, { force: true })
        return true
      } catch {
        return false
      }
    },
  }
}

/** Electron 在同一份 userData 下只允许一个实例：残留的锁与端口文件会让新实例秒退。 */
export const STALE_ELECTRON_HANDLES = ['SingletonLock', 'SingletonCookie', 'lockfile', 'DevToolsActivePort']

/**
 * 清掉**上个会话死掉后**留在工作区 userData 里的 Electron 句柄（issue #54）。
 *
 * 只有拿到独占锁之后才调（即：确认没有别的会话在跑），因此不会碰任何活实例的东西；
 * 也只在 `--work-root` 这份隔离目录里动手，绝不碰用户真实 userData。
 * 返回被删掉的文件名，供报告留痕。
 */
export function clearStaleElectronHandles(userDataDir, { log = () => {} } = {}) {
  if (!userDataDir || !fs.existsSync(userDataDir)) return []
  const removed = []
  for (const name of STALE_ELECTRON_HANDLES) {
    const target = path.join(userDataDir, name)
    if (!fs.existsSync(target)) continue
    try {
      fs.rmSync(target, { recursive: true, force: true })
      removed.push(name)
    } catch (error) {
      log(`清理残留句柄失败（${name}）：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (removed.length) log(`清掉上个会话残留的 Electron 句柄：${removed.join('、')}`)
  return removed
}
