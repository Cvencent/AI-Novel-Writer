/**
 * 主进程**长任务可观测性**（issue #104 第 ⑥ 条）。
 *
 * 那次「生成期间切页打字卡、最小化恢复不了」的定位花了两轮：先用进程采样看出
 * 「单线程吃满」，再用 `--inspect` 的 CPU profile 才落到「77% 在 SQLite 全表读」。
 * 而**产品本身一条相关日志都没有**——下次再卡只能重来一遍同样的摸索。
 *
 * 这里补一条最小可观测性：**任何同步操作超过阈值就打一条日志**，带上标签与耗时。
 * 阈值默认 200ms（issue 原话）；调用点把「可定位的上下文」拼进 label
 * （哪张表、多少行），于是一次卡顿就能从日志直接看出是哪一步吃掉了主线程。
 *
 * ⚠️ **只记录，不改行为**：`timeSyncOperation` 原样返回被包裹函数的返回值、
 * 原样抛出它的异常；这条日志失败也绝不影响主流程（吞掉）。
 * ⚠️ 走 `console.warn` 而不是新开文件：主进程既有的日志约定就是 console
 * （`main.ts` 的 `log: line => console.log(line)` 与各处的 `console.warn`），
 * 另起一条写文件路径既不一致、又会碰到全局数据目录的访问约束。
 * ⚠️ 判据是**同步**操作：异步任务本身不占死主线程，包进来只会产生噪声。
 */

/** 同步操作超过多少毫秒算「长任务」。issue 原文取 200ms。 */
export const SLOW_OPERATION_THRESHOLD_MS = 200

export interface SlowOperationReport {
  label: string
  elapsedMs: number
  thresholdMs: number
}

export type SlowOperationReporter = (report: SlowOperationReport) => void

/** 默认上报：一条 console.warn（与主进程既有约定一致）。 */
const defaultReporter: SlowOperationReporter = report => {
  try {
    console.warn(`[SlowOperation] ${report.label} 用了 ${report.elapsedMs}ms（阈值 ${report.thresholdMs}ms）`)
  } catch { /* 日志失败不能影响主流程 */ }
}

export interface TimeSyncOperationOptions {
  thresholdMs?: number
  reporter?: SlowOperationReporter
  /** 可注入的时钟（测试用；默认 `performance.now()` / `Date.now()`）。 */
  now?: () => number
}

function defaultNow(): number {
  // `performance.now()` 在 Node 与 Electron 主进程都可用；退回 Date.now() 也够用。
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
}

/**
 * 跑一个**同步**操作，超过阈值就打一条日志，原样返回结果 / 原样抛出异常。
 *
 * ```ts
 * const rows = timeSyncOperation(`domain-scan:${table}`, () => db.prepare(sql).raw().all())
 * ```
 */
export function timeSyncOperation<T>(label: string, operation: () => T, options: TimeSyncOperationOptions = {}): T {
  const thresholdMs = options.thresholdMs ?? SLOW_OPERATION_THRESHOLD_MS
  const now = options.now ?? defaultNow
  const reporter = options.reporter ?? defaultReporter
  const started = now()
  try {
    return operation()
  } finally {
    // ⚠️ 记在 finally：抛异常的那次同样可能是「慢操作」，也值得知道它慢在哪一步。
    const elapsedMs = now() - started
    if (elapsedMs >= thresholdMs) {
      try {
        reporter({ label: String(label ?? ''), elapsedMs: Math.round(elapsedMs), thresholdMs })
      } catch { /* 上报失败不影响主流程 */ }
    }
  }
}