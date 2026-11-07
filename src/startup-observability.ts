/**
 * 渲染进程全局异常的可观测性（issue #236 ②）。
 *
 * 现场：`start()` 原来只有 try/finally，launch 链路的异常逃成 unhandled rejection——
 * UI 零反馈，而 sim 报告的 `pageErrors`/`consoleErrors` 两桶也是空的
 * （Playwright 默认只收 pageerror/console，`unhandledrejection` 在 Electron renderer
 * 需显式监听）→ 诊断只能靠库表反推「确认无人在干活」。
 *
 * 这里把两类全局异常转发进 `console.error`（进诊断收集），让「吞异常」从此有记录。
 * ⚠️ 这只是可观测性兜底：**组件内该有的错误出口仍然要有**（同轮已给 start() 补 catch）——
 * 全局监听不把异常变回可见反馈，只保证它不静默。
 */
export function installGlobalRejectionLogging(): void {
  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason
    const detail = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason)
    console.error(`[unhandled-rejection] ${detail}`)
  })
  window.addEventListener('error', event => {
    console.error(`[uncaught-error] ${event.message} @ ${event.filename}:${event.lineno}:${event.colno}`)
  })
}
