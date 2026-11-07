/**
 * 模拟用户真写一本书：隔离启动安装版 → 建档 → 架构 → 粗纲 → 细纲 → 蓝图 → 写正文 → 审稿 → 定稿，
 * 每一步的失败都记进报告而不是中断，最后跑一遍只读一致性检查。
 *
 * 铁律（这是给定时任务用的，必须绝对安全）：
 *   1. 所有可写目录都在 --work-root 下（默认 F:\aiNovelWriter\.qa\user-sim），
 *      通过 --user-data-dir / AI_NOVEL_APP_DATA_HOME / AI_NOVEL_LEGACY_SOURCE_HOME /
 *      HOME / USERPROFILE / LOCALAPPDATA / TEMP 全部重定向，绝不读写用户的
 *      C:\Users\<user>\AppData\Roaming\ai-novel-writer 和已有的作品目录。
 *   2. 每轮用唯一书名，避开代理对相同 prompt 的缓存重放。
 *   3. 只启动、只点击，不删除任何已有作品。
 *
 * 用法：
 *   node scripts/qa/user-sim.mjs --report .runtime/qa/user-sim-report.json
 *   node scripts/qa/user-sim.mjs --chapters 3 --words 800 --exe "<exe 路径>"
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

import * as arch from '../redesign/pages/architecture.mjs'
import * as blueprintPage from '../redesign/pages/blueprint.mjs'
import * as chapterView from '../redesign/pages/chapter-view.mjs'
import * as runSheet from '../redesign/pages/run-sheet.mjs'
import * as stage from '../redesign/pages/stage.mjs'
import { withTimeout, closeAppWithTimeout } from './harness-timeouts.mjs'
import { acquireRunLock, clearStaleElectronHandles } from './run-lock.mjs'
import { asarMtimeMs, releaseAsarMtimes } from './lib/install-window.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)

const WORK_ROOT = path.resolve(option('work-root') ?? path.join(repo, '.qa', 'user-sim'))
const REPORT_PATH = path.resolve(option('report') ?? path.join(repo, '.runtime', 'qa', 'user-sim-report.json'))
const CHAPTERS = Number(option('chapters') ?? 3)
const WORDS = Number(option('words') ?? 800)
const PROXY = { url: option('proxy') ?? 'http://127.0.0.1:8790/v1', key: 'test_key' }
 // issue #237：深度检查（1.5.229 起）默认随审稿追加，16 维逐项模型调用
// 串行可达 20+ 分钟——默认超时从 12 分钟上调到 30；仍可用 --review-timeout-min 覆盖。
const REVIEW_SHEET_TIMEOUT_MS = Number(option('review-timeout-min') ?? 30) * 60_000
const ARC_TIMEOUT_MS = Number(option('arc-timeout-min') ?? 25) * 60_000
const GENERATION_TIMEOUT_MS = Number(option('gen-timeout-min') ?? 25) * 60_000

/**
 * 安装包里 app.asar 的 mtime（issue #188）。
 *
 * 现场：找茬卡与修卡每轮必撞 —— 五次 sim 崩溃（「页面崩溃 / Target page closed」）
 * **全部落在覆盖安装 mtime 之后 60–90 秒**（61/64/65/71/78s）。修卡 :55 起跑 → ~:09–16 装完，
 * 找茬卡 :05 起跑 → ~:09–12 进入正文/审稿，两边在同一分钟相遇；而**审稿是最长的一步**（134–414 秒），
 * 所以每次被打断的都恰好是「最贵的那一步」。这不是随机干扰，是**定向打断**。
 *
 * 后果不止白跑一轮：它会把假崩溃记成「审稿不稳定」（#152 / #183 都在追这条），
 * 而**报告自己能不能说清「这次崩溃是不是安装窗口造成的」**，不该靠人每次手比 mtime
 * （已经犯过两次：一次读旧值、一次把 27 分钟读成 27 分钟）。
 */
function resolveExe() {
  const explicit = option('exe')
  if (explicit) {
    assert(fs.existsSync(explicit), `--exe 不存在: ${explicit}`)
    return path.resolve(explicit)
  }
  const installed = 'F:\\aiNovel\\ai-novel-writer\\AI小说作家.exe'
  if (fs.existsSync(installed)) return installed
  const releases = path.join(repo, 'release')
  if (fs.existsSync(releases)) {
    const versions = fs.readdirSync(releases).filter(name => /^\d+\.\d+\.\d+$/.test(name)).sort().reverse()
    for (const version of versions) {
      const candidate = path.join(releases, version, 'win-unpacked', 'AI小说作家.exe')
      if (fs.existsSync(candidate)) return candidate
    }
  }
  throw new Error('找不到可执行文件，用 --exe 指定')
}

/** DeepSeek V4.1 Flash —— 用户指定的写作模型，生成/审核全部走它。 */
const MODEL = {
  id: 'qa-deepseek-flash',
  name: 'QA DeepSeek V4.1 Flash',
  provider: 'custom',
  protocol: 'openai',
  modelName: 'deepseek-v4.1-flash',
  apiKey: PROXY.key,
  baseUrl: PROXY.url,
  temperature: 0.7,
  maxTokens: 32768,
  purposes: ['generation', 'refinement', 'summary'],
}
const FUNCTION_MODELS = {
  outline_generation: MODEL.id, synopsis_generation: MODEL.id,
  blueprint_generation: MODEL.id, draft_generation: MODEL.id,
  outline_review: MODEL.id, synopsis_review: MODEL.id,
  blueprint_review: MODEL.id, draft_review: MODEL.id,
  editor_ai: MODEL.id, agent_chat: MODEL.id,
}

const log = (...args) => console.log('[sim]', ...args)

/**
 * 常驻工作区：整个 QA 只维护**一套**隔离目录和**一本**测试书，逐轮往后写。
 *
 * 为什么不每轮从零开始：长程一致性问题（第 2 章的白风衣到第 20 章变灰）
 * 只有累积到足够章数才暴露得出来；每轮新建只能看到前几章，永远测不到
 * 用户真正抱怨的那类漂移。所以工作区固定在 --work-root 下，测试书一直续写。
 *
 * 想重开一本就传 --fresh，旧的那本会原地留着（不删），只把指针指到新书。
 */
