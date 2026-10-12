// RD-7 蓝图阶段与写作此章弹层的实机场景：对应计划 RD-7 的 live lane 1～10、perf 的 blueprint-timing 与评审导览。
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

import { FAKE_MODEL, FIXTURE_PROSE } from './fake-model.mjs'
import * as blueprint from './pages/blueprint.mjs'
import * as chapter from './pages/chapter.mjs'
import * as project from './pages/project.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { firstLine, seedStageSample, untilGateHolds } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

/** 示例作品的下一章：1、2 章定稿，权威下一章是 3。 */
const NEXT = 3

/**
 * 文字与它实际落在的底色之间的对比度，底色沿祖先逐层叠加半透明背景求出。
 * checks 是 [选择器, 最低比值]：名称与正文 4.5，说明文字 3。
 */
function contrastFailures(page, checks) {
  return page.evaluate(checks => {
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
    return checks.flatMap(([selector, minimum]) => [...document.querySelectorAll(selector)].map(element => {
      const value = ratio(parse(getComputedStyle(element).color), backdrop(element))
      return { selector, text: element.textContent?.slice(0, 20), ratio: Math.round(value * 100) / 100, minimum }
    }).filter(result => result.ratio < result.minimum))
  }, checks)
}

const PAGE_CONTRAST = [
  ['.stage-bp-h1', 4.5], ['.stage-bp-plan-name', 4.5], ['.stage-bp-title', 4.5], ['.stage-bp-ctl', 4.5], ['.stage-bp-person', 4.5],
  ['.stage-bp-field > label', 4.5], ['.stage-bp-eyebrow', 3], ['.stage-bp-plan-no', 3], ['.stage-bp-plan-top', 3],
  ['.stage-bp-plan-status[data-next]', 3], ['.stage-bp-plan-status[data-status="final"]', 3], ['.stage-bp-card-status', 3],
  ['.stage-bp-field > label em', 3], ['.stage-bp-role select', 4.5], ['.stage-write .pi-btn', 4.5],
]

/** 第 3 章的出场人物加上守塔人：一致性预检的线索要落在本章蓝图里的人物上。 */
const withKeeperInChapter3 = context => seedStageSample(context, { beforeReload: async ({ page, invoke, path, session }) => {
  assert.equal((await invoke(page, 'db:blueprint-upsert', { chapterNumber: 3, title: STAGE_SAMPLE.titles[2], role: '发展',
    purpose: '推进灯塔与沉船的线索', keyEvents: '林岚在灯塔里找到新的线索', characters: ['林岚', '守塔人'],
    userGuidance: '前半章只写钟声，不写人脸。' }, path, session)).success, true)
} })

/** 主进程里改写 db:continuity-list-before：第 1 章定稿里守塔人已死，作为一致性预检的夹具。保存安排等其余通道照常走真实处理。 */
async function injectDeadKeeper(app) {
  const wrapped = await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    if (!(handlers instanceof Map) || !handlers.has('db:continuity-list-before')) return false
    handlers.set('db:continuity-list-before', () => [{
      draftId: 1, chapterNumber: 1, chapterTitle: '旧港', chapterNotes: '守塔人死于第一章的风暴。',
      source: { draftId: 1, finalizationId: 'drive-fixture', chapterNumber: 1, contentHash: 'a'.repeat(64) },
      sourceStatus: 'current',
      facts: [{ category: 'character-state', entities: ['守塔人'], statement: '守塔人已经死亡。', sourceChapter: 1, evidence: '守塔人在风暴里没有再回来。' }],
    }])
    return true
  })
  assert.ok(wrapped, '能在主进程里替换连续性事实的读取')
}

/** 两种外壳各自从蓝图写下一章：旧外壳点「写作第 3 章」后在对话框里直接开始，不改任何字段。 */
async function writeNextEitherShell(page) {
  if (await stage.root(page).count() > 0) {
    await blueprint.open(page)
    await blueprint.writeNext(page)
    return
  }
  await project.openNode(page, '章节蓝图')
  await page.getByRole('button', { name: /^写作第\d+章$/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: '开始创作' }).click()
}

