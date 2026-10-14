// RD-V 统一视觉层的实机场景：危险确认（含清除中）、命令式错误弹框、提示栈（含出错通知）、运行失败提示，以及新外壳下的旧对话框。
import assert from 'node:assert/strict'

import * as bookshelf from './pages/bookshelf.mjs'
import * as chapter from './pages/chapter.mjs'
import * as materials from './pages/materials.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { FAKE_MODEL } from './fake-model.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'
import { seedStageSample } from './scenarios.mjs'

async function openWorkMenuItem(page, name) {
  await stage.root(page).getByRole('banner').getByRole('button', { name: `《${STAGE_SAMPLE.name}》作品菜单` }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}

/** 遮罩与对话框的淡入是 220ms，截图前等它走完。 */
const settle = page => page.waitForTimeout(400)

const focusedText = page => page.evaluate(() => document.activeElement?.textContent)

/** 浮层是否渲染进带 .paper-ink 的纸墨根或宿主里：只有那样才取得到纸墨令牌与深色。 */
const inPaperInk = locator => locator.evaluate(element => element.closest('.paper-ink') !== null)

/** 写一章后打开诊断分页，返回第一条调用的「复制安全诊断」按钮。 */
async function diagnosticsCopyButton(page) {
  await stage.stageButton(page, '蓝图').click()
  await chapter.writeNextChapter(page, 100)
  await runSheet.waitUntilOpen(page)
  await runSheet.waitForRunDone(page)
  await runSheet.tab(page, '诊断').click()
  const copy = runSheet.sheet(page).getByRole('table').getByRole('button', { name: '复制安全诊断' }).first()
  await copy.waitFor({ state: 'visible', timeout: 10_000 })
  return copy
}

/** 剪贴板写入成功或失败：失败时 copySafeDiagnostic 报出错通知。 */
const stubClipboard = (page, ok) => page.evaluate(succeed => {
  navigator.clipboard.writeText = async () => { if (!succeed) throw new Error('clipboard denied') }
}, ok)

const liveToastTitles = page => page.locator('.pi-toast:not([data-exiting]) .pi-toast-title').allInnerTexts()

/** 预置两条调用记录，诊断分页的调用表才有「复制安全诊断」。 */
async function seedCalls({ page, invoke, path: projectPath, session }) {
  for (const [purpose, durationMs] of [['chapter-draft', 41_000], ['review-chapter', 27_000]]) {
    assert.equal((await invoke(page, 'db:log-llm-call', { modelId: FAKE_MODEL.id, modelName: FAKE_MODEL.name, purpose, promptTokens: 4000,
      completionTokens: 1200, totalTokens: 5200, durationMs, success: true }, projectPath, session)).success, true)
  }
}

export const VISUAL_SCENARIOS = {
  'rdv-clear': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await openWorkMenuItem(page, '清除生成内容…')
    const dialog = page.getByRole('dialog', { name: '清除项目生成内容' })
    await dialog.waitFor({ state: 'visible' })
    assert.equal(await focusedText(page), '取消', '危险确认的焦点在取消')
    assert.equal(await dialog.locator('.pi-check-row').count(), 3, '三类内容是勾选行')
    await dialog.locator('.pi-check-row').first().click()
    assert.match(await dialog.locator('.pi-dialog-consequence > p').first().innerText(), /^将清除 2 类内容/, '后果句随勾选改写')
    assert.ok(await inPaperInk(dialog), '对话框在纸墨根里')
    await settle(page)
  }, after: async ({ page }) => {
    await page.keyboard.press('Escape')
    await page.getByRole('dialog', { name: '清除项目生成内容' }).waitFor({ state: 'hidden' })
  } },

  'rdv-alert': { model: false, shell: 'stage', run: async ({ app, page, roots }) => {
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
    }, roots.projects)
    await bookshelf.createProject(page, '雾岛')
    await stage.spine(page).waitFor({ state: 'visible' })
    await stage.backToLibrary(page, '雾岛')
    // 同一目录里再建一部同名作品，主进程拒绝，界面用命令式 alertError 报错
    await page.getByRole('button', { name: '新建作品', exact: true }).click()
    const form = page.getByRole('dialog', { name: '新建小说项目' })
    await form.getByPlaceholder('如：斗破苍穹').fill('雾岛')
    await form.getByRole('button', { name: '选择', exact: true }).click()
    assert.ok(await inPaperInk(form), '旧新建作品对话框也在纸墨宿主里')
    await form.getByRole('button', { name: '创建项目', exact: true }).click()
    const alert = page.getByRole('alertdialog')
    await alert.waitFor({ state: 'visible' })
    assert.ok(await inPaperInk(alert), '命令式错误弹框渲染进纸墨宿主')
    assert.equal(await focusedText(page), '确定', '焦点在确定上')
    await settle(page)
  }, after: async ({ page }) => {
    await page.getByRole('alertdialog').getByRole('button', { name: '确定', exact: true }).click()
    await page.getByRole('alertdialog').waitFor({ state: 'hidden' })
  } },

  'rdv-toasts': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: seedCalls }), run: async ({ page }) => {
    const copy = await diagnosticsCopyButton(page)
    await stubClipboard(page, true)
    // 第一条通知会盖住侧页下方的复制按钮，之后都直接派发点击
    for (let i = 0; i < 3; i++) await copy.dispatchEvent('click')
    await stubClipboard(page, false)
    await copy.dispatchEvent('click')
    const stack = page.locator('.pi-toast-stack')
    await stack.locator('.pi-toast[data-tone="danger"]').waitFor({ state: 'visible' })
    await page.waitForTimeout(300)
    assert.equal(await stack.count(), 1, '只有一个提示栈')
    // 写完一章的「已完成」通知带动作，也在栈里
    assert.deepEqual((await liveToastTitles(page)).filter(title => title.includes('安全诊断')), ['已复制安全诊断', '复制安全诊断失败'],
      '同一句话合并成一条，出错的另起一条')
    const boxes = await stack.locator('.pi-toast:not([data-exiting])').evaluateAll(items => items.map(item => item.getBoundingClientRect().toJSON()))
    for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i].top >= boxes[i - 1].bottom, '通知互不重叠')
    assert.ok(await inPaperInk(stack), '提示栈在纸墨宿主里')
    return { toasts: boxes.length }
  } },

  'rdv-toast-error': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: seedCalls }), run: async ({ page }) => {
    // 面板打开后侧页被标 aria-hidden，按角色找不到复制按钮，先拿住元素
    const copy = await (await diagnosticsCopyButton(page)).elementHandle()
    await stubClipboard(page, true)
    await copy.dispatchEvent('click')
    await page.locator('.pi-toast', { hasText: '已复制安全诊断' }).waitFor({ state: 'visible' })
    // 提示栈已在时打开 Ctrl K 面板（Radix 模态），面板开着时复制失败
    await page.keyboard.press('Control+K')
    await stage.paletteInput(page).waitFor({ state: 'visible' })
    await stubClipboard(page, false)
    await copy.dispatchEvent('click')
    const failure = page.locator('.pi-toast[data-tone="danger"]')
    await failure.waitFor({ state: 'visible' })
    assert.equal(await failure.getAttribute('role'), 'alert', '出错通知以 alert 播报')
    assert.equal(await failure.evaluate(element => element.closest('[aria-hidden="true"]') === null && element.closest('[aria-live="polite"]') !== null), true,
      '模态开着时出错通知不在 aria-hidden 子树里，读屏读得到')
    assert.match(await failure.locator('.pi-toast-mark svg').evaluate(svg => svg.getAttribute('class')), /octagon-alert/, '八角符号')
    assert.ok(await stage.paletteInput(page).isVisible(), '面板仍开着')
    await settle(page)
  }, after: async ({ page }) => {
    await page.keyboard.press('Escape')
  } },

  'rdv-clear-busy': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page }) => {
    // 主进程里的清除处理器换成永不返回，界面停在清除中
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('db:project-clear-generated-data')
      ipcMain.handle('db:project-clear-generated-data', () => new Promise(() => {}))
    })
    await openWorkMenuItem(page, '清除生成内容…')
    const dialog = page.getByRole('dialog', { name: '清除项目生成内容' })
    await dialog.waitFor({ state: 'visible' })
    await dialog.getByRole('button', { name: '清除所选', exact: true }).click()
    const busy = dialog.locator('.pi-dialog-foot [aria-busy="true"]')
    await busy.waitFor({ state: 'visible' })
    assert.equal(await busy.innerText(), '清除中…', '按钮写清除中')
    assert.equal(await busy.isDisabled(), true, '清除中按钮禁用')
    assert.equal(await dialog.locator('.pi-check-input:disabled').count(), 3, '勾选在清除中禁用')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    assert.ok(await dialog.isVisible(), '清除中 Esc 关不掉')
    await busy.hover()
    await settle(page)
  } },

  'rdv-run-failure': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await page.keyboard.press('Control+K')
    await stage.paletteInput(page).fill('角色')
    await stage.palette(page).getByRole('option', { name: /^角色/ }).first().click()
    await materials.importCharacterCards(page, '姓名：守塔人\n身份：灯塔看守，记得每一次钟声。')
    await runSheet.waitUntilOpen(page)
    // 导入对话框还开着时侧页被 Radix 标成 aria-hidden，按角色找不到，所以用类名
    const failure = page.locator('.run-card .pi-notice[data-tone="danger"]').first()
    await failure.waitFor({ state: 'visible', timeout: 60_000 })
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    assert.equal(await failure.evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)', '失败提示没有底色')
  } },

  'rdv-export': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await openWorkMenuItem(page, '导出…')
    const dialog = page.getByRole('dialog', { name: '导出项目' })
    await dialog.waitFor({ state: 'visible' })
    assert.ok(await inPaperInk(dialog), '旧导出对话框 Portal 进纸墨宿主')
    assert.ok(await dialog.evaluate(element => element.classList.contains('pi-dialog')), '外壳是浮笺')
    await settle(page)
  }, after: async ({ page }) => {
    await page.keyboard.press('Escape')
    await page.getByRole('dialog', { name: '导出项目' }).waitFor({ state: 'hidden' })
  } },

  'rdv-import-novel': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await openWorkMenuItem(page, '小说拆解与仿写…')
    const dialog = page.getByRole('dialog').first()
    await dialog.waitFor({ state: 'visible' })
    assert.ok(await inPaperInk(dialog), '旧拆解对话框 Portal 进纸墨宿主')
    await settle(page)
  }, after: async ({ page }) => {
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').first().waitFor({ state: 'hidden' })
  } },

  'rdv-settings': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await stage.openSettings(page)
    await settle(page)
  }, after: async ({ page }) => {
    await page.getByRole('button', { name: '关闭设置' }).click()
  } },
  'rdv-tour': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: seedCalls }), run: async ({ page }) => {
    const pause = () => page.waitForTimeout(2600)
    await page.evaluate(() => { navigator.clipboard.writeText = async () => {} })
    await pause()
    await openWorkMenuItem(page, '清除生成内容…')
    const clear = page.getByRole('dialog', { name: '清除项目生成内容' })
    await clear.waitFor({ state: 'visible' })
    await pause()
    await clear.locator('.pi-check-row').first().click()
    await pause()
    await page.keyboard.press('Escape')
    await openWorkMenuItem(page, '导出…')
    await page.getByRole('dialog', { name: '导出项目' }).waitFor({ state: 'visible' })
    await pause()
    await page.keyboard.press('Escape')
    await stage.stageButton(page, '蓝图').click()
    await chapter.writeNextChapter(page, 100)
    await runSheet.waitUntilOpen(page)
    await runSheet.waitForRunDone(page)
    await pause()
    await runSheet.tab(page, '诊断').click()
    const copy = runSheet.sheet(page).getByRole('table').getByRole('button', { name: '复制安全诊断' }).first()
    await copy.waitFor({ state: 'visible', timeout: 10_000 })
    for (let i = 0; i < 2; i++) { await copy.dispatchEvent('click'); await page.waitForTimeout(500) }
    await stubClipboard(page, false)
    await copy.dispatchEvent('click')
    await pause()
    await page.keyboard.press('Control+K')
    await stage.paletteInput(page).fill('角色')
    await stage.palette(page).getByRole('option', { name: /^角色/ }).first().click()
    await materials.importCharacterCards(page, '姓名：守塔人\n身份：灯塔看守，记得每一次钟声。')
    await page.locator('.run-card .pi-notice[data-tone="danger"]').first().waitFor({ state: 'visible', timeout: 60_000 })
    await page.keyboard.press('Escape')
    await pause()
    await pause()
  } },
}
