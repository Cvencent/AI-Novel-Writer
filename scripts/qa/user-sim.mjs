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
 * 每轮一套全新的隔离目录。dirname 带上时间戳，旧轮次留着供排查，
 * 但只保留最近几轮（清理在本脚本末尾做，只清自己的 work-root）。
 */
function makeRoots() {
  fs.mkdirSync(WORK_ROOT, { recursive: true })
  const root = path.join(WORK_ROOT, `run-${Date.now()}`)
  const dirs = {
    root,
    appData: path.join(root, 'appData'),
    legacy: path.join(root, 'legacy'),
    userData: path.join(root, 'userData'),
    projects: path.join(root, 'projects'),
    home: path.join(root, 'home'),
    localAppData: path.join(root, 'localappdata'),
    temp: path.join(root, 'temp'),
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

/** 只清 work-root 下自己的旧轮次，保留最近 3 轮。 */
function pruneOldRuns() {
  if (!fs.existsSync(WORK_ROOT)) return
  const runs = fs.readdirSync(WORK_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^run-\d+$/.test(entry.name))
    .map(entry => ({ name: entry.name, at: fs.statSync(path.join(WORK_ROOT, entry.name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  for (const run of runs.slice(3)) fs.rmSync(path.join(WORK_ROOT, run.name), { recursive: true, force: true })
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
    APPDATA: path.join(roots.root, 'appdata-roaming'),
    TEMP: roots.temp,
    TMP: roots.temp,
  }
  fs.mkdirSync(env.APPDATA, { recursive: true })
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

const bookName = 'QA 夜航船 ' + String(Date.now()).slice(-4)

const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  bookName,
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
  pruneOldRuns()
  const exe = resolveExe()
  report.exe = exe
  const roots = makeRoots()
  report.workRoot = roots.root
  seedGlobalConfig(roots)
  log('隔离目录', roots.root)
  log('可执行文件', exe)

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
      assert.equal(models.length, 1, `应只有一个隔离模型，实际 ${models.length}`)
      assert.ok(models[0].baseUrl.includes(new URL(PROXY.url).port), '模型没指向本地代理')
      const functionModels = await invoke(page, 'llm:get-function-models')
      assert.equal(functionModels.draft_generation, MODEL.id, '正文生成没指向 Flash')
      return { model: models[0].modelName }
    })

    await step('新建作品', async () => {
      await page.getByRole('button', { name: '新建作品', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await dialog.waitFor({ state: 'visible', timeout: 30_000 })
      await dialog.getByRole('textbox').first().fill(bookName)
      await stubOpenDialog(app, roots.projects, () => dialog.getByRole('button', { name: '选择', exact: true }).click())
      await dialog.getByRole('button', { name: /^(创建项目|创建作品)$/ }).click()
      await dialog.waitFor({ state: 'hidden', timeout: 90_000 })
      await stage.waitForWork(page, bookName, 90_000)
      const session = await sessionOf(app)
      assert.ok(session?.leaseId, '没拿到项目会话')
      report.projectPath = session.projectPath
      return { projectPath: session.projectPath }
    })

    await step('填核心设定', async () => {
      const session = await sessionOf(app)
      const saved = await invoke(page, 'project:update-config', session.projectId, {
        novelConfig: {
          coreOutline: '沿海小城的夜航船每夜多载一名不该上船的乘客。船工周叙要在航次记录被涂改前查出是谁在替死人买票，而他的搭档温珩始终穿着同一件洗得发白的靛蓝短褂。',
          genre: '悬疑', targetAudience: '男频',
          totalChapters: Math.max(CHAPTERS, 8), wordsPerChapter: WORDS, writingLanguage: 'zh-CN',
        },
      }, session.projectPath, session)
      assert.equal(saved.success ?? true, true, JSON.stringify(saved))
      await page.reload()
      await stage.waitForStage(page, 90_000)
      await stage.openFromLibrary(page, bookName)
      return { saved: true }
    })

    await step('生成故事前提/世界观/角色', async () => {
      const session = await sessionOf(app)
      await arch.open(page)
      await arch.primary(page).click()
      await arch.dialog(page).waitFor({ state: 'visible', timeout: 30_000 })
      await arch.selectOnly(page, ['premise', 'worldbuilding', 'characters'])
      await arch.startGenerate(page)
      await runSheet.waitForRunDone(page, GENERATION_TIMEOUT_MS)
      const core = await pollUntilOrStall(page, async () => {
        const value = await invokeSession(page, session, 'db:project-core-get', session.projectPath)
        return value?.premise && value?.worldbuilding && value?.charactersArch ? value : null
      }, { label: '故事前提与世界观', stallMs: 5 * 60_000 })
      return { premiseLength: (core.premise ?? '').length, charactersArchLength: (core.charactersArch ?? '').length }
    })

    await step(`生成整本粗纲（铺满 ${Math.max(CHAPTERS, 8)} 章）`, async () => {
      const session = await sessionOf(app)
      const wanted = Math.max(CHAPTERS, 8)
      const arcSection = arch.section(page, 'arc')
      await arcSection.getByRole('button', { name: '一键生成全部粗纲' }).click()
      const arcs = await pollUntilOrStall(page, async () => {
        const list = await invokeSession(page, session, 'db:arc-outline-list', session.projectPath)
        const covered = (list ?? []).reduce((max, item) => Math.max(max, item.toChapter), 0)
        return covered >= wanted ? list : null
      }, { timeoutMs: ARC_TIMEOUT_MS, intervalMs: 5000, label: '粗纲铺满全书', stallMs: 5 * 60_000 })
      return { segments: arcs.length, coveredTo: arcs.at(-1)?.toChapter }
    })

    await step(`生成细纲 1–${CHAPTERS}`, async () => {
      const session = await sessionOf(app)
      await arch.page(page).getByRole('button', { name: '继续生成架构' }).click()
      await arch.selectOnly(page, ['synopsis'])
      await arch.setRange(page, 1, CHAPTERS)
      await arch.startGenerate(page)
      const core = await pollUntilOrStall(page, async () => {
        const value = await invokeSession(page, session, 'db:project-core-get', session.projectPath)
        return value?.synopsis?.includes(`第${CHAPTERS}章`) ? value : null
      }, { label: `细纲 1–${CHAPTERS}`, stallMs: 5 * 60_000 })
      const blocks = [...(core.synopsis.matchAll(/^## 第(\d+)章/gmu))].map(m => Number(m[1]))
      return { synopsisLength: core.synopsis.length, chapters: blocks }
    })

    await step(`生成蓝图 1–${CHAPTERS}`, async () => {
      const session = await sessionOf(app)
      await blueprintPage.open(page)
      await page.locator('.stage-capsule[aria-expanded="true"]').click().catch(() => {})
      await blueprintPage.generateRange(page, 1, CHAPTERS)
      await runSheet.waitForRunDone(page, GENERATION_TIMEOUT_MS)
      const blueprints = await pollUntilOrStall(page, async () => {
        const list = await invokeSession(page, session, 'db:blueprint-get-all', session.projectPath)
        const got = (list ?? []).filter(item => item.chapterNumber <= CHAPTERS)
        return got.length >= CHAPTERS ? got : null
      }, { label: '蓝图落库', stallMs: 5 * 60_000 })
      return { chapters: blueprints.map(item => item.chapterNumber) }
    })

    // 逐章写正文：模拟用户一章一章写，比批量更好定位哪一章出问题。
    for (let chapter = 1; chapter <= CHAPTERS; chapter += 1) {
      await step(`写第 ${chapter} 章正文`, async () => {
        const session = await sessionOf(app)
        await stage.stageButton(page, '蓝图').click()
        await blueprintPage.plan(page).waitFor({ state: 'visible', timeout: 60_000 })
        await page.locator('.stage-capsule[aria-expanded="true"]').click().catch(() => {})
        await blueprintPage.writeNext(page)
        await runSheet.waitForRunDone(page, GENERATION_TIMEOUT_MS)
        const draft = await pollUntilOrStall(page, async () => {
          const list = await invokeSession(page, session, 'db:draft-list', chapter, session.projectPath)
          const latest = (list ?? []).at(-1)
          return latest && latest.wordCount > 200 ? latest : null
        }, { label: `第 ${chapter} 章草稿`, stallMs: 6 * 60_000 })
        return { draftId: draft.id, version: draft.version, words: draft.wordCount }
      })
    }

    await step('事件账本与角色状态（连续性抽取）', async () => {
      const session = await sessionOf(app)
      const continuity = await invokeSession(page, session, 'db:continuity-list-before', CHAPTERS + 1, session.projectPath)
      const characters = await invokeSession(page, session, 'db:character-get-all', session.projectPath)
      // currentState 存在与否由列表是否为 NULL 决定，字段挂在 currentState 下。
      const updated = (characters ?? []).filter(item => typeof item.currentState?.updatedAtChapter === 'number')
      return {
        continuityEntries: (continuity ?? []).length,
        characters: (characters ?? []).length,
        withState: updated.length,
        missingAppearance: (characters ?? []).filter(item => !String(item.appearance ?? '').trim()).map(item => item.name),
      }
    })

    await step(`审稿并定稿第 1 章`, async () => {
      const session = await sessionOf(app)
      await chapterView.open(page, 1)
      await chapterView.review(page)
      await runSheet.waitForRunDone(page, GENERATION_TIMEOUT_MS)
      const review = await page.evaluate(() => {
        const sheet = document.querySelector('.stage-ch-sheet, [aria-label="审稿报告"]')
        return sheet ? sheet.textContent?.slice(0, 1500) ?? '' : ''
      })
      await chapterView.finalize(page, 1)
      const finalized = await pollUntilOrStall(page, async () => {
        const list = await invokeSession(page, session, 'db:draft-list', 1, session.projectPath)
        return (list ?? []).some(item => item.status === 'finalized') ? list : null
      }, { label: '第 1 章定稿' })
      return { reviewExcerpt: review.slice(0, 600), drafts: finalized.map(item => ({ v: item.version, s: item.status })) }
    })
  } finally {
    report.finalScreen = await page.evaluate(() => document.body.innerText.slice(0, 2000)).catch(() => null)
    await app.close().catch(() => {})
  }
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