async function proseRequest(fake, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (!fake.chats.some(chat => chat.kind === 'prose')) {
    assert.ok(Date.now() < deadline, `${timeoutMs} ms 内假模型没有收到写正文的请求`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return fake.chats
}

/** 在渲染进程里计时：点击 target 到 ready 选择器出现，单位毫秒，帧粒度。 */
async function msFromClick(page, target, readySelector, readyText) {
  const handle = await target.elementHandle()
  await page.evaluate(({ element, readySelector, readyText }) => {
    let clickedAt = null
    element.addEventListener('click', () => { clickedAt ??= performance.now() }, { capture: true, once: true })
    window.__driveReady = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('20 秒内没有出现')), 20_000)
      const tick = () => {
        const shown = [...document.querySelectorAll(readySelector)].some(node =>
          (readyText === null || (node.value ?? node.textContent).includes(readyText)) && node.getClientRects().length > 0)
        if (clickedAt !== null && shown) {
          clearTimeout(deadline)
          resolve(Math.round(performance.now() - clickedAt))
        } else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, { element: handle, readySelector, readyText })
  await target.click()
  return page.evaluate(() => window.__driveReady)
}

const TIMING_CHAPTERS = 300

/** 300 章蓝图：示例作品的 12 章之外再补到 300 章，标题带章号便于定位。 */
const withManyBlueprints = context => seedStageSample(context, { totalChapters: TIMING_CHAPTERS, beforeReload: async ({ page, invoke, path, session }) => {
  const blueprints = Array.from({ length: TIMING_CHAPTERS - STAGE_SAMPLE.titles.length }, (_, index) => {
    const chapterNumber = STAGE_SAMPLE.titles.length + index + 1
    return { chapterNumber, title: `远航之${chapterNumber}`, role: '发展', purpose: '推进灯塔与沉船的线索',
      keyEvents: '林岚在灯塔里找到新的线索', characters: ['林岚'], suspenseHook: '', userGuidance: '', notes: '' }
  })
  assert.equal((await invoke(page, 'db:blueprint-upsert-many', blueprints, path, session)).success, true)
} })

export const BLUEPRINT_SCENARIOS = {
  'blueprint-regression': { model: true, setup: seedStageSample, run: async ({ page, fake }) => {
    await writeNextEitherShell(page)
    const chats = await proseRequest(fake)
    const prose = chats.find(chat => chat.kind === 'prose')
    const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    if (await stage.root(page).count() > 0) await stage.waitForProse(page, firstLine(FIXTURE_PROSE))
    else await chapter.editor(page).getByText(firstLine(FIXTURE_PROSE)).first().waitFor({ state: 'visible', timeout: 60_000 })
    return {
      shell: await stage.root(page).count() > 0 ? 'stage' : 'writer',
      requests: chats.map(chat => ({ kind: chat.kind, model: chat.model, sha256: digest(chat.messages) })),
      proseModel: prose.model,
      proseMessages: prose.messages,
    }
  } },

  'blueprint-page': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await blueprint.open(page)
    await blueprint.planItem(page, 5).click()
    await blueprint.titleInput(page).waitFor({ state: 'visible' })
    assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), '逐章规划')
    assert.equal(await blueprint.writeButton(page).innerText(), `写第 ${NEXT} 章`)
    assert.equal(await blueprint.plan(page).getByRole('listitem').count(), STAGE_SAMPLE.titles.length)
    assert.equal(await blueprint.titleInput(page).inputValue(), STAGE_SAMPLE.titles[4])
    const primaries = await stage.root(page).locator('.stage-bp-head .pi-btn--primary').count()
    assert.equal(primaries, 2, '页头只有写下一章这一个拆分主按钮（主按钮与箭头）')
    assert.deepEqual(await contrastFailures(page, PAGE_CONTRAST), [], '蓝图页文字对比度不足')
  } },

  'blueprint-popover': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await blueprint.open(page)
    await blueprint.openWriteOptions(page)
    const popover = blueprint.popover(page)
    assert.deepEqual(await popover.locator('label').allTextContents(), ['本次模型 只用于这一次', '作者微操指导 可选', '知识库检索关键词 可选'])
    assert.equal(await popover.locator('details').evaluate(node => node.open), false, '检索关键词收在折叠的「更多」里')
    assert.equal(await page.getByRole('dialog').count(), 1, '只有一个小弹层，没有大表单')
    assert.match(await popover.getByRole('combobox').inputValue(), new RegExp(FAKE_MODEL.id))
  } },

  'blueprint-preflight': { model: true, shell: 'stage', setup: withKeeperInChapter3, run: async ({ app, page, fake }) => {
    await injectDeadKeeper(app)
    await blueprint.open(page)
    await blueprint.writeNext(page)
    await blueprint.preflight(page).waitFor({ state: 'visible' })
    await blueprint.popover(page).getByText(/“守塔人”处于死亡终态/).waitFor({ state: 'visible' })
    assert.equal(fake.chats.length, 0, '有提醒时不开始写')
    for (const name of ['保存安排', '仅本次忽略', '改蓝图后重检']) await blueprint.preflight(page).getByRole('button', { name }).waitFor({ state: 'visible' })
  }, after: async ({ page, fake }) => {
    await blueprint.preflight(page).getByRole('button', { name: '仅本次忽略' }).click()
    await runSheet.waitUntilOpen(page)
    await proseRequest(fake)
    await runSheet.waitForRunDone(page)
  } },

  'blueprint-clear': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await blueprint.open(page)
    await blueprint.pageMenu(page, '清空全部蓝图…')
    const confirm = blueprint.confirmDialog(page, '清空全部蓝图？')
    await confirm.getByText(`将删除全部 ${STAGE_SAMPLE.titles.length} 章蓝图`).waitFor({ state: 'visible' })
    await confirm.getByRole('button', { name: '清空全部' }).click()
    await blueprint.emptyHeading(page).waitFor({ state: 'visible' })
    assert.equal(await blueprint.plan(page).count(), 0, '清空后没有章节规划列表')
    await page.getByRole('button', { name: 'AI 生成蓝图' }).waitFor({ state: 'visible' })
  } },

  'blueprint-save': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await blueprint.open(page)
    await blueprint.planItem(page, 6).click()
    await blueprint.titleInput(page).fill('第二盏灯亮起')
    await stage.saveStatus(page).getByText('未保存').waitFor({ state: 'visible' })
    assert.equal(await stage.root(page).getByText('未保存', { exact: true }).count(), 1, '只有顶栏一处未保存提示')
    await page.keyboard.press('Control+S')
    await stage.saveStatus(page).getByText('已保存').waitFor({ state: 'visible' })
    await blueprint.pageMenu(page, '重新加载蓝图')
    await blueprint.planItem(page, 6).getByText('第二盏灯亮起').waitFor({ state: 'visible' })
  } },

  'blueprint-timing': { model: false, setup: withManyBlueprints, run: async ({ page }) => {
    if (await stage.root(page).count() > 0) {
      const openMs = await msFromClick(page, stage.stageButton(page, '蓝图'), '.stage-bp-plan-item', `远航之${TIMING_CHAPTERS}`)
      const target = blueprint.planItem(page, 150)
      await target.scrollIntoViewIfNeeded()
      const switchMs = await msFromClick(page, target, '.stage-bp-title', '远航之150')
      return { openMs, switchMs, shell: 'stage' }
    }
    const openMs = await msFromClick(page, project.tree(page).getByText('章节蓝图', { exact: true }), '.truncate', `远航之${TIMING_CHAPTERS}`)
    const target = page.getByText('远航之150', { exact: true }).first()
    await target.scrollIntoViewIfNeeded()
    const switchMs = await msFromClick(page, target, 'h3', '远航之150')
    return { openMs, switchMs, shell: 'writer' }
  } },
}
