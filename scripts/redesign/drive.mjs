/* global process */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

import { startFakeModel } from './fake-model.mjs'
import { SCENARIOS, SCREENSHOT_SCENARIOS } from './scenarios.mjs'
import { dismissStartupNotice, firstInteractiveControl, waitForShell } from './pages/shell.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const TIMEOUT = 60_000
const VIEWPORT = { width: 1440, height: 900 }
const THEMES = ['light', 'dark']
const ROOT_NAMES = ['legacy', 'canonical', 'userData', 'home', 'appData', 'localAppData', 'temp', 'projects']
const ALL_SCENARIOS = [...Object.keys(SCENARIOS), 'baseline-all', 'startup-timing']
const USAGE = `用法: node scripts/redesign/drive.mjs --scenario <名称> [--theme light|dark] [--out <目录>] [--dump-dom] [--console] [--app-root <目录>]
场景: ${ALL_SCENARIOS.join(', ')}`

export function parseArgs(argv) {
  const options = { scenario: null, theme: 'light', out: path.join(repository, '.runtime', 'redesign-baseline'),
    dumpDom: false, console: false, appRoot: repository }
  const valueOf = (flag, index) => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 缺少取值\n${USAGE}`)
    return value
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--') continue
    else if (arg === '--scenario') options.scenario = valueOf(arg, index++)
    else if (arg === '--theme') options.theme = valueOf(arg, index++)
    else if (arg === '--out') options.out = path.resolve(valueOf(arg, index++))
    else if (arg === '--app-root') options.appRoot = path.resolve(valueOf(arg, index++))
    else if (arg === '--dump-dom') options.dumpDom = true
    else if (arg === '--console') options.console = true
    else throw new Error(`未知参数 ${arg}\n${USAGE}`)
  }
  if (!ALL_SCENARIOS.includes(options.scenario)) throw new Error(`未知或缺少场景 ${options.scenario}\n${USAGE}`)
  if (!THEMES.includes(options.theme)) throw new Error(`--theme 只接受 ${THEMES.join('|')}`)
  return options
}

/** Electron 的全部可写根都落在 parent 下的一个新目录里；项目路径要短，原生存储有长度上限。 */
export function createIsolatedRoots(parent) {
  fs.mkdirSync(parent, { recursive: true })
  const root = fs.mkdtempSync(path.join(parent, 'd'))
  const roots = Object.fromEntries(ROOT_NAMES.map(name => [name, path.join(root, name)]))
  for (const [name, directory] of Object.entries(roots)) if (name !== 'canonical') fs.mkdirSync(directory, { recursive: true })
  return { root, ...roots }
}

export function isolatedEnvironment(roots, base = process.env) {
  const env = { ...base, AI_NOVEL_APP_DATA_HOME: roots.canonical, AI_NOVEL_LEGACY_SOURCE_HOME: roots.legacy,
    AI_NOVEL_VELA_HOME: roots.legacy, HOME: roots.home, USERPROFILE: roots.home, APPDATA: roots.appData,
    LOCALAPPDATA: roots.localAppData, TEMP: roots.temp, TMP: roots.temp }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT', 'AI_NOVEL_SMOKE_PROJECT_MARKER']) delete env[name]
  return env
}

function scratchParent() {
  const base = process.env.LOCALAPPDATA ?? os.tmpdir()
  return path.join(base, 'VibeCodingScratch', 'an', 'drive')
}

/** 用户真实配置目录。运行前后比较最新修改时间，证明隔离目录之外没有写入。 */
function realProfileDirectories() {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  return [path.join(os.homedir(), '.vela'), path.join(appData, 'ai-novel-writer'), path.join(appData, 'AI小说作家')]
}

function newestWrite(directory, budget = { entries: 50_000 }) {
  let newest = 0
  let stat
  try { stat = fs.lstatSync(directory) } catch { return null }
  newest = stat.mtimeMs
  if (!stat.isDirectory()) return newest
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (--budget.entries < 0) break
    const child = path.join(directory, entry.name)
    const value = entry.isDirectory() ? newestWrite(child, budget) : fs.lstatSync(child).mtimeMs
    if (value !== null && value > newest) newest = value
  }
  return newest
}

function snapshotRealProfiles() {
  return Object.fromEntries(realProfileDirectories().map(directory => [directory, newestWrite(directory)]))
}

function externalWrites(before) {
  const after = snapshotRealProfiles()
  return Object.keys(before).filter(directory => before[directory] !== after[directory])
}

/** 以 --user-data-dir 匹配仍存活的 Electron 主进程与子进程。 */
export function residualProcesses(userData) {
  const needle = userData.toLowerCase()
  if (process.platform === 'win32') {
    const script = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"
    const output = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    return output.split(/\r?\n/).filter(line => line.toLowerCase().includes(needle)).map(line => Number(line.split('\t')[0]))
  }
  const output = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
  return output.split('\n').filter(line => line.toLowerCase().includes(needle)).map(line => Number(line.trim().split(/\s+/)[0]))
}

async function quit(app) {
  const pid = app.process().pid
  let timer
  const closed = await Promise.race([app.close().then(() => true).catch(() => false),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), 10_000) })])
  clearTimeout(timer)
  if (!closed && pid) {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    else process.kill(pid, 'SIGKILL')
  }
  return { forced: !closed }
}

export async function launch({ roots, appRoot, fakeModelPort, diagnostics }) {
  const launchedAt = Date.now()
  const app = await electron.launch({ cwd: appRoot, args: ['.', `--user-data-dir=${roots.userData}`],
    env: isolatedEnvironment(roots), timeout: TIMEOUT })
  try {
    const startup = await app.evaluate(({ app: electronApp, BrowserWindow }) => {
      const timing = globalThis.__driveTiming = { readyToShow: null }
      const watch = window => window.once('ready-to-show', () => { timing.readyToShow ??= Date.now() })
      const existing = BrowserWindow.getAllWindows()
      existing.forEach(watch)
      electronApp.on('browser-window-created', (_, window) => watch(window))
      return { windowsAtAttach: existing.length, visibleAtAttach: existing.some(window => window.isVisible()) }
    })
    if (fakeModelPort) await app.evaluate((_, port) => {
      const originalFetch = globalThis.fetch
      globalThis.__driveExternalRequests = []
      globalThis.fetch = (input, options) => {
        const url = new URL(String(input instanceof Request ? input.url : input))
        if (url.origin !== 'https://api.openai.com' || !url.pathname.startsWith('/v1/')) {
          globalThis.__driveExternalRequests.push(url.origin)
          throw new Error('DRIVE_EXTERNAL_FETCH_REFUSED')
        }
        return originalFetch(`http://127.0.0.1:${port}${url.pathname}`, options)
      }
    }, fakeModelPort)
    app.process().stdout?.on('data', chunk => diagnostics.push(`[main:stdout] ${String(chunk).trimEnd()}`))
    app.process().stderr?.on('data', chunk => diagnostics.push(`[main:stderr] ${String(chunk).trimEnd()}`))
    const page = await app.firstWindow({ timeout: TIMEOUT })
    page.on('console', message => diagnostics.push(`[renderer:${message.type()}] ${message.text()}`))
    page.on('pageerror', error => diagnostics.push(`[renderer:pageerror] ${error.stack ?? error.message}`))
    page.setDefaultTimeout(20_000)
    assert.equal(path.resolve(await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))), roots.userData)
    await page.setViewportSize(VIEWPORT)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitForShell(page, TIMEOUT)
    assert.equal((await invoke(page, 'startup:get-state')).state, 'ready')
    return { app, page, launchedAt, startup }
  } catch (error) { await quit(app); throw error }
}

