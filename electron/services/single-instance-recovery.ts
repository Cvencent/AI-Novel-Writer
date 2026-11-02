/**
 * 单实例锁的交互兜底（issue #90）。
 *
 * 事故原形：已有一个实例占着单实例锁，但它的**窗口不可见或画面全黑**（GPU 挂起、renderer
 * 崩过、窗口被挪到别的虚拟桌面）。此时用户再双击应用，第二个进程拿不到锁就
 * `app.quit()` —— **`exitCode=0`、无任何提示、无崩溃报告**。用户看到的就是
 * 「双击没反应 / 打开是黑屏」，而且他既不知道有另一个实例在跑，也不知道要去
 * 任务管理器杀进程或删 `lockfile`（实测那个实例累计 846 CPU 秒、窗口标题还在、
 * `Responding=True`，就是画面全黑）。**这是完全的死局**。
 *
 * `focusExistingInstance` 本身没错，它只管把已有窗口拉到前台；错在**把它的成功当成
 * 「用户已经看见应用了」**。所以这里补两件事：
 *
 *   ① **先判断已有窗口是否真的可用**（存在、未销毁、可见）；可用 → 聚焦即可，与旧行为一致；
 *   ② **不可用 → 给一个原生对话框**，让用户一次点击就能「关掉旧实例并重开」。
 *
 * ⚠️ 关键实现事实：**第二个进程看不到第一个实例的窗口**——Electron 的
 * `second-instance` 事件是在**主实例**里触发的。所以这段逻辑必须跑在**主实例**的
 * `second-instance` 处理器里（那里才拿得到 `win`）；用户双击打开的第二个进程只能
 * 记一条日志然后退出。
 *
 * 另外提供 `--force-new-instance` 逃生开关：跳过单实例检查直接启动，
 * 供支持/高级用户在命令行自救（对话框都渲染不出来的极端情况）。
 */

export interface RecoveryDialogOptions {
  type: 'question'
  buttons: string[]
  defaultId: number
  cancelId: number
  title: string
  message: string
  detail: string
}

export interface ExistingInstanceWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  isVisible(): boolean
  restore(): void
  show(): void
  focus(): void
}

/**
 * 已有的那个实例窗口，用户**现在**能不能看见？
 *
 * 只有「存在 + 未销毁 + 可见」才算可用。最小化也算可用（托盘里点一下就能回来，
 * 且 `focusExistingInstance` 会 restore），所以不把 isMinimized 当不可用——
 * 真正不可自救的是**窗口不存在/已销毁/不可见**（黑屏、跑到别的桌面、窗口已关）。
 */
export function isExistingInstanceUsable(window: ExistingInstanceWindow | null | undefined): boolean {
  if (!window || window.isDestroyed()) return false
  return window.isVisible()
}

/** 把已有窗口拉到前台；不可用时不假装成功，返回 false 交给调用方走恢复分支。 */
export function focusExistingInstance(window: ExistingInstanceWindow | null | undefined): boolean {
  if (!isExistingInstanceUsable(window)) return false
  const target = window as ExistingInstanceWindow
  if (target.isMinimized()) target.restore()
  target.show()
  target.focus()
  return true
}

export interface SecondInstanceRecoveryDependencies {
  /** **主实例自己的**窗口（第二个进程看不到它，所以这段必须跑在主实例里）。 */
  getWindow(): ExistingInstanceWindow | null | undefined
  /** 结束本实例并重启自己。实现负责「先关、再 app.relaunch + app.exit」。 */
  recoverByRestart(): void
  /** 弹原生问询框；返回用户是否选了「重新打开」。 */
  askToRestart(options: RecoveryDialogOptions): boolean
  /** 把这次拒绝写进日志，让「应用打不开」至少有据可查（issue #90 建议 4）。 */
  log(line: string): void
  locale: 'zh-CN' | 'en-US'
}

/**
 * **主实例**收到 `second-instance` 时的处理：能聚焦就聚焦，不能聚焦就问用户
 * 「要不要关掉它并重开」（issue #90）。
 *
 * 返回 `true` 表示「已处理」（聚焦成功或用户选择重启）；`false` 表示用户取消。
 */
export function handleSecondInstance(deps: SecondInstanceRecoveryDependencies): boolean {
  const window = deps.getWindow()
  if (focusExistingInstance(window)) return true

  // 走到这里说明：用户双击了应用，但**我们自己的窗口他看不见**（黑屏/已销毁）——
  // 正是 #90 的死局。聚焦一个看不见的窗口等于没做，必须给出口。
  deps.log('[single-instance] second launch: own window unusable; offering restart recovery')
  const zh = deps.locale === 'zh-CN'
  const accepted = deps.askToRestart({
    type: 'question',
    buttons: zh ? ['重新打开', '取消'] : ['Reopen', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: zh ? '应用已在运行' : 'The app is already running',
    // 文案要如实说明「它看不见」并给出可执行的下一步，而不是只说「已有一个实例」——
    // 后者正是用户此刻看到的黑屏本身，等于没解释（#55/#69 同一教训：提示必须给出路）。
    message: zh
      ? '应用的窗口无法显示（可能已卡死或画面未刷新）。'
      : 'The app window cannot be displayed (it may have hung or failed to repaint).',
    detail: zh
      ? '选择「重新打开」会关闭这个无法显示的实例，并立即重新启动应用。\n'
        + '选择「取消」则保留现状（你可以用任务管理器结束它的进程后再试）。'
      : 'Choosing "Reopen" closes the instance that cannot be displayed and immediately starts the app again.\n'
        + 'Choosing "Cancel" leaves it as is (you can end its process in Task Manager and try again).',
  })
  if (!accepted) return false
  deps.recoverByRestart()
  return true
}

/** `--force-new-instance` 逃生开关：跳过单实例检查（支持/高级用户命令行自救）。 */
export function forceNewInstanceRequested(argv: readonly string[]): boolean {
  return argv.some(argument => argument === '--force-new-instance')
}