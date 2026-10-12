// RD-6 架构阶段与角色名单的实机场景：对应计划 RD-6 的 live lane 1～10、perf 的 arch-timing 与评审视频。
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

import * as arch from './pages/architecture.mjs'
import * as materials from './pages/materials.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

const root = page => stage.root(page)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const sha = text => createHash('sha256').update(text ?? '').digest('hex').slice(0, 16)

/** 记下界面最近一次打开作品拿到的会话（包一层主进程的 project:open），驱动读库时不必重开作品打断界面。 */
async function trackOpenedSession(app) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    const original = handlers.get('project:open')
    handlers.set('project:open', async (event, projectPath, ...rest) => {
      const result = await original(event, projectPath, ...rest)
      if (result?.success) globalThis.__driveOpened = { projectId: result.project.id, projectPath, leaseId: result.project.sessionLease }
      return result
    })
  })
}

async function uiSession(app) {
  const session = await app.evaluate(() => globalThis.__driveOpened)
  assert.ok(session?.leaseId, '记下了界面打开作品的会话')
  return session
}

async function readCore({ app, page, invoke }) {
  const session = await uiSession(app)
  return invoke(page, 'db:project-core-get', session.projectPath, session)
}

async function readRoster({ app, page, invoke }) {
  const session = await uiSession(app)
  return invoke(page, 'db:character-roster-read', session.projectPath, session)
}

/** 在预置的林岚之外再加几位角色（名单提交要带当前修订号）。 */
async function addCharacters({ page, invoke, path, session }, names) {
  const roster = await invoke(page, 'db:character-roster-read', path, session)
  const blank = { gender: '', age: '', appearance: '', personality: '', abilities: '', motivation: '', relationships: [], arc: '', notes: '' }
  const added = names.map((name, index) => ({ ...blank, characterId: `draft:${randomUUID()}`, name, role: index % 3 === 0 ? 'antagonist' : 'supporting',
    background: `${name}在旧港住了很多年。` }))
  const committed = await invoke(page, 'db:character-roster-commit', { operationId: randomUUID(), expectedRevision: roster.revision,
    expectedIdentityRevision: roster.identityRevision, schemaVersion: 1, intent: 'manual_edit', entries: [...roster.entries, ...added] }, path, session)
  assert.equal(committed.success, true, committed.error)
}

/**
 * 示例作品「灯塔」，按 clear 清空架构的几节；不等落到第 3 章（架构没齐时落点就是架构）。
 * 会话追踪先挂上，界面重载后打开作品的那次会话就能拿来读库。
 */
function seedArch({ clear = [], totalChapters, characters = [] } = {}) {
  return async context => {
    await trackOpenedSession(context.app)
    await seedStageSample(context, { totalChapters, landOnChapter3: clear.length === 0, beforeReload: async ({ page, invoke, path, session }) => {
      if (clear.length > 0) {
        const cleared = await invoke(page, 'db:project-core-update', Object.fromEntries(clear.map(key => [key, ''])), path, session)
        assert.equal(cleared.success, true, cleared.error)
      }
      if (characters.length > 0) await addCharacters({ page, invoke, path, session }, characters)
    } })
    if (clear.length > 0) await architectureSurface(context.page).waitFor({ state: 'visible', timeout: 20_000 })
  }
}

/** 架构没齐时打开作品会落到架构：head 是架构阶段，trunk 是旧的故事架构总览。 */
const architectureSurface = page => page.locator('.arch-page').or(page.getByRole('button', { name: 'AI 生成架构' })).first()

async function openArchitecture(page) {
  if (await arch.page(page).count() === 0) await arch.open(page)
  else await arch.waitReady(page)
}

/** RD-4 的运行侧页在工作流开始后自动打开；trunk 的旧运行面板没有「进行中」分页，调用方改为轮询数据库里的结果。 */
async function waitForRunDone(page, timeout = 120_000) {
  const opened = await runSheet.tab(page, '进行中').waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)
  if (opened) await runSheet.waitForRunDone(page, timeout)
}

async function badges(page) {
  const result = {}
  for (const key of Object.keys(arch.SECTION_NAMES)) result[key] = await arch.badge(page, key).innerText()
  return result
}

