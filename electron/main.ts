import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { registerIPCHandlers } from './ipc-handlers'
import { registerMCPHandlers } from './mcp/mcp-ipc-bridge'
import { mainT } from './i18n'
import { registerUpdateController } from './controllers/update-controller'
import { createElectronUpdaterBackend } from './services/electron-updater-adapter'
import {
  GITHUB_LATEST_RELEASE_PAGE,
  createGitHubReleaseUpdateBackend,
} from './services/github-release-update-backend'
import { GlobalConfigUpdatePreferencesStore } from './services/update-preferences-store'
import {
  hasWindowsUpdateConfiguration,
  isMacUpdateReminderEnabled,
  isWindowsUpdateRuntimeEnabled,
} from './services/update-runtime'
import { startUpdateRuntime } from './services/update-startup'
import {
  claimReleaseVectorSmokeInvocation,
  releaseVectorSmokeWasRequested,
  runReleaseVectorSmoke,
} from './services/release-vector-smoke'
import {
  claimReleaseOfficialHomepageSmokeInvocation,
  releaseOfficialHomepageSmokeWasRequested,
  runReleaseOfficialHomepageSmoke,
} from './services/release-official-homepage-smoke'
import { registerOfficialHomepageController } from './controllers/official-homepage-controller'
import type { UpdateState } from './services/update-service'
import {
  createOfficialHomepageWindowOpenHandler,
  preventRendererNavigation,
} from './services/official-homepage-navigation'
import { configureSingleInstanceRuntime } from './services/single-instance-runtime'
import { forceNewInstanceRequested } from './services/single-instance-recovery'
import { installWindowCloseGuard, isWindowQuitRequested } from './controllers/window-controller'
import { decideRenderCrash, renderCrashMessage } from './services/render-crash-policy'
// issue #169：原生对话框是**纯文本**，判据文案里的 Markdown 粗体会原样显示成 `**`。
// `stripEmphasis` 原本只在 React 侧用；主进程这个出口同样是「给作者看」，也要剥。
import { stripEmphasis } from '../src/shared/author-visible-text'
import { closeProjectDatabase } from './database'
import { installProjectDatabaseQuitSettlement } from './services/project-database-quit-settlement'
import { registerStartupController } from './controllers/startup-controller'
import { resolveGlobalDataRoots } from './services/app-data-locator'
import { runGlobalDataMigration, activateGlobalData } from './services/global-data-migration'
import { ensureVelaHome } from './utils/config-utils'
import type { StartupBlockedCode, StartupMigrationNotice } from '../src/shared/startup-contract'

import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

// Electron 41 在部分 Windows 环境中无法启动受限 GPU 子进程（0xC0000135），
// 随后会触发 Chromium 的致命检查。仅放宽 GPU 子进程，保持 renderer 隔离策略不变。
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-gpu-sandbox')
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 构建产物目录结构
process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

let win: BrowserWindow | null
let startupGeneration: string | null = null
let startupBlockedCode: StartupBlockedCode | undefined
let startupHasSettled = false
let ownsInstanceLock = false
let startupMigrationNotice: StartupMigrationNotice | undefined

// Qualification already supplies this Chromium profile flag. Keep the same profile
// in Electron's locator too; ordinary launches retain their existing userData path.
const explicitUserData = app.commandLine.getSwitchValue('user-data-dir')
if (explicitUserData) {
  if (!path.isAbsolute(explicitUserData)) throw new Error('USER_DATA_PATH_MUST_BE_ABSOLUTE')
  app.setPath('userData', explicitUserData)
}

// The installed-package vector qualification is deliberately opt-in and
// fail-closed. A command-line request without the matching environment token
// must never turn into a normal interactive application launch.
const releaseVectorSmokeRequested = releaseVectorSmokeWasRequested(process.argv)
const releaseHomepageSmokeRequested = releaseOfficialHomepageSmokeWasRequested(process.argv)
const releaseSmokeRequested = releaseVectorSmokeRequested || releaseHomepageSmokeRequested
const releaseVectorSmokeInvocation = releaseVectorSmokeRequested
  ? claimReleaseVectorSmokeInvocation(process.argv, process.env)
  : undefined
