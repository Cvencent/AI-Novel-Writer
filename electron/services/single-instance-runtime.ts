import {
  focusExistingInstance,
  handleSecondInstance,
  type ExistingInstanceWindow,
  type SecondInstanceRecoveryDependencies,
} from './single-instance-recovery'

export type { ExistingInstanceWindow } from './single-instance-recovery'

export interface SingleInstanceRuntimeOptions {
  releaseSmokeRequested: boolean
  requestLock(): boolean
  quit(): void
  onSecondInstance(listener: () => void): void
  getWindow(): ExistingInstanceWindow | null | undefined
  /**
   * 主实例收到第二次启动时的交互兜底（issue #90）。给了才启用：
   * 先试着聚焦自己的工作窗口，**窗口不可见时改弹「关掉它并重开」的对话框**，
   * 而不是把用户丢在一个黑窗口上反复双击。不给就退回旧的静默聚焦行为。
   */
  recovery?: Omit<SecondInstanceRecoveryDependencies, 'getWindow'>
  /** `--force-new-instance`：跳过单实例检查（支持/高级用户的命令行逃生开关）。 */
  forceNewInstance?: boolean
}

/**
 * Release qualification processes deliberately bypass the interactive lock so
 * architecture-specific smoke jobs can run independently. Ordinary launches
 * are single-instance and the second process exits before startup work begins.
 *
 * issue #90 补了一句：**第二个进程没有别人的窗口可看**——`second-instance` 事件是在
 * 主实例里触发的，所以「窗口黑屏 → 给用户一个重开对话框」这段必须挂在
 * `onSecondInstance` 的处理器里（那里才拿得到 `win`）。第二个进程只负责记一条日志再退出。
 */
export function configureSingleInstanceRuntime(options: SingleInstanceRuntimeOptions): boolean {
  if (options.releaseSmokeRequested || options.forceNewInstance) return true
  if (!options.requestLock()) {
    // 拒绝要有据可查（issue #90 建议 4）：`exitCode=0` 的静默退出连日志都没有。
    options.recovery?.log('[single-instance] second launch rejected: another instance holds the lock')
    options.quit()
    return false
  }
  options.onSecondInstance(() => {
    if (options.recovery) {
      handleSecondInstance({ ...options.recovery, getWindow: options.getWindow })
      return
    }
    focusExistingInstance(options.getWindow())
  })
  return true
}