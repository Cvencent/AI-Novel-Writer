/**
 * 退出时结算在途运行（issue #207）。
 *
 * 现场：一次 sim 正常退出（exit 0）后，隔离库里留下 **6 个 `status='running'` 的 run**
 * 和 4 个 `status='active'` 的 root —— 而进程早就没了。最直接的影响是
 * 「有没有任务在跑」的唯一真源失真：`generation:list` 会一直把它们列成进行中，
 * QA 的停滞判定（#198/#205）只要看到 running 就认为「还在跑」。
 *
 * 根因：`app.quit()` 之前**从来没有关过项目库**。主进程的收尾链是
 * `closeProjectDatabase()` → `onProjectDatabaseBeforeClose` 监听者 →
 * `owner.suspendForProjectClose()` → `repository.recoverInterrupted()`，
 * 而这条链只在「切换/关闭项目」时走过，**退出应用时不走**。
 * 于是 `recoverInterrupted()`（它本来就能把所有 root 收成 paused）一次也没在退出时跑过。
 *
 * 为什么放在 `will-quit`：此时窗口已关、渲染层已停，写库不会再和任何在途调用打架；
 * 放在 `before-quit` 会早于窗口关闭，仍可能有人正在写。
 *
 * ⚠️ 退出路径上**不许**把「收尾失败」变成「关不掉」：异常只记录，不重抛。
 * 崩溃/强杀那种来不及写的情况由下次冷启动的 `recoverInterrupted()` 兜底
 * （它在每次创建 owner 时都会跑），再加上 `reapIdleRuns()` 的空闲收割。
 */
export interface QuitSettlementHost {
  /** 只需 `app.on('will-quit', …)` 这一能力；测试可传一个假的。 */
  onWillQuit: (listener: () => void) => void
}

export function installProjectDatabaseQuitSettlement(
  host: QuitSettlementHost,
  closeProjectDatabase: () => void,
  log: (error: unknown) => void,
): void {
  host.onWillQuit(() => {
    try {
      closeProjectDatabase()
    } catch (error) {
      // 例如 `GENERATION_UNSAVED_TAIL_PRESENT`：账本留到下次冷启动由 recoverInterrupted 收。
      log(error)
    }
  })
}