const releaseHomepageSmokeInvocation = releaseHomepageSmokeRequested
  ? claimReleaseOfficialHomepageSmokeInvocation(process.argv, process.env)
  : undefined
const applicationInstanceAccepted = configureSingleInstanceRuntime({
  releaseSmokeRequested,
  requestLock: () => { ownsInstanceLock = app.requestSingleInstanceLock(); return ownsInstanceLock },
  quit: () => app.quit(),
  onSecondInstance: listener => { app.on('second-instance', () => listener()) },
  getWindow: () => win,
  // issue #90：本实例窗口黑屏/不可见时，用户再双击会被静默拒绝（exitCode=0、无提示）。
  // 这里给一个原生对话框，一次点击就能「关掉它并重开」——把死局变成一次点击。
  recovery: {
    recoverByRestart: () => {
      // 先 restart 再 exit：relaunch 会排在本次退出之后，锁与 userData 随之释放。
      app.relaunch()
      app.exit(0)
    },
    // 0 是「重新打开」。同步弹框：这是启动早期，异步等待会让进程静默退出的窗口期变长。
    askToRestart: options => dialog.showMessageBoxSync(options) === 0,
    log: line => { try { console.log(line) } catch { /* 日志失败不能影响启动 */ } },
    locale: 'zh-CN',
  },
  // CLI 逃生开关：对话框都渲染不出来时，支持/高级用户可以跳过单实例检查直接启动。
  forceNewInstance: forceNewInstanceRequested(process.argv),
})
let releaseSmokeStage = 'not-requested'
let releaseSmokeTimeout: NodeJS.Timeout | undefined

function reportReleaseSmokeStage(stage: string): void {
  if (!releaseSmokeRequested) return
  releaseSmokeStage = stage
  process.stderr.write(`[AI Novel release smoke] stage=${stage}\n`)
}

function clearReleaseSmokeTimeout(): void {
  if (releaseSmokeTimeout === undefined) return
  clearTimeout(releaseSmokeTimeout)
  releaseSmokeTimeout = undefined
}

if (releaseSmokeRequested) {
  reportReleaseSmokeStage('bootstrap')
  const timeoutDescription = releaseVectorSmokeRequested
    ? 'Packaged vector smoke timed out after 90 seconds'
    : 'Packaged official homepage smoke timed out after 90 seconds'
  releaseSmokeTimeout = setTimeout(() => {
    console.error(`[AI Novel release smoke] ${timeoutDescription}; last stage=${releaseSmokeStage}`)
    app.exit(1)
  }, 90_000)
}