/** 情节大纲里每一章的二级标题块，按章号取。 */
function outlineChapters(synopsis) {
  const blocks = {}
  for (const match of synopsis.matchAll(/^## 第(\d+)章：[^\n]*\n[^\n#>]*/gmu)) {
    const number = Number(match[1])
    assert.equal(blocks[number], undefined, `第 ${number} 章出现了两次`)
    blocks[number] = match[0].trim()
  }
  return blocks
}

/**
 * 对比用的文字对比度：名称与正文类至少 4.5:1，说明类至少 3:1，底色沿祖先叠加求出。
 * 另核对卡片、提示条与对话框的底色都来自纸墨令牌（计算值与令牌的计算值相同）。
 */
async function archContrastFailures(page) {
  return page.evaluate(() => {
    const parse = value => {
      const numbers = value.match(/[\d.]+/g).map(Number)
      const [r, g, b] = value.startsWith('color(') ? numbers.slice(0, 3).map(channel => channel * 255) : numbers.slice(0, 3)
      return { r, g, b, a: numbers[3] ?? 1 }
    }
    const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a), a: 1 })
    const backdrop = element => {
      const layers = []
      for (let node = element; node; node = node.parentElement) {
        const color = parse(getComputedStyle(node).backgroundColor)
        if (color.a > 0) layers.push(color)
        if (color.a === 1) break
      }
      return layers.reverse().reduce((bottom, top) => over(top, bottom), { r: 255, g: 255, b: 255, a: 1 })
    }
    const luminance = ({ r, g, b }) => [r, g, b].map(value => value / 255)
      .map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
    const ratio = (a, b) => {
      const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (high + 0.05) / (low + 0.05)
    }
    const checks = [['.arch-title', 4.5], ['.arch-section-title', 4.5], ['.arch-section-summary', 4.5], ['.arch-lede', 4.5],
      ['.arch-eyebrow', 3], ['.arch-badge', 3], ['.arch-section-num', 3], ['.pi-notice-title', 4.5], ['.pi-notice-text', 4.5]]
    const contrast = checks.flatMap(([selector, minimum]) => [...document.querySelectorAll(`[data-shell-presentation="stage"] ${selector}`)].map(element => {
      const value = ratio(parse(getComputedStyle(element).color), backdrop(element))
      return { selector, text: element.textContent.slice(0, 30), ratio: Math.round(value * 100) / 100, minimum }
    }).filter(result => result.ratio < result.minimum))
    const shell = document.querySelector('[data-shell-presentation="stage"]')
    const probe = document.createElement('span')
    shell.append(probe)
    const token = name => { probe.style.backgroundColor = `var(${name})`; return getComputedStyle(probe).backgroundColor }
    const paper = token('--paper')
    probe.remove()
    const surfaces = [...document.querySelectorAll('.arch-section')].map(element => getComputedStyle(element).backgroundColor)
      .filter(color => color !== paper).map(color => ({ selector: '.arch-section', color, expected: paper }))
    return [...contrast, ...surfaces]
  })
}