export const invoke = (page, channel, ...args) =>
  page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })

const COLOR_THEMES = { light: 'light', dark: 'dark' }
async function applyTheme(page, theme) {
  await page.waitForFunction(() => localStorage.getItem('ai-novel-writer-appearance') !== null, null, { timeout: TIMEOUT })
  await page.evaluate(colorTheme => {
    const key = 'ai-novel-writer-appearance'
    const current = JSON.parse(localStorage.getItem(key))
    localStorage.setItem(key, JSON.stringify({ ...current, colorTheme, revision: current.revision + 1, origin: 'author' }))
  }, COLOR_THEMES[theme])
  await page.reload()
  await waitForShell(page, TIMEOUT)
}

async function settle(page) {
  await page.evaluate(() => document.fonts.ready)
  await dismissStartupNotice(page)
}

async function shoot(page, file, mask = []) {
  await settle(page)
  await page.screenshot({ path: file, animations: 'disabled', caret: 'hide', mask })
}

async function writeDiagnostics(page, base, options, diagnostics) {
  if (options.dumpDom && page && !page.isClosed()) {
    fs.writeFileSync(`${base}.dom.html`, await page.content())
    fs.writeFileSync(`${base}.aria.yml`, await page.locator('body').ariaSnapshot())
  }
  if (options.console) fs.writeFileSync(`${base}.console.log`, `${diagnostics.join('\n')}\n`)
}