function publishUpdateState(state: UpdateState): void {
  for (const target of BrowserWindow.getAllWindows()) {
    if (target.isDestroyed() || target.webContents.isDestroyed()) continue
    target.webContents.send('update:state', state)
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: startupBlockedCode ? 'AI Novel Writer' : mainT(app.getLocale(), 'app.windowTitle'),
    icon: path.join(process.env.APP_ROOT!, 'build', 'icon.png'),
    // 使用应用内自绘标题栏，避免 Windows 原生标题栏与棕色标题栏重复显示。
    frame: Boolean(startupBlockedCode),
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      // 安全性设置
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  // A diagnostic-only window has no editor and no business close responder.
  if (!startupBlockedCode) installWindowCloseGuard(win)

  if (process.platform === 'darwin') {
    app.dock?.setIcon(path.join(process.env.APP_ROOT!, 'build', 'icon.png'))
  }

  // 隐藏默认菜单栏（Windows/Linux）
  win.setMenuBarVisibility(false)

  // 所有新窗口都留在应用外；仅精确匹配的官方仓库可交给系统浏览器。
  win.webContents.setWindowOpenHandler(createOfficialHomepageWindowOpenHandler({
    openExternal: url => shell.openExternal(url),
    onOpenExternalError: error => {
      console.warn('[AI Novel Writer] Unable to open official homepage from a window request.', error)
    },
  }))
  // 渲染进程不能把现有主窗口导航到外部内容。
  win.webContents.on('will-navigate', preventRendererNavigation)

  /**
   * 渲染进程崩溃（issue #152）：现场是审稿撞顶 257 秒 → 救援重建刚启动 → Page crashed
   * （GPU TDR 之后 renderer 崩掉），两轮跨版本、跨安装同形态。
   *
   * 崩溃后**生成仍在主进程继续**，所以这里做两件事就够：
   * 一次性的崩溃自动重载一次（实测这台机器 GPU 会周期性复位），
   * 恢复不了就弹一个说明「刚才那一步没丢、重开去哪接着做」的原生对话框。
   * 判定本身在 render-crash-policy.ts（纯函数，可断言），这里只做转调。
   */
  let renderRecoveryCount = 0
  win.webContents.on('render-process-gone', (_event, details) => {
    const decision = decideRenderCrash({
      reason: details.reason,
      exitCode: details.exitCode,
      appQuitting: isWindowQuitRequested(win),
      recoveryCount: renderRecoveryCount,
    })
    try { console.error('[AI Novel Writer] renderer gone: reason=' + details.reason + ' exitCode=' + details.exitCode + ' action=' + decision.action) } catch { /* 日志失败不影响恢复 */ }
    if (decision.action === 'ignore') return
    if (decision.action === 'reload') {
      renderRecoveryCount += 1
      win?.webContents.reload()
      return
    }
    const message = renderCrashMessage(decision, app.getLocale() === 'en-US' ? 'en-US' : 'zh-CN')
    // issue #169：`title`/`detail` 走系统原生渲染，不认 Markdown —— 剥掉再送。
    void dialog.showMessageBox({ type: 'error', title: stripEmphasis(message.title), message: stripEmphasis(message.title), detail: stripEmphasis(message.body), buttons: ['OK'] })
      .catch(() => undefined)
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

function createReleaseHomepageSmokeWindow(): BrowserWindow {
  return new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
}

async function runPackagedOfficialHomepageSmoke(token: string) {
  return runReleaseOfficialHomepageSmoke(token, {
    createWindow: createReleaseHomepageSmokeWindow,
    loadProbeDocument: window => window.loadFile(path.join(RENDERER_DIST, 'release-homepage-smoke.html')),
    removeHandler: channel => ipcMain.removeHandler(channel),
    registerController: options => registerOfficialHomepageController(options),
  })
}

// 退出时结算在途运行（issue #207）：`closeProjectDatabase()` 会同步触发
// `onProjectDatabaseBeforeClose` → owner.suspendForProjectClose → recoverInterrupted，
// 把所有 root 收成 paused。此前这条链只在切换/关闭项目时走过，**退出应用时不走**，
// 于是正常退出后库里留下一批永远 running 的 run。
installProjectDatabaseQuitSettlement(
  { onWillQuit: listener => { app.on('will-quit', listener) } },
  closeProjectDatabase,
  error => { console.error('[main] quit settlement failed', error) },
)

// macOS: 关闭所有窗口不退出
app.on('window-all-closed', () => {
  if (!applicationInstanceAccepted) return
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

// macOS: 点击 dock 图标重新创建窗口
app.on('activate', () => {
  if (!applicationInstanceAccepted || releaseSmokeRequested || !startupHasSettled) return
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(async () => {
  if (!applicationInstanceAccepted) return
  reportReleaseSmokeStage('electron-ready')
  if (releaseSmokeRequested) {
    const requestedSmokeModeCount = Number(releaseVectorSmokeRequested)
      + Number(releaseHomepageSmokeRequested)
    const invocationCount = Number(releaseVectorSmokeInvocation !== undefined)
      + Number(releaseHomepageSmokeInvocation !== undefined)
    if (requestedSmokeModeCount !== 1 || invocationCount !== 1) {
      throw new Error('Invalid packaged smoke invocation: exactly one environment and one-time CLI token pair must match')
    }
    if (!explicitUserData || !process.env.AI_NOVEL_APP_DATA_HOME
      || !(process.env.AI_NOVEL_LEGACY_SOURCE_HOME || process.env.AI_NOVEL_VELA_HOME)) {
      throw new Error('GLOBAL_SMOKE_ISOLATION_REQUIRED')
    }
    // The profile is isolated, but competing writers to that profile still require exclusion.
    ownsInstanceLock = app.requestSingleInstanceLock()
    if (!prepareGlobalRuntime()) throw new Error('GLOBAL_SMOKE_STARTUP_BLOCKED')
    reportReleaseSmokeStage(releaseVectorSmokeInvocation ? 'vector-invocation-valid' : 'official-homepage-invocation-valid')
    const evidence = releaseVectorSmokeInvocation
      ? await runReleaseVectorSmoke(releaseVectorSmokeInvocation.token)
      : await runPackagedOfficialHomepageSmoke(releaseHomepageSmokeInvocation!.token)
    reportReleaseSmokeStage('evidence-ready')
    process.stdout.write(`${JSON.stringify(evidence)}\n`)
    clearReleaseSmokeTimeout()
    app.exit(0)
    return
  }

  registerStartupController({
    ipc: ipcMain,
    getTrustedSender: () => win?.webContents ?? null,
    rendererUrl: VITE_DEV_SERVER_URL || pathToFileURL(path.join(RENDERER_DIST, 'index.html')).href,
    getGlobalGeneration: () => startupGeneration,
    getBlockedCode: () => startupBlockedCode,
    getMigrationNotice: () => startupMigrationNotice,
  })
  // No ordinary renderer, default config writer, or business controller precedes this gate.
  if (!prepareGlobalRuntime()) {
    startupHasSettled = true
    createWindow()
    return
  }
  registerIPCHandlers()
  registerMCPHandlers()
  startupHasSettled = true
  // 更新功能失败不能阻断作者进入应用；窗口先于更新运行时创建。
  createWindow()
  const windowsUpdateEnabled = isWindowsUpdateRuntimeEnabled(app.isPackaged, VITE_DEV_SERVER_URL)
  const macUpdateReminderEnabled = isMacUpdateReminderEnabled(app.isPackaged, VITE_DEV_SERVER_URL)
  const updateRuntimeEnabled = windowsUpdateEnabled || macUpdateReminderEnabled
  const updateConfiguration = windowsUpdateEnabled && !hasWindowsUpdateConfiguration()
    ? 'missing'
    : 'available'
  startUpdateRuntime({
    updateRuntimeEnabled,
    updateConfiguration,
    currentVersion: app.getVersion(),
    updateAction: windowsUpdateEnabled ? 'download' : 'open-release',
    openRelease: () => shell.openExternal(GITHUB_LATEST_RELEASE_PAGE),
    createBackend: windowsUpdateEnabled
      ? createElectronUpdaterBackend
      : createGitHubReleaseUpdateBackend,
    createPreferences: () => new GlobalConfigUpdatePreferencesStore(),
    registerController: updateService => {
      registerUpdateController(updateService, { ipc: ipcMain, publish: publishUpdateState })
    },
    reportFailure: (operation, error) => {
      console.warn(`[AI Novel Update] ${operation}失败，已降级并继续启动应用。`, error)
    },
  })
}).catch((error: unknown) => {
  clearReleaseSmokeTimeout()
  console.error('[AI Novel Writer] Electron 启动失败，现有配置已保留。')
  if (releaseSmokeRequested) {
    // Controlled qualification errors have safe fixed codes; never print config values.
    if (error instanceof Error && /^[A-Z_]+$/.test(error.message)) console.error(error.message)
    app.exit(1)
    return
  }
  startupBlockedCode = 'GLOBAL_DATA_BLOCKED'
  startupHasSettled = true
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

function prepareGlobalRuntime(): boolean {
  const migrated = runGlobalDataMigration({
    ...resolveGlobalDataRoots(app.getPath('userData'), () => app.getPath('appData')),
    exclusiveAccess: ownsInstanceLock,
  })
  if (migrated.state !== 'ready') {
    startupBlockedCode = migrated.code === 'GLOBAL_MODEL_CREDENTIALS_DIFFER' ? migrated.code : 'GLOBAL_DATA_BLOCKED'
    return false
  }
  activateGlobalData(migrated)
  ensureVelaHome()
  startupGeneration = migrated.globalGeneration
  startupMigrationNotice = { legacySourceIgnored: migrated.legacySourceIgnored, preservedUnknownCount: migrated.preservedUnknownCount }
  startupBlockedCode = undefined
  return true
}