const STATE_PATH = path.join(WORK_ROOT, 'state.json')

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return null
  }
}

function writeState(state) {
  fs.mkdirSync(WORK_ROOT, { recursive: true })
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
}

/** 常驻目录（只建一次，之后每轮复用）。 */
function ensureWorkspace() {
  const root = WORK_ROOT
  const dirs = {
    root,
    appData: path.join(root, 'appData'),
    legacy: path.join(root, 'legacy'),
    userData: path.join(root, 'userData'),
    projects: path.join(root, 'projects'),
    home: path.join(root, 'home'),
    localAppData: path.join(root, 'localappdata'),
    temp: path.join(root, 'temp'),
    appdataRoaming: path.join(root, 'appdata-roaming'),
  }
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true })
  return dirs
}

function seedGlobalConfig(roots) {
  fs.writeFileSync(path.join(roots.legacy, 'models.json'), JSON.stringify([MODEL], null, 2))
  fs.writeFileSync(path.join(roots.legacy, 'config.json'), JSON.stringify({
    theme: 'dark',
    defaultModelId: MODEL.id,
    functionModelIds: FUNCTION_MODELS,
    editorFontSize: 16,
    editorFontFamily: 'Noto Serif SC',
    autoSaveInterval: 30,
  }, null, 2))
}

/** 常驻工作区只清自己的临时垃圾：每次启动清 temp，不动作品与配置。 */
function pruneTemp(roots) {
  if (fs.existsSync(roots.temp)) fs.rmSync(roots.temp, { recursive: true, force: true })
  fs.mkdirSync(roots.temp, { recursive: true })
}

const invoke = (page, channel, ...args) =>
  page.evaluate(({ channel, args }) => window.aiNovelAPI.invoke(channel, ...args), { channel, args })

const invokeSession = (page, session, channel, ...args) =>
  page.evaluate(({ channel, args, session }) => window.aiNovelAPI.invoke(channel, ...args, session), { channel, args, session })

async function launch(roots, exe) {
  const env = {
    ...process.env,
    AI_NOVEL_APP_DATA_HOME: roots.appData,
    AI_NOVEL_LEGACY_SOURCE_HOME: roots.legacy,
    HOME: roots.home,
    USERPROFILE: roots.home,
    LOCALAPPDATA: roots.localAppData,
    APPDATA: roots.appdataRoaming,
    TEMP: roots.temp,
    TMP: roots.temp,
  }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) delete env[key]
  const app = await electron.launch({
    executablePath: exe,
    args: [`--user-data-dir=${roots.userData}`, '--lang=zh-CN'],
    env,
    timeout: 90_000,
  })
  const page = await app.firstWindow({ timeout: 90_000 })
  page.setDefaultTimeout(120_000)
  const proc = app.process()
  proc?.stderr?.on('data', chunk => {
    const text = String(chunk).trim()
    if (/error|Error|ERROR/.test(text)) log('[main:err]', text.slice(0, 400))
  })
  await page.waitForFunction(() => Boolean(window.aiNovelAPI), null, { timeout: 90_000 })
  const state = await page.evaluate(() => window.aiNovelAPI.invoke('startup:get-state'))
  assert.equal(state.state, 'ready', `启动状态 ${JSON.stringify(state)}`)
  await stage.waitForStage(page, 90_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  return { app, page }
}

/** 记录打开作品时的会话（projectId/projectPath/leaseId），后面的 db:* 读要带它。 */
async function trackSession(app) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    const original = handlers.get('project:open')
    globalThis.__simOpened = null
    handlers.set('project:open', async (event, projectPath, ...rest) => {
      const result = await original(event, projectPath, ...rest)
      if (result?.success) {
        globalThis.__simOpened = { projectId: result.project.id, projectPath, leaseId: result.project.sessionLease }
      }
      return result
    })
  })
}

const sessionOf = app => app.evaluate(() => globalThis.__simOpened)

async function stubOpenDialog(app, selectedPath, fn) {
  await app.evaluate(({ dialog }, dir) => {
    globalThis.__simDialogOriginal = dialog.showOpenDialog
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, selectedPath)
  try {
    return await fn()
  } finally {
    await new Promise(resolve => setTimeout(resolve, 300))
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = globalThis.__simDialogOriginal
      delete globalThis.__simDialogOriginal
    })
  }
}

async function dismissStartup(page) {
  const ack = page.locator('.startup-migration-notice').getByRole('button', { name: '知道了', exact: true })
  if (await ack.isVisible().catch(() => false)) await ack.click()
  const close = page.locator('.pi-toast-stack button').first()
  if (await close.isVisible().catch(() => false)) await close.click().catch(() => {})
}

/** 轮询数据库直到 predicate 返回真值。不依赖界面 store，比界面断言稳。 */
async function pollUntil(page, predicate, { timeoutMs = GENERATION_TIMEOUT_MS, intervalMs = 3000, label = '生成' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    last = await predicate(page).catch(error => ({ __pollError: String(error) }))
    if (last && !last.__pollError) return last
    if (Date.now() > deadline) throw new Error(`${label} 超时（最后 ${JSON.stringify(last).slice(0, 400)}）`)
    await page.waitForTimeout(intervalMs)
  }
}