async function runScenario(name, options) {
  const roots = createIsolatedRoots(scratchParent())
  const before = snapshotRealProfiles()
  const diagnostics = []
  const fake = SCENARIOS[name]?.model ? await startFakeModel(diagnostics) : null
  const base = path.join(options.out, `${name}-${options.theme}`)
  const result = { scenario: name, theme: options.theme, isolationRoot: roots.root }
  let session
  try {
    session = await launch({ roots, appRoot: options.appRoot, fakeModelPort: fake?.port, diagnostics })
    if (name === 'startup-timing') {
      await firstInteractiveControl(session.page).waitFor({ state: 'visible', timeout: TIMEOUT })
      const interactiveAt = Date.now()
      const { readyToShow } = await session.app.evaluate(() => globalThis.__driveTiming)
      const timeOrigin = await session.page.evaluate(() => performance.timeOrigin)
      Object.assign(result, { startup: session.startup, launchToInteractiveMs: interactiveAt - session.launchedAt,
        readyToShowToInteractiveMs: readyToShow === null ? null : interactiveAt - readyToShow,
        navigationToInteractiveMs: Math.round(interactiveAt - timeOrigin) })
    } else {
      await applyTheme(session.page, options.theme)
      const context = { ...session, roots, fake, invoke, reload: () => session.page.reload().then(() => waitForShell(session.page, TIMEOUT)) }
      const mask = await SCENARIOS[name].run(context)
      result.screenshot = `${base}.png`
      await shoot(session.page, result.screenshot, mask ?? [])
    }
    if (fake) {
      result.modelRequests = fake.requests.length
      result.externalRequests = await session.app.evaluate(() => globalThis.__driveExternalRequests ?? [])
      assert.deepEqual(result.externalRequests, [], 'fetch 越过夹具访问外部网络')
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    if (session?.page && !session.page.isClosed()) {
      await session.page.screenshot({ path: `${base}.failure.png` }).catch(() => {})
      options = { ...options, dumpDom: true, console: true }
    }
  } finally {
    await writeDiagnostics(session?.page, base, options, diagnostics).catch(() => {})
    if (session) result.quit = await quit(session.app)
    await fake?.close()
  }
  result.residualProcesses = residualProcesses(roots.userData)
  result.externalWrites = externalWrites(before)
  if (!result.error && result.residualProcesses.length === 0) fs.rmSync(roots.root, { recursive: true, force: true })
  return result
}

async function main() {
  let options
  try { options = parseArgs(process.argv.slice(2)) } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exit(2)
  }
  fs.mkdirSync(options.out, { recursive: true })
  const names = options.scenario === 'baseline-all' ? SCREENSHOT_SCENARIOS : [options.scenario]
  const results = []
  for (const name of names) {
    const result = await runScenario(name, options)
    results.push(result)
    process.stdout.write(`${JSON.stringify(result)}\n`)
  }
  const failed = results.filter(result => result.error || result.residualProcesses.length || result.externalWrites.length)
  fs.writeFileSync(path.join(options.out, `${options.scenario}-${options.theme}.json`), JSON.stringify(results, null, 2))
  process.exitCode = failed.length ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
