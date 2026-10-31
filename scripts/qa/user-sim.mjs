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

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)

const WORK_ROOT = path.resolve(option('work-root') ?? path.join(repo, '.qa', 'user-sim'))
const REPORT_PATH = path.resolve(option('report') ?? path.join(repo, '.runtime', 'qa', 'user-sim-report.json'))
const CHAPTERS = Number(option('chapters') ?? 3)
const WORDS = Number(option('words') ?? 800)
const PROXY = { url: option('proxy') ?? 'http://127.0.0.1:8790/v1', key: 'test_key' }
const REVIEW_SHEET_TIMEOUT_MS = Number(option('review-timeout-min') ?? 12) * 60_000
const ARC_TIMEOUT_MS = Number(option('arc-timeout-min') ?? 25) * 60_000
const GENERATION_TIMEOUT_MS = Number(option('gen-timeout-min') ?? 25) * 60_000

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
 * 发现所有 root 都不活跃且库文件超过 stallMs 没变化，就立刻失败并带上诊断，
 * 让找茬任务能区分「应用挂起」和「通道慢」。
 */
async function pollUntilOrStall(page, predicate, { label, stallMs = 4 * 60_000, ...options } = {}) {
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

    if (Date.now() - lastChange > stallMs) {
      throw new Error(`${label} 停滞：项目库 ${Math.round((Date.now() - lastChange) / 1000)} 秒无变化，`
        + '生成根部已不活跃但没有产物（疑似尾部挂起，非通道慢）')
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
  const roots = ensureWorkspace()
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
      const value = await pollUntilOrStall(page, async () => {
        const current = await invokeSession(page, session, 'db:project-core-get', session.projectPath)
        return current?.premise && current?.worldbuilding && current?.charactersArch ? current : null
      }, { label: '故事前提与世界观', stallMs: 5 * 60_000 })
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
      const arcs = await pollUntilOrStall(page, async () => {
        const list = await invokeSession(page, session, 'db:arc-outline-list', session.projectPath)
        const coveredNow = (list ?? []).reduce((max, item) => Math.max(max, item.toChapter), 0)
        return coveredNow >= wanted ? list : null
      }, { timeoutMs: ARC_TIMEOUT_MS, intervalMs: 5000, label: '粗纲铺满全书', stallMs: 5 * 60_000 })
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
      await arch.page(page).getByRole('button', { name: '继续生成架构' }).click()
      await arch.selectOnly(page, ['synopsis'])
      await arch.setRange(page, 1, to)
      await arch.startGenerate(page)
      const value = await pollUntilOrStall(page, async () => {
        const current = await invokeSession(page, session, 'db:project-core-get', session.projectPath)
        return new RegExp(`^## 第${to}章`, 'mu').test(String(current?.synopsis ?? '')) ? current : null
      }, { label: `细纲 1–${to}`, stallMs: 5 * 60_000 })
      const blocks = [...String(value.synopsis).matchAll(/^## 第(\d+)章/gmu)].map(m => Number(m[1]))
      return { synopsisLength: value.synopsis.length, chapters: blocks }
    })

    await step(`确保蓝图 ${from}–${to}`, async () => {
      const session = await sessionOf(app)
      await blueprintPage.open(page)
      await page.locator('.stage-capsule[aria-expanded="true"]').click().catch(() => {})
      const existing = await invokeSession(page, session, 'db:blueprint-get-all', session.projectPath)
      const missing = []
      for (let chapter = from; chapter <= to; chapter += 1) {
        if (!(existing ?? []).some(item => item.chapterNumber === chapter)) missing.push(chapter)
      }
      if (!missing.length) return { skipped: true }
      await blueprintPage.generateRange(page, missing[0], missing.at(-1))
      await runSheet.waitForRunDone(page, GENERATION_TIMEOUT_MS)
      const blueprints = await pollUntilOrStall(page, async () => {
        const list = await invokeSession(page, session, 'db:blueprint-get-all', session.projectPath)
        const got = (list ?? []).filter(item => item.chapterNumber >= from && item.chapterNumber <= to)
        return got.length === (to - from + 1) ? got : null
      }, { label: '蓝图落库', stallMs: 5 * 60_000 })
      return { chapters: blueprints.map(item => item.chapterNumber) }
    })

for (let chapter = from; chapter <= to; chapter += 1) {
      await step(`写第 ${chapter} 章正文`, async () => {
        const session = await sessionOf(app)
        await stage.stageButton(page, '蓝图').click()
        await blueprintPage.plan(page).waitFor({ state: 'visible', timeout: 60_000 })
        await page.locator('.stage-capsule[aria-expanded="true"]').click().catch(() => {})

        // 以按钮文字为准：应用始终把「权威下一章」摆在主按钮上，
        // 若它和 harness 认为的 chapter 不同，说明前面某一章还没定稿，
        // 此时按按钮实际写的章号处理，不要硬套自己的编号。
        const button = page.getByRole('button', { name: /^写第 \d+ 章$/ }).first()
        await button.waitFor({ state: 'visible', timeout: 60_000 })
        const buttonText = (await button.innerText()).trim()
        const target = Number(buttonText.match(/\d+/)?.[0] ?? chapter)
        if (target !== chapter) log(`  主按钮实际是「${buttonText}」，按第 ${target} 章处理`)

        await button.click()
        await runSheet.waitForRunDone(page, GENERATION_TIMEOUT_MS)
        const draft = await pollUntilOrStall(page, async () => {
          const list = await invokeSession(page, session, 'db:draft-list', target, session.projectPath)
          const latest = [...(list ?? [])].reverse().find(item => item.wordCount > 200)
          return latest ?? null
        }, { label: `第 ${target} 章草稿`, stallMs: 6 * 60_000 })
        return { chapter: target, draftId: draft.id, version: draft.version, words: draft.wordCount }
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
        if (!await chapterView.reviewSheet(page).isVisible().catch(() => false)) {
          await chapterView.review(page)
        }
        await chapterView.reviewSheet(page).waitFor({ state: 'visible', timeout: REVIEW_SHEET_TIMEOUT_MS })
        const excerpt = await chapterView.reviewSheet(page).innerText().catch(() => '')
        await chapterView.finalize(page, chapter)
        await pollUntilOrStall(page, async () => {
          const list = await invokeSession(page, session, 'db:draft-list', chapter, session.projectPath)
          return (list ?? []).some(item => item.status === 'finalized') ? list : null
        }, { label: `第 ${chapter} 章定稿`, stallMs: 8 * 60_000 })

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
  } finally {
    report.finalScreen = await page.evaluate(() => document.body.innerText.slice(0, 2000)).catch(() => null)
    await app.close().catch(() => {})
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

try {
  await main()
} catch (error) {
  report.fatal = String(error).slice(0, 2000)
  log('fatal', report.fatal)
} finally {
  report.audit = await runAudit()
  report.finishedAt = new Date().toISOString()
  report.failedSteps = report.steps.filter(item => !item.ok).map(item => item.name)
  report.stalled = report.steps.filter(item => /停滞/.test(item.error ?? '')).map(item => item.name)
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true })
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2))
  log('报告', REPORT_PATH)
  log('失败步骤', report.failedSteps.length ? report.failedSteps.join(' / ') : '无')
  if (report.audit?.findings?.length) log('一致性冲突', report.audit.findings.length)
  process.exitCode = report.failedSteps.length || report.audit?.findings?.length ? 1 : 0
}