/**
 * 带停滞看门狗的轮询。
 *
 * 8790 通道和应用尾部都可能「静默挂起」：run 停在 running、root 早已不活跃、
 * 数据库再无变化。傻等 20 分钟会让每小时一轮的定时任务彻底失能，
 * 所以每轮读一次属于本轮的项目库（自己的隔离库，只读），
 * 发现**确实没有活跃运行**且库文件超过 stallMs 没变化，就立刻失败并带上诊断。
 *
 * ⚠️ issue #198：原来这段注释说着「发现所有 root 都不活跃」，实现**从没读过 root**——
 * 判据只有「库文件 mtime 多久没动」。于是把「单次调用 200 秒 + 落库」误诊成
 * 「尾部挂起，非通道慢」，而事实恰恰相反（那次细纲 199.7 秒就成功了）。
 * 现在真的问一次 `generation:list`：有 running 的运行就**不算停滞**，
 * 因为「正在跑一个慢调用」和「没人干活了」是两种完全不同的状态。
 *
 * 阈值也跟着放宽：单次细纲实测 199.7 秒、蓝图 104–152 秒，落库还要时间。
 * 302 秒这个数恰好贴在真实分布的边缘上（#198 实测就是这个值被踩）。默认改成
 * 「单次慢调用 + 落库」的两倍量级，宁可多等，也不要再误判掉一个正在成功的调用。
 */
const STALL_DEFAULT_MS = 10 * 60_000

/** 本轮还有没有运行在跑（issue #198）。读不到就当「可能有」——宁可不判停滞。 */
async function hasActiveGeneration(page, session) {
  if (!session) return true
  try {
    const runs = await invokeSession(page, session, 'generation:list')
    if (!Array.isArray(runs)) return true
    return runs.some(run => run?.status === 'running')
  } catch {
    return true
  }
}

/**
 * ⚠️ `session` 是**必填的位置参数**（issue #205）。
 *
 * 上一版把它放在 options 里（`{ session }`），六个调用点里五个传了、一个漏了——
 * 漏的那处（粗纲铺满全书）于是 `hasActiveGeneration` 永远 `return true`，
 * 停滞判定在这一步**完全失效**：真挂死就白等到整步超时（25 分钟量级）。
 *
 * 这正是「可选参数 + 手写传参」的必然结果。改成位置参数后，漏传在**调用处一行可见**，
 * 再配一条结构守卫（`scripts/qa/__tests__/user-sim-poll-session.test.mjs`）扫全部调用点。
 */
async function pollUntilOrStall(page, session, predicate, options = {}) {
  if (!session?.projectId) {
    // 宁可当场炸掉，也不要静默退化成「永远认为有运行在跑」而白等一整步超时。
    throw new Error('pollUntilOrStall: 缺少 session —— 停滞判定无法工作（这是驱动 bug，不是产品问题）')
  }
  const { label, stallMs = STALL_DEFAULT_MS } = options
  const deadline = Date.now() + (options.timeoutMs ?? GENERATION_TIMEOUT_MS)
  const dbPath = path.join(report.projectPath ?? '', '.ai-novel', 'project.db')
  let lastChange = Date.now()
  let lastSignature = null
  let last

  for (;;) {
    last = await predicate(page).catch(error => ({ __pollError: String(error) }))
    if (last && !last.__pollError) return last

    if (fs.existsSync(dbPath)) {
      const stat = fs.statSync(dbPath)
      const signature = `${stat.size}:${stat.mtimeMs}`
      if (signature !== lastSignature) {
        lastSignature = signature
        lastChange = Date.now()
      }
    }

    const idleMs = Date.now() - lastChange
    if (idleMs > stallMs) {
      /**
       * 只有在**确认没有运行在跑**时才算停滞（issue #198）。
       * 有 running 的运行 = 一个慢调用正在走（细纲实测 199.7 秒），要等它。
       */
      if (await hasActiveGeneration(page, session)) {
        lastChange = Date.now() // 重置窗口：还在跑，不判停滞
      } else {
        throw new Error(`${label} 停滞：项目库 ${Math.round(idleMs / 1000)} 秒无变化，`
          + '且 generation:list 里没有任何 running 的运行（确认无人在干活，不是通道慢）')
      }
    }
    if (Date.now() > deadline) throw new Error(`${label} 超时（最后 ${JSON.stringify(last).slice(0, 400)}）`)
    await page.waitForTimeout(options.intervalMs ?? 3000)
  }
}

const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  bookName: null,
  chapters: CHAPTERS,
  wordsPerChapter: WORDS,
  model: MODEL.modelName,
  exe: null,
  /** 起跑时看到的 asar mtime（issue #188）。 */
  asarMtimeAtStart: null,
  /** 收工时看到的 asar mtime（issue #188）。 */
  asarMtimeAtEnd: null,
  /**
   * 这次跑的过程中安装包被换过吗（issue #188）。
   *
   * 判定：收工时的 asar mtime 落进 [startedAt, finishedAt] 区间 —— 说明中途装了新版本，
   * 这一轮的崩溃/异常**不能算产品缺陷**。报告自己说了算，不靠人每次手比 mtime。
   */
  installWindowSuspect: false,
  /** 判定依据（issue #218）：哪一路证据触发、release 侧看到的新构建时间。 */
  installWindowReason: null,
  releaseAsarMtimeAtStart: null,
  releaseAsarMtimeAtEnd: null,
  releaseBuiltDuringRun: null,
  projectPath: null,
  steps: [],
  consoleErrors: [],
  pageErrors: [],
  audit: null,
}

const step = async (name, fn) => {
  log('→', name)
  const started = Date.now()
  try {
    const value = await fn()
    report.steps.push({ name, ok: true, ms: Date.now() - started, value: value ?? null })
    log('  ✓', name, `${((Date.now() - started) / 1000).toFixed(1)}s`)
    return value
  } catch (error) {
    const message = error instanceof Error ? `${error.message}\n${String(error.stack ?? '').slice(0, 1200)}` : String(error)
    report.steps.push({ name, ok: false, ms: Date.now() - started, error: message })
    log('  ✗', name, message.split('\n')[0])
    return null
  }
}