export const ARCH_SCENARIOS = {
  /** lane 1：trunk 与 head 都从架构页用夹具模型生成前提、世界观与大纲（角色名单已预置），记下四份文档。 */
  'arch-regression': { model: true, shell: 'stage', setup: seedArch({ clear: ['premise', 'worldbuilding', 'synopsis'] }), run: async context => {
    const { page } = context
    const head = await page.locator('.arch-page').count() > 0
    if (head) {
      await arch.waitReady(page)
      assert.equal(await arch.primary(page).innerText(), '继续生成架构')
      await arch.primary(page).click()
      await arch.startGenerate(page)
    } else {
      await page.getByRole('button', { name: 'AI 生成架构' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('button', { name: '确认生成（3/4）' }).click()
      await dialog.waitFor({ state: 'hidden' })
    }
    await waitForRunDone(page)
    let core
    for (let attempt = 0; attempt < 240; attempt++) {
      core = await readCore(context)
      if (core?.premise && core?.worldbuilding && core?.synopsis?.includes('第5章')) break
      await pause(500)
    }
    const documents = { premise: core.premise, characters: core.charactersArch, worldbuilding: core.worldbuilding, synopsis: core.synopsis }
    for (const [key, value] of Object.entries(documents)) assert.ok(value?.trim(), `${key} 有内容`)
    if (head) await arch.waitReady(page)
    return { surface: head ? 'head 架构阶段' : 'trunk 故事架构', hashes: Object.fromEntries(Object.entries(documents).map(([key, value]) => [key, sha(value)])), documents }
  } },

  /** lane 2：两节已确认时主按钮是继续生成架构。 */
  'arch-partial': { model: false, shell: 'stage', setup: seedArch({ clear: ['worldbuilding', 'synopsis'] }), run: async ({ page }) => {
    await openArchitecture(page)
    assert.equal(await arch.primary(page).count(), 1, '架构页只有一个主按钮')
    assert.equal(await arch.primary(page).innerText(), '继续生成架构')
    assert.deepEqual(await badges(page), { premise: '已确认', characters: '已确认', worldbuilding: '待生成', synopsis: '待生成' })
    assert.match(await stage.stageButton(page, '架构').innerText(), /2 \/ 4/, '流程脊与页面同为 2 / 4')
    assert.equal(await arch.summary(page, 'characters').innerText(), '1 位角色：林岚')
  } },

  /** lane 3：四节都已确认时主按钮是下一步章节蓝图；after 点它进入蓝图。 */
  'arch-done': { model: false, shell: 'stage', setup: seedArch(), run: async ({ page }) => {
    await openArchitecture(page)
    assert.equal(await arch.primary(page).innerText(), '下一步：章节蓝图')
    assert.deepEqual(Object.values(await badges(page)), ['已确认', '已确认', '已确认', '已确认'])
  }, after: async ({ page }) => {
    await arch.primary(page).click()
    await stage.tab(page, '蓝图').waitFor({ state: 'visible' })
  } },

  /** lane 4：生成架构对话框里，已确认的节勾选为将覆盖、不勾为保留，没有内容的为新生成。 */
  'arch-confirm': { model: false, shell: 'stage', setup: seedArch({ clear: ['worldbuilding', 'synopsis'] }), run: async ({ page }) => {
    await openArchitecture(page)
    await arch.primary(page).click()
    await arch.dialog(page).waitFor({ state: 'visible' })
    await arch.stepCheck(page, 'premise').click()
    const marks = {}
    for (const key of Object.keys(arch.SECTION_NAMES)) marks[key] = await arch.mark(page, key).innerText()
    assert.deepEqual(marks, { premise: '将覆盖', characters: '保留', worldbuilding: '新生成', synopsis: '新生成' })
    assert.equal(await arch.dialog(page).locator('.pi-btn--primary').innerText(), '开始生成 3 项')
  }, after: async ({ page }) => {
    await arch.dialog(page).getByRole('button', { name: '取消' }).click()
    await arch.dialog(page).waitFor({ state: 'hidden' })
  } },

  /** lane 5：大纲先生成 1～10 章，再从提示条续写到 16 章；停在第 17～24 章的续写对话框，after 生成并核对只追加了缺少的章。 */
  'arch-resume': { model: true, shell: 'stage', setup: seedArch({ clear: ['synopsis'], totalChapters: 24 }), run: async context => {
    const { page } = context
    await openArchitecture(page)
    await arch.primary(page).click()
    await arch.selectOnly(page, ['synopsis'])
    await arch.setRange(page, 1, 10)
    await arch.startGenerate(page)
    await waitForRunDone(page)
    await arch.badge(page, 'synopsis').filter({ hasText: '部分完成 · 10 / 24 章' }).waitFor({ timeout: 30_000 })
    await arch.section(page, 'synopsis').getByRole('button', { name: '续写第 11 章起' }).click()
    assert.equal(await arch.dialog(page).getByRole('spinbutton', { name: '本次生成范围的起始章' }).inputValue(), '11')
    await arch.setRange(page, 11, 16)
    await arch.startGenerate(page)
    await waitForRunDone(page)
    await arch.badge(page, 'synopsis').filter({ hasText: '部分完成 · 16 / 24 章' }).waitFor({ timeout: 30_000 })
    const outline = arch.section(page, 'synopsis')
    assert.match(await outline.innerText(), /第 17～24 章还没有大纲/)
    assert.match(await outline.innerText(), /续写只追加缺少的章节/)
    context.before16 = (await readCore(context)).synopsis
    assert.deepEqual(Object.keys(outlineChapters(context.before16)).map(Number), Array.from({ length: 16 }, (_, index) => index + 1))
    await outline.getByRole('button', { name: '续写第 17 章起' }).click()
    assert.equal(await arch.dialog(page).getByRole('spinbutton', { name: '本次生成范围的起始章' }).inputValue(), '17')
    await arch.setRange(page, 17, 24)
    return { coveredBefore: 16 }
  }, after: async context => {
    const { page } = context
    await arch.startGenerate(page)
    await waitForRunDone(page)
    await arch.badge(page, 'synopsis').filter({ hasText: '已确认' }).waitFor({ timeout: 30_000 })
    const before = outlineChapters(context.before16)
    const after = outlineChapters((await readCore(context)).synopsis)
    assert.deepEqual(Object.keys(after).map(Number), Array.from({ length: 24 }, (_, index) => index + 1), '续写后 1～24 章各一次')
    for (let number = 1; number <= 16; number++) assert.equal(after[number], before[number], `第 ${number} 章没有被改动`)
  } },

  /** lane 6：清空此节出现危险确认；after 取消，界面与数据库里的世界观都没变。 */
  'arch-clear': { model: false, shell: 'stage', setup: seedArch(), run: async context => {
    const { page } = context
    await openArchitecture(page)
    context.worldSummary = await arch.summary(page, 'worldbuilding').innerText()
    await arch.openSectionMenu(page, 'worldbuilding')
    await page.getByRole('menuitem', { name: '清空此节…' }).click()
    const confirm = page.getByRole('dialog', { name: '清空「世界观」？' })
    await confirm.waitFor({ state: 'visible' })
    assert.match(await confirm.innerText(), /无法撤销/)
    assert.equal(await confirm.locator('.pi-btn--danger-solid').innerText(), '清空此节')
  }, after: async context => {
    const { page } = context
    await page.getByRole('dialog', { name: '清空「世界观」？' }).getByRole('button', { name: '取消' }).click()
    await page.getByRole('dialog', { name: '清空「世界观」？' }).waitFor({ state: 'hidden' })
    assert.equal(await arch.summary(page, 'worldbuilding').innerText(), context.worldSummary)
    assert.equal(await arch.badge(page, 'worldbuilding').innerText(), '已确认')
    assert.equal((await readCore(context)).worldbuilding, STAGE_SAMPLE.core.worldbuilding, '取消后世界观没有写入')
  } },

  /** lane 7：在角色名单里新建「守塔人」并按 Ctrl S 保存：名单、角色图谱投影（名单全文）与架构页的角色名单一节同步。 */
  'arch-cast-save': { model: false, shell: 'stage', setup: seedArch(), run: async context => {
    const { page } = context
    await openArchitecture(page)
    await arch.openCast(page)
    await arch.castRoster(page).getByRole('button', { name: '新建角色' }).click()
    const name = page.getByLabel('姓名', { exact: true })
    await name.fill('守塔人')
    await page.getByLabel('动机', { exact: true }).fill('守住雾钟，等一个三十年前没回来的人。')
    await root(page).locator('.cast-save-state').filter({ hasText: '未保存' }).waitFor()
    await page.keyboard.press('Control+S')
    await root(page).locator('.cast-save-state').filter({ hasText: '已保存' }).waitFor({ timeout: 20_000 })
    assert.deepEqual(await arch.castRoster(page).locator('.cast-row-name').allInnerTexts(), ['林岚', '守塔人'])
    const roster = await readRoster(context)
    assert.equal(roster.status, 'ready')
    assert.match(roster.renderedMarkdown, /守塔人/, '角色图谱投影里有守塔人')
    await stage.tab(page, '架构').click()
    await arch.waitReady(page)
    assert.match(await arch.summary(page, 'characters').innerText(), /2 位角色：林岚、守塔人/)
    await arch.openSectionMenu(page, 'characters')
    await page.getByRole('menuitem', { name: '查看名单全文' }).click()
    await stage.prose(page).getByText('守塔人').first().waitFor({ state: 'visible' })
    await stage.tab(page, '角色名单').click()
    await arch.castRoster(page).waitFor({ state: 'visible' })
  } },

  /** lane 8：关系图谱可缩放、可拖拽，点节点打开档案。 */
  'arch-graph': { model: false, shell: 'stage', setup: seedArch({ characters: ['守塔人', '沈砚', '何婆婆'] }), run: async context => {
    const { page } = context
    await openArchitecture(page)
    await arch.openCast(page)
    await root(page).getByRole('button', { name: '关系图谱', exact: true }).click()
    const canvas = root(page).locator('.cast-graph canvas')
    await canvas.waitFor({ state: 'visible' })
    const zoom = root(page).locator('.cast-graph').getByText(/^\d+%$/)
    const before = await zoom.innerText()
    await root(page).getByRole('button', { name: '放大关系图谱' }).click()
    assert.notEqual(await zoom.innerText(), before, '放大后缩放比例变化')
    const box = await canvas.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -200)
    const image = () => canvas.evaluate(element => element.toDataURL())
    const beforeDrag = await image()
    await page.mouse.move(box.x + 40, box.y + box.height - 40)
    await page.mouse.down()
    await page.mouse.move(box.x + 140, box.y + box.height - 100, { steps: 8 })
    await page.mouse.up()
    assert.notEqual(await image(), beforeDrag, '拖拽后图谱画面移动')
    await root(page).getByRole('button', { name: '适合视图' }).click()
    context.canvasBox = await canvas.boundingBox()
  }, after: async context => {
    const { page } = context
    await root(page).getByRole('button', { name: '重置图谱布局' }).click()
    const box = context.canvasBox
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await root(page).getByRole('button', { name: '基础设定', pressed: true }).waitFor({ timeout: 5000 })
    assert.ok(['林岚', '守塔人', '沈砚', '何婆婆'].includes(await arch.profileName(page).innerText()), '点中心节点打开了档案')
  } },

  /** lane 9：从角色名单导入两张角色卡，在运行侧页确认后守塔人出现在名单、林岚仍只有一个。 */
  'arch-cards': { model: true, shell: 'stage', setup: seedArch(), run: async ({ page, fake }) => {
    fake.replyCharacterCards()
    await openArchitecture(page)
    await arch.openCast(page)
    await materials.importCharacterCards(page, '姓名：守塔人\n身份：灯塔看守，记得每一次钟声。\n\n姓名：林岚\n身份：旧港潮汐记录的测绘师。')
    await runSheet.waitUntilOpen(page)
    const waiting = runSheet.anyCard(page).filter({ hasText: '等你确认' })
    await waiting.getByRole('button', { name: '按当前选择确认', disabled: false }).waitFor({ state: 'visible', timeout: 60_000 })
    const keeper = waiting.getByRole('combobox', { name: /^采用方式：守塔人/ })
    const lin = waiting.getByRole('combobox', { name: /^采用方式：林岚/ })
    await lin.selectOption(await lin.locator('option').filter({ hasText: /^林岚 ·/ }).getAttribute('value'))
    await keeper.selectOption('create')
    await waiting.getByRole('button', { name: '按当前选择确认' }).click()
    await runSheet.waitForRunDone(page)
    await arch.castRow(page, '守塔人').waitFor({ state: 'visible', timeout: 20_000 })
    assert.equal(await arch.castRoster(page).locator('.cast-row-name').filter({ hasText: /^林岚$/ }).count(), 1, '林岚对应已有角色，没有多出一个')
  } },

  /** lane 10：深色主题下的架构页（含一条大纲提示条）：文字对比度达标，卡片底色来自纸墨令牌。用 --theme dark 跑。 */
  'arch-dark': { model: false, shell: 'stage', setup: seedArch({ clear: ['worldbuilding'] }), run: async ({ page }) => {
    await openArchitecture(page)
    assert.deepEqual(await archContrastFailures(page), [], '对比度不足或底色不是令牌')
    return { theme: await stage.root(page).getAttribute('data-theme') }
  } },

  /**
   * perf：从点流程脊「架构」到四节可交互的毫秒数（trunk 是旧故事架构标签，head 是架构阶段），
   * 以及 200 位角色时角色列表滚动的帧率（两边都是第 1 页 50 位）。两边都用新外壳跑。
   */
  'arch-timing': { model: false, shell: 'stage', setup: seedArch({ characters: Array.from({ length: 199 }, (_, index) => `角色${String(index + 2).padStart(3, '0')}`) }), run: async ({ page }) => {
    const target = stage.stageButton(page, '架构')
    const handle = await target.elementHandle()
    await page.evaluate(element => {
      let clickedAt = null
      element.addEventListener('click', () => { clickedAt ??= performance.now() }, { capture: true, once: true })
      window.__driveArchReady = new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('架构四节 20 秒内未就绪')), 20_000)
        const ready = () => {
          const content = document.querySelector('.stage-content')
          if (!content) return false
          if (content.querySelector('.arch-page')) return content.querySelectorAll('.arch-section').length === 4 && !content.querySelector('.arch-page[data-loading]')
          return /4\/4\s*已生成/.test(content.textContent ?? '') && !content.querySelector('.animate-spin')
        }
        const tick = () => {
          if (clickedAt !== null && ready()) { clearTimeout(deadline); resolve(Math.round(performance.now() - clickedAt)) } else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
    }, handle)
    await target.click()
    const openMs = await page.evaluate(() => window.__driveArchReady)

    await page.keyboard.press('Control+K')
    await stage.paletteInput(page).fill('角色')
    await stage.palette(page).getByRole('option', { name: /^角色/ }).first().click()
    const list = page.locator('.cast-list, .stage-characters-list .overflow-y-auto').first()
    await list.waitFor({ state: 'visible' })
    await page.waitForFunction(() => document.querySelectorAll('.cast-row, .stage-characters-list [data-character-id], .stage-characters-list [role="button"]').length >= 50)
    const box = await list.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.evaluate(() => {
      window.__driveFrames = []
      const tick = time => { window.__driveFrames.push(time); if (window.__driveFrames.length < 10_000) window.__driveFramesId = requestAnimationFrame(tick) }
      window.__driveFramesId = requestAnimationFrame(tick)
    })
    for (let step = 0; step < 30; step++) {
      await page.mouse.wheel(0, step < 15 ? 120 : -120)
      await pause(33)
    }
    const frames = await page.evaluate(() => { cancelAnimationFrame(window.__driveFramesId); return window.__driveFrames })
    const seconds = (frames.at(-1) - frames[0]) / 1000
    const rows = await page.locator('.cast-row, .stage-characters-list [data-character-id]').count()
    return { surface: await page.locator('.arch-page, .cast-page').count() > 0 ? 'head' : 'trunk', openMs, scrollFps: Math.round((frames.length - 1) / seconds * 10) / 10, rowsOnPage: rows }
  } },

  /** 评审视频：架构四节与主按钮、生成对话框的覆盖与保留、大纲提示条、清空此节的危险确认、角色名单保存与关系图谱。配 --video。 */
  'arch-tour': { model: false, shell: 'stage', setup: seedArch({ clear: ['worldbuilding'], characters: ['守塔人', '沈砚'] }), run: async ({ page }) => {
    await openArchitecture(page)
    await pause(7000)
    await arch.primary(page).click()
    await arch.dialog(page).waitFor({ state: 'visible' })
    await pause(1500)
    await arch.stepCheck(page, 'premise').click()
    await pause(2000)
    await arch.dialog(page).getByRole('button', { name: '取消' }).click()
    await pause(1000)
    await arch.openSectionMenu(page, 'premise')
    await pause(1000)
    await page.getByRole('menuitem', { name: '清空此节…' }).click()
    await pause(2500)
    await page.getByRole('dialog', { name: '清空「故事前提」？' }).getByRole('button', { name: '取消' }).click()
    await pause(1200)
    await arch.openCast(page)
    await pause(2000)
    await arch.castRow(page, '沈砚').click()
    await pause(1200)
    await page.getByLabel('动机', { exact: true }).fill('替母亲把那封信送到。')
    await pause(1000)
    await root(page).getByRole('button', { name: '保存角色' }).click()
    await root(page).locator('.cast-save-state').filter({ hasText: '已保存' }).waitFor({ timeout: 20_000 })
    await pause(1500)
    await root(page).getByRole('button', { name: '关系图谱', exact: true }).click()
    await pause(3500)
    await root(page).getByRole('button', { name: '放大关系图谱' }).click()
    await pause(800)
    await root(page).getByRole('button', { name: '放大关系图谱' }).click()
    await pause(1500)
    await root(page).getByRole('button', { name: '基础设定', exact: true }).click()
    await pause(1200)
    await stage.tab(page, '架构').click()
    await pause(5000)
  } },
}

