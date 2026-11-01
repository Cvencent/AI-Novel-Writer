/**
 * QA harness 的超时/收尾兜底（issue #31）。
 *
 * 背景：user-sim 的收尾把 `page.evaluate` 放在 `finally` 里且没给超时——页面已崩时
 * 它等的是「目标可用」而不是 selector，**默认超时失效、永不返回**，于是同步阻塞在
 * `finally` 中，`app.close()` 永不执行、报告不落盘、app 占着单实例锁让下一轮启动被挡死。
 *
 * 这里把两个兜底抽成独立模块：user-sim 引用它，回归测试也能直接断言语义
 * （user-sim 本身是带顶层副作用的脚本，不适合被直接 import）。
 */

/**
 * 给任意 Promise 套硬超时：到点即抛，绝不无限等待。
 *
 * 只写 `page.evaluate(fn)` 再 `.catch()` 是不够的——`.catch()` 处理抛错，
 * 处理不了「永不 settle」；必须用竞速 + 定时器把控制权抢回来。
 */
export async function withTimeout(promise, ms, label) {
  let timer
  const bomb = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
  })
  try {
    return await Promise.race([promise, bomb])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 关闭 app，超时后按 PID 兜底（issue #31）。
 *
 * `app.close()` 自身也可能挂住（renderer 崩了、主进程等 IPC 回执）。超时后只终止
 * **本轮自己拉起的那棵进程树**——绝不按 userData 路径全局扫杀（那会波及同一 userData
 * 下别的实例）。清理失败只记日志，不再抛。
 */
export async function closeAppWithTimeout(app, { ms = 20_000, log = () => {} } = {}) {
  const pid = (() => { try { return app.process()?.pid ?? null } catch { return null } })()
  try {
    await withTimeout(app.close(), ms, 'app.close')
    return { closed: 'graceful', pid }
  } catch (error) {
    log(`[cleanup] app.close 未在超时内完成，按 PID 兜底: ${String(error?.message ?? error).slice(0, 200)}`)
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return { closed: 'failed', pid }
  try {
    if (process.platform === 'win32') {
      const { spawnSync } = await import('node:child_process')
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 20_000 })
    } else {
      process.kill(pid, 'SIGKILL')
    }
    log(`[cleanup] 已按 PID 终止本轮实例 ${pid}`)
    return { closed: 'pid-killed', pid }
  } catch (error) {
    log(`[cleanup] PID 兜底失败: ${String(error?.message ?? error).slice(0, 200)}`)
    return { closed: 'failed', pid }
  }
}