async function main() {
  const fresh = process.argv.includes('--fresh')
  const exe = resolveExe()
  report.exe = exe
  report.asarMtimeAtStart = asarMtimeMs(exe)
  const roots = ensureWorkspace()
  // 工作区独占（issue #54）：并发会话共用默认隔离区时会互相删 temp、撞同一份 userData 的
  // Electron 单实例锁，报错还会写进同一份报告。这里拿不到锁就明确退出，而不是静默共享。
  const lock = acquireRunLock(roots.root, { log: (...args) => log(...args) })
  if (!lock.ok) {
    report.fatal = `工作区被另一个会话占用（pid ${lock.holder.pid}，自 ${lock.holder.startedAt}）：${roots.root}。`
      + ' 换一个 --work-root，或等它结束后重试。'
    // 不能写默认报告路径（issue #54）：那个文件正被**运行中的那个会话**持有，
    // 覆盖它等于把对方的结论抹掉。写到并行的 refused 文件里，事后可查。
    reportTarget = refusedReportPath()
    writeReport()
    log('✗', report.fatal)
    log('报告', reportTarget)
    process.exitCode = 2
    return
  }
  activeLock = lock
  report.runLock = { pid: lock.lock.pid, workRoot: roots.root }
  // 拿到独占锁之后才清残留句柄（确认没有别的会话在跑）：这是本机手动删 DevToolsActivePort
  // 那一步的自动化（issue #54），范围只限 --work-root 下的 userData。
  report.staleElectronHandles = clearStaleElectronHandles(roots.userData, { log: (...args) => log(...args) })
  pruneTemp(roots)
  seedGlobalConfig(roots)
  report.workRoot = roots.root
  log('常驻工作区', roots.root)
  log('可执行文件', exe)

  let state = fresh ? null : readState()
  if (state?.projectPath && !fs.existsSync(state.projectPath)) {
    log('上次的测试书目录已不在，本轮重开一本')
    state = null
  }
  if (!state) {
    state = { bookName: 'QA 夜航船 ' + String(Date.now()).slice(-4), projectPath: null, createdAt: new Date().toISOString() }
  }
  report.bookName = state.bookName
  report.resumed = Boolean(state.projectPath)
  log(state.projectPath ? `续写《${state.bookName}》` : `新开《${state.bookName}》`)

  const { app, page } = await launch(roots, exe)
  page.on('console', message => {
    if (message.type() === 'error') report.consoleErrors.push(message.text().slice(0, 500))
  })
  page.on('pageerror', error => report.pageErrors.push(String(error).slice(0, 800)))

  try {
    await dismissStartup(page)
    await trackSession(app)

    await step('模型通道就绪（DeepSeek V4.1 Flash）', async () => {
      const models = await invoke(page, 'llm:list-models')
      assert.ok(models.some(item => item.id === MODEL.id), `隔离模型不在列表里：${models.map(m => m.id)}`)
      const functionModels = await invoke(page, 'llm:get-function-models')
      assert.equal(functionModels.draft_generation, MODEL.id, '正文生成没指向 Flash')
      return { model: MODEL.modelName }
    })

    await step(state.projectPath ? '打开常驻测试书' : '新建测试书（仅第一次）', async () => {
      if (!state.projectPath) {
        await page.getByRole('button', { name: '新建作品', exact: true }).click()
        const dialog = page.getByRole('dialog')
        await dialog.waitFor({ state: 'visible', timeout: 30_000 })
        await dialog.getByRole('textbox').first().fill(state.bookName)
        await stubOpenDialog(app, roots.projects, () => dialog.getByRole('button', { name: '选择', exact: true }).click())
        await dialog.getByRole('button', { name: /^(创建项目|创建作品)$/ }).click()
        await dialog.waitFor({ state: 'hidden', timeout: 90_000 })
        await stage.waitForWork(page, state.bookName, 90_000)
      } else {
        await stage.openFromLibrary(page, state.bookName)
      }
      const session = await sessionOf(app)
      assert.ok(session?.leaseId, '没拿到项目会话')
      state.projectPath = session.projectPath
      report.projectPath = session.projectPath
      writeState(state)
      return { projectPath: session.projectPath }
    })

    // 设定只在第一次写；之后每轮把总章数抬到「本次要写到哪」之后的余量。
    await step('确保核心设定', async () => {
      const session = await sessionOf(app)
      const core = await invokeSession(page, session, 'db:project-core-get', session.projectPath)
      const finalized = await finalizedChapters(page, session)
      const nextChapter = await nextChapterFromAuthority(page, session)
      const furthest = Math.max(0, ...finalized)
      const target = Math.max(Number(core?.totalChapters ?? 0) || 0, (nextChapter ?? furthest + 1) + CHAPTERS, 8)
      const saved = await invoke(page, 'project:update-config', session.projectId, {
        novelConfig: {
          ...(String(core?.coreOutline ?? '').trim() ? {} : {
            coreOutline: '沿海小城的夜航船每夜多载一名不该上船的乘客。船工周叙要在航次记录被涂改前查出是谁在替死人买票，而他的搭档温珩始终穿着同一件洗得发白的靛蓝短褂。',
          }),
          genre: core?.genre || '悬疑',
          targetAudience: core?.targetAudience || '男频',
          totalChapters: target, wordsPerChapter: WORDS, writingLanguage: 'zh-CN',
        },
      }, session.projectPath, session)
      assert.equal(saved.success ?? true, true, JSON.stringify(saved))
      await page.reload()
      await stage.waitForStage(page, 90_000)
      await stage.openFromLibrary(page, state.bookName)
      return { totalChapters: target, nextChapter, finalizedChapters: finalized }
    })

    await step('确保故事前提/世界观/角色', async () => {
      const session = await sessionOf(app)
      const core = await invokeSession(page, session, 'db:project-core-get', session.projectPath)
      if (core?.premise && core?.worldbuilding && core?.charactersArch) {
        return { skipped: true, premiseLength: (core.premise ?? '').length }
      }
      await arch.open(page)
      await arch.primary(page).click()
      await arch.dialog(page).waitFor({ state: 'visible', timeout: 30_000 })
      await arch.selectOnly(page, ['premise', 'worldbuilding', 'characters'])
      await arch.startGenerate(page)
      await runSheet.waitForRunDone(page, GENERATION_TIMEOUT_MS)
      const value = await pollUntilOrStall(page, session, async () => {
        const current = await invokeSession(page, session, 'db:project-core-get', session.projectPath)
        return current?.premise && current?.worldbuilding && current?.charactersArch ? current : null
      }, { label: '故事前提与世界观' })
      return { premiseLength: (value.premise ?? '').length, charactersArchLength: (value.charactersArch ?? '').length }
    })

    await step('确保粗纲覆盖到本次要写的章', async () => {
      const session = await sessionOf(app)
      const core = await invokeSession(page, session, 'db:project-core-get', session.projectPath)
      const wanted = Math.max(Number(core?.totalChapters ?? 0) || 0, CHAPTERS + 2, 8)
      const existing = await invokeSession(page, session, 'db:arc-outline-list', session.projectPath)
      const covered = (existing ?? []).reduce((max, item) => Math.max(max, item.toChapter), 0)
      if (covered >= wanted) return { skipped: true, coveredTo: covered }
      await arch.open(page)
      const button = await arch.page(page).getByRole('button', { name: /^(一键生成全部粗纲|继续生成粗纲)$/ }).first()
      await button.click().catch(async () => {
        await arch.primary(page).click()
        await arch.dialog(page).waitFor({ state: 'visible', timeout: 30_000 })
        await arch.selectOnly(page, ['arc'])
        await arch.startGenerate(page)
      })
      const arcs = await pollUntilOrStall(page, session, async () => {
        const list = await invokeSession(page, session, 'db:arc-outline-list', session.projectPath)
        const coveredNow = (list ?? []).reduce((max, item) => Math.max(max, item.toChapter), 0)
        return coveredNow >= wanted ? list : null
      }, { timeoutMs: ARC_TIMEOUT_MS, intervalMs: 5000, label: '粗纲铺满全书' })
      // 粗纲成功后运行侧页不会自己收起（issue #39）：作者会点「收起」，harness 也必须收，
      // 否则下一步「确保蓝图」的前置检查与按钮点击全被这个侧页挡着。
      await runSheet.closeIfOpen(page)
      return { segments: arcs.length, coveredTo: arcs.at(-1)?.toChapter }
    })

    // 每轮要写的范围：从应用的权威「下一章」开始，连写 CHAPTERS 章。
    // 上一轮如果只写了草稿没定稿，下一章不会前进——这是应用的实际语义，
    // harness 必须跟着它走，否则会一直重写同一章。
    const session0 = await sessionOf(app)
    const finalized0 = await finalizedChapters(page, session0)
    const first = await nextChapterFromAuthority(page, session0)
    assert.ok(Number.isSafeInteger(first) && first >= 1, `拿不到权威下一章：${first}`)
    const from = first
    const to = first + CHAPTERS - 1
    report.writingRange = { from, to, finalizedChapters: finalized0 }
    log(`本轮写第 ${from}–${to} 章（已定稿 ${finalized0.length} 章）`)

    await step(`确保细纲 ${from}–${to}`, async () => {
      const session = await sessionOf(app)
      const core = await invokeSession(page, session, 'db:project-core-get', session.projectPath)
      const synopsis = String(core?.synopsis ?? '')
      const hasRange = new RegExp(`^## 第${to}章`, 'mu').test(synopsis)
      if (hasRange) return { skipped: true, synopsisLength: synopsis.length }
      await arch.open(page)
      // 入口按状态选（issue #46）：五节全确认后主按钮是禁用的「下一步：章节蓝图」，
      // 「继续生成架构」在那一刻不存在；连续生成自己按「已有末章 + 1」算范围，不会重写已写章节。
      const entry = await arch.continueSynopsis(page)
      // 兜底路径（走了对话框）才需要确认范围；默认值已是「接在最后一章之后」，
      // 这里显式再算一次，避免默认值退回 1–5 把已写好的细纲整批覆盖（issue #46 的第二处危险）。
      if (entry === 'dialog') {
        const blocks = [...synopsis.matchAll(/^## 第(\d+)章/gmu)].map(m => Number(m[1]))
        const nextFrom = blocks.length ? Math.max(...blocks) + 1 : 1
        await arch.setRange(page, nextFrom, Math.max(nextFrom, to))
        await arch.startGenerate(page)
      }
      const value = await pollUntilOrStall(page, session, async () => {
        const current = await invokeSession(page, session, 'db:project-core-get', session.projectPath)
        return new RegExp(`^## 第${to}章`, 'mu').test(String(current?.synopsis ?? '')) ? current : null
      }, { label: `细纲 ${from}–${to}` })
      const blocks = [...String(value.synopsis).matchAll(/^## 第(\d+)章/gmu)].map(m => Number(m[1]))
      return { entry, synopsisLength: value.synopsis.length, chapters: blocks }
    })

    await step(`确保蓝图 ${from}–${to}`, async () => {
      const session = await sessionOf(app)
      await blueprintPage.open(page)
      // 先判断再点（issue #50）：胶囊只在「有运行且侧页展开」时存在，
      // 直接 click 会等满默认超时（120 秒）并抛错，吞掉后就变成「白等 120 秒却打 ✓」。
      const collapsed = await runSheet.collapseCapsule(page)
      if (collapsed !== 'no-capsule' && collapsed !== 'collapsed') log(`  收起运行胶囊未成功：${collapsed}`)
      const existing = await invokeSession(page, session, 'db:blueprint-get-all', session.projectPath)
      const missing = []
      for (let chapter = from; chapter <= to; chapter += 1) {
        if (!(existing ?? []).some(item => item.chapterNumber === chapter)) missing.push(chapter)
      }
      if (!missing.length) return { skipped: true }
      await blueprintPage.generateRange(page, missing[0], missing.at(-1))
      await runSheet.waitForRunDone(page, GENERATION_TIMEOUT_MS)
      const blueprints = await pollUntilOrStall(page, session, async () => {
        const list = await invokeSession(page, session, 'db:blueprint-get-all', session.projectPath)
        const got = (list ?? []).filter(item => item.chapterNumber >= from && item.chapterNumber <= to)
        return got.length === (to - from + 1) ? got : null
      }, { label: '蓝图落库' })
      return { chapters: blueprints.map(item => item.chapterNumber) }
    })

/**
 * **进入正文生成之前再查一次安装 mtime**（issue #188 建议 ②）。
 *
 * 这是最后一个「便宜的回退点」：前面的细纲/蓝图已花 2–4 分钟，
 * 而正文 + 审稿要 6–10 分钟（审稿单步 134–414 秒，是最贵的）。
 * 若安装包在本次运行期间被换过，现在停还能保住已产出的细纲/蓝图。
 *
 * ⚠️ 只**放弃本轮**并写明原因，不改任何产品行为——找茬卡的纪律是「撞窗口就不跑」。
 */
const currentAsarMtime = asarMtimeMs(report.exe)
if (currentAsarMtime !== null && report.asarMtimeAtStart !== null && currentAsarMtime !== report.asarMtimeAtStart) {
  report.installWindowSuspect = true
  throw new Error(`安装包在本次运行期间被替换（asar mtime=${new Date(currentAsarMtime).toISOString()}），`
    + '已停在正文生成之前：这一轮的产物（细纲/蓝图）保留，但正文/审稿不再跑——'
    + '否则崩溃会被误记成产品缺陷（issue #188）。')
}

for (let chapter = from; chapter <= to; chapter += 1) {
      await step(`写第 ${chapter} 章正文`, async () => {
        const session = await sessionOf(app)
        await stage.stageButton(page, '蓝图').click()
        await blueprintPage.plan(page).waitFor({ state: 'visible', timeout: 60_000 })
        // 同上：按状态判断，不靠超时兜底，也不吞错（issue #50）。
        const collapsed = await runSheet.collapseCapsule(page)
        if (collapsed !== 'no-capsule' && collapsed !== 'collapsed') log(`  收起运行胶囊未成功：${collapsed}`)

        // 以按钮文字为准：应用始终把「权威下一章」摆在主按钮上，
        // 若它和 harness 认为的 chapter 不同，说明前面某一章还没定稿，
        // 此时按按钮实际写的章号处理，不要硬套自己的编号。
        const button = page.getByRole('button', { name: /^写第 \d+ 章$/ }).first()
        await button.waitFor({ state: 'visible', timeout: 60_000 })
        const buttonText = (await button.innerText()).trim()
        const target = Number(buttonText.match(/\d+/)?.[0] ?? chapter)
        if (target !== chapter) log(`  主按钮实际是「${buttonText}」，按第 ${target} 章处理`)

        await button.click()
        // 预检有提醒时应用会先把弹层打开（issue #53）：点完「写第 N 章」就等运行会永远停在这一层。
        // 按状态判断，并把提醒摘要记进报告——这是应用给作者的核心信号，报告里不该看不到。
        const preflight = await blueprintPage.continuePastPreflight(page)
        if (preflight.outcome === 'continued') log(`  一致性预检有提醒，已点「带提醒继续写」：${preflight.summary.replace(/\s+/g, ' ').slice(0, 160)}`)
        else if (preflight.outcome === 'no-continue-button') log(`  弹层出现但没有「带提醒继续写」按钮（可能不是一致性预检）：${String(preflight.summary ?? '').replace(/\s+/g, ' ').slice(0, 200)}`)
        // issue #210：`no-dialog` 原来完全静默，日志里「点完就跳到停滞」，看不出中间发生过什么。
        // 这一行本身是诊断信息：弹层没出现 ≠ 点了没生效，但两者在界面上一样无反馈。
        else log(`  点完 ${preflight.waitedMs ?? 3000} 毫秒内没等到任何弹层（no-dialog）——正文还没开始，稍后按「草稿」判据继续等`)
        await runSheet.waitForRunDone(page, GENERATION_TIMEOUT_MS)
        const draft = await pollUntilOrStall(page, session, async () => {
          const list = await invokeSession(page, session, 'db:draft-list', target, session.projectPath)
          const latest = [...(list ?? [])].reverse().find(item => item.wordCount > 200)
          return latest ?? null
        }, { label: `第 ${target} 章草稿` })
        return { chapter: target, preflight: preflight.outcome, draftId: draft.id, version: draft.version, words: draft.wordCount }
      })

      // 定稿会触发连续性抽取与角色状态回写——长程一致性的关键一环，必须走。
      await step(`审稿并定稿第 ${chapter} 章`, async () => {
        const session = await sessionOf(app)
        const drafts = await invokeSession(page, session, 'db:draft-list', chapter, session.projectPath)
        const latest = [...(drafts ?? [])].reverse()[0]
        if (latest?.status === 'finalized') return { skipped: true }
        await chapterView.open(page, chapter)

        // 已有审稿记录的稿，面板会自己出现；没有就先点「AI 审稿」。
        // 审稿实测量级是几分钟（本轮首章审稿用了 5 分多），等待必须给足，
        // 否则会把「生成慢」误报成「界面不出审稿报告」。
        // 注意 review() 内部的等待也要传同一时长（issue #37）：它此前写死 60 秒，
        // 会在下面这句可配等待生效之前先超时，把 REVIEW_SHEET_TIMEOUT_MS 架空。
        if (!await chapterView.reviewSheet(page).isVisible().catch(() => false)) {
          await chapterView.review(page, { timeoutMs: REVIEW_SHEET_TIMEOUT_MS })
        }
        await chapterView.reviewSheet(page).waitFor({ state: 'visible', timeout: REVIEW_SHEET_TIMEOUT_MS })
        const excerpt = await chapterView.reviewSheet(page).innerText().catch(() => '')
        await chapterView.finalize(page, chapter)
        await pollUntilOrStall(page, session, async () => {
          const list = await invokeSession(page, session, 'db:draft-list', chapter, session.projectPath)
          return (list ?? []).some(item => item.status === 'finalized') ? list : null
        }, { label: `第 ${chapter} 章定稿` })

        // 定稿 → 后处理链（知识库导入/要点/角色状态/事实账本）。写下一章的前置条件，
        // 不等完就点下一章会被静默拒绝（见 waitForPostProcess 的注释）。
        const postProcess = await waitForPostProcess(page, session, chapter)
        return { reviewExcerpt: excerpt.slice(0, 400), postProcess }
      })
    }

    await step('角色状态与账本快照', async () => {
      const session = await sessionOf(app)
      const finalized = await finalizedChapters(page, session)
      const nextChapter = await nextChapterFromAuthority(page, session)
      const furthest = finalized.at(-1) ?? 0
      const continuity = await invokeSession(page, session, 'db:continuity-list-before', furthest + 1, session.projectPath)
      const characters = await invokeSession(page, session, 'db:character-get-all', session.projectPath)
      const updated = (characters ?? []).filter(item => typeof item.currentState?.updatedAtChapter === 'number')
      return {
        finalizedChapters: finalized,
        nextChapter,
        continuityEntries: (continuity ?? []).length,
        characters: (characters ?? []).length,
        withState: updated.length,
        missingAppearance: (characters ?? []).filter(item => !String(item.appearance ?? '').trim()).map(item => item.name),
      }
    })
    // 收尾截图（issue #31）：必须带超时。页面已崩时 evaluate 等的是「目标可用」而非 selector，
    // 默认超时对它无效、会永不返回；这里用 Promise.race 强制兜底，失败只记 null，不阻塞关闭。
    report.finalScreen = await withTimeout(
      page.evaluate(() => document.body.innerText.slice(0, 2000)),
      15_000,
      'finalScreen 采集',
    ).catch(() => null)
  } finally {
    // 收尾只负责「一定把 app 关掉」（issue #31）。
    //
    // 旧写法把 page.evaluate 放在 finally 里且没给 timeout：页面已崩时它等的是
    // 「目标可用」而不是 selector，默认超时失效、**永不返回**，于是同步阻塞在 finally 中，
    // app.close() 永不执行 → app 占着单实例锁与 project.db → 下一轮启动被锁死。
    // 现在：finalScreen 采集挪进带超时的 try，finally 只做有超时兜底的关闭。
    await closeAppWithTimeout(app, { log })
  }
}

/**
 * 本轮该写哪几章。
 *
 * 注意：应用决定「下一章」用的是 `db:draft-authority-sequence`，它按**已定稿**序列算，
 * 不是按有没有草稿。只写了草稿没定稿的章，主按钮仍然是「写第 N 章」。
 * harness 早期版本拿「最大草稿章号 + 1」当下一章，结果每轮都在重写同一章，
 * 并被误判成「点写作但没产生运行」。这里直接问应用权威序列，跟它看到的一致。
 */
async function nextChapterFromAuthority(page, session) {
  const sequence = await invokeSession(page, session, 'db:draft-authority-sequence', session.projectPath)
  const next = Number(sequence?.nextChapterNumber)
  return Number.isSafeInteger(next) && next >= 1 ? next : null
}

/**
 * 等某一章的后处理链（定稿后处理）全部关键步骤跑完。
 *
 * 为什么必须等：`guardChapterWriting` 要求「前一章定稿后处理全部通过」才允许写下一章；
 * 不满足时点击会被拒绝并且**不产生任何运行行**（只在弹层里给一句提示）。
 * harness 早期版本定稿完就立刻点下一章，正好撞进后处理还没跑完的窗口，
 * 于是表现成「点了没反应、也查不到运行」——那不是产品缺陷。
 */
async function waitForPostProcess(page, session, chapter, { timeoutMs = 10 * 60_000, intervalMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  for (;;) {
    const run = await invokeSession(page, session, 'db:post-process-get-latest-run', 'chapter_finalize', String(chapter), session.projectPath)
      .catch(() => null)
    if (run?.id) {
      const steps = await invokeSession(page, session, 'db:post-process-get-steps', run.id, session.projectPath).catch(() => [])
      const pending = (steps ?? []).filter(step => !step.completedAt)
      last = { allCriticalPassed: run.allCriticalPassed, steps: (steps ?? []).map(s => ({ key: s.stepKey, done: Boolean(s.completedAt) })) }
      if (!pending.length && run.allCriticalPassed) return last
    }
    if (Date.now() > deadline) throw new Error(`第 ${chapter} 章后处理未在期限内通过：${JSON.stringify(last).slice(0, 300)}`)
    await page.waitForTimeout(intervalMs)
  }
}

/** 已定稿的章号：定稿才进权威序列，决定连续性产物和下一章。 */
async function finalizedChapters(page, session) {
  const drafts = await invokeSession(page, session, 'db:draft-list-all', session.projectPath).catch(() => [])
  return [...new Set((drafts ?? [])
    .filter(item => item.status === 'finalized')
    .map(item => Number(item.chapterNumber)))]
    .filter(Number.isSafeInteger)
    .sort((a, b) => a - b)
}

async function runAudit() {
  if (!report.projectPath) return null
  try {
    const { spawnSync } = await import('node:child_process')
    const output = path.join(path.dirname(REPORT_PATH), 'audit-user-sim.json')
    fs.mkdirSync(path.dirname(output), { recursive: true })
    const result = spawnSync(process.execPath, [
      path.join(repo, 'scripts', 'qa', 'consistency-audit.mjs'),
      `--project=${report.projectPath}`,
      `--json=${output}`,
      '--quiet',
    ], { encoding: 'utf8', timeout: 5 * 60_000 })
    if (result.status !== 0 && result.status !== 1) {
      return { ok: false, error: (result.stderr ?? '').slice(0, 800) }
    }
    const parsed = JSON.parse(fs.readFileSync(output, 'utf8'))
    return { ok: true, findings: parsed.findings, cardIssues: parsed.cardIssues, stats: parsed.stats, reportPath: output }
  } catch (error) {
    return { ok: false, error: String(error).slice(0, 800) }
  }
}

// 工作区独占锁（issue #54）：进程退出时释放，别把下一轮挡死。
let activeLock = null
// 报告落盘目标：被工作区锁挡下时切到 refused 文件，避免覆盖正在跑的那个会话的报告（issue #54）。
let reportTarget = REPORT_PATH

// 兜底（issue #31）：任何时候进程要退出，报告都得先落盘。
// 收尾章节里若还有未加超时的 await 挂住，这个钩子仍会把已收集的部分写下去。
process.on('exit', () => {
  try { activeLock?.release() } catch { /* 锁已失效就留着，让死进程判据处理 */ }
  try { writeReport() } catch { /* 退出路径照旧 */ }
})
process.on('uncaughtException', error => {
  report.fatal = String(error?.stack ?? error).slice(0, 2000)
  try { writeReport() } catch { /* 忽略 */ }
  process.exit(1)
})
process.on('SIGINT', () => {
  try { writeReport() } catch { /* 忽略 */ }
  process.exit(130)
})

try {
  await main()
} catch (error) {
  report.fatal = String(error).slice(0, 2000)
  log('fatal', report.fatal)
} finally {
  // 落盘必须在任何可能挂住的收尾动作之前（issue #31）：报告写不下去，
  // 这一轮就等于白跑——作者/巡检看不到 failedSteps、stalled 与截图。
  writeReport()
  // 审计（只读，跑在别的目录）之前就释放工作区锁：审计可能要几分钟，
  // 而它不需要独占工作区——早放锁让下一个会话不必空等（issue #54）。
  try { activeLock?.release() } catch { /* 忽略 */ }
  activeLock = null
  // 审计本身可能很慢（大量输出时 spawnSync 的 timeout 不可靠）；套一层硬超时，
  // 超时只记 null，不再拖住收尾。
  report.audit = await withTimeout(runAudit(), 6 * 60_000, 'runAudit').catch(error => {
    log('审计未在超时内完成:', String(error?.message ?? error).slice(0, 200))
    return { ok: false, error: 'timeout' }
  })
  writeReport()
  log('报告', reportTarget)
  log('失败步骤', report.failedSteps.length ? report.failedSteps.join(' / ') : '无')
  if (report.audit?.findings?.length) log('一致性冲突', report.audit.findings.length)
  // 已在更早的分支里定过的非零退出码不能被覆盖（issue #54：被锁挡下的会话要退出码 2）。
  if (!process.exitCode) process.exitCode = report.failedSteps.length || report.audit?.findings?.length ? 1 : 0
}

/** 幂等落盘（issue #31）：收尾任何一步都可能挂住，报告必须先落地。 */
/** 被工作区锁挡下时的报告路径：与默认报告并存，不覆盖正在跑的那个会话。 */
function refusedReportPath() {
  return REPORT_PATH.replace(/\.json$/u, '') + `-refused-${process.pid}.json`
}

function writeReport(target = reportTarget) {
  report.finishedAt = new Date().toISOString()
  /**
   * issue #188：这一轮有没有撞上覆盖安装窗口。
   *
   * 判据是**区间**而不是差值：只要收工时看到的 asar mtime 落在本次运行的时间段里，
   * 就说明中途换过安装包 —— 那一次的崩溃/异常不能算产品缺陷。
   * ⚠️ 用「startedAt ≤ mtime ≤ finishedAt」而不是「mtime > startedAt」：
   * 前者能覆盖「起跑那一刻刚好在装」的边界情况（那时 mtime 已经新了，但安装还没写完 asar）。
   */
  report.asarMtimeAtEnd = asarMtimeMs(report.exe)
  /**
   * 第二路证据（issue #218）：本次运行窗口里，**release 目录下有没有新构建出来的包**。
   *
   * 为什么需要它：装到安装目录是修卡的**最后一步**（先构建、再 robocopy /MIR），
   * 所以应用完全可能「先被替换掉别的文件而死」，而 app.asar 还没轮到 ——
   * 上面那条单文件判据就读不出「撞窗口」。而 release 侧的新 asar mtime 一定落在
   * 构建那一刻：实测那一次正是 12:11:51 构建出 1.5.207、12:13:07 应用崩溃，
   * 而安装目录的 app.asar 从头到尾没变（11:27:23）→ 单看安装目录会漏报。
   *
   * ⚠️ 只看「新于本次起跑」的构建：别的并行任务早先留下的包不算。
   */
  const startedMsForInstall = Date.parse(report.startedAt)
  const finishedMsForInstall = Date.parse(report.finishedAt)
  const releaseBuilds = releaseAsarMtimes(repo, { startedAtMs: startedMsForInstall, finishedAtMs: finishedMsForInstall })
  report.releaseAsarMtimeAtStart = releaseBuilds.startedAtMax ?? null
  report.releaseAsarMtimeAtEnd = releaseBuilds.endedAtMax ?? null
  report.releaseBuiltDuringRun = releaseBuilds.newestInRunWindow ?? null
  if (report.asarMtimeAtStart !== null && report.asarMtimeAtEnd !== null) {
    const startedMs = Date.parse(report.startedAt)
    const finishedMs = Date.parse(report.finishedAt)
    report.installWindowSuspect = report.asarMtimeAtEnd > report.asarMtimeAtStart
      && report.asarMtimeAtEnd >= startedMs && report.asarMtimeAtEnd <= finishedMs
    // 安装目录没变、但 release 里在本次运行期间构建出了新包 → 也算撞窗口（见上）。
    if (!report.installWindowSuspect) {
      const built = releaseBuilds.newestInRunWindow
      if (built !== null && built >= startedMsForInstall) {
        report.installWindowSuspect = true
        report.installWindowReason = "release 目录在本次运行期间构建出了新包（安装目录的 app.asar 尚未被替换，但应用已可能被 /MIR 换掉别的文件）"
      }
    }
  }
  report.failedSteps = report.steps.filter(item => !item.ok).map(item => item.name)
  report.stalled = report.steps.filter(item => /停滞/.test(item.error ?? '')).map(item => item.name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(report, null, 2))
}