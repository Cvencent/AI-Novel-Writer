// RD-V 统一视觉层的实机场景：危险确认、命令式错误弹框、提示栈、运行失败提示，以及新外壳下的旧对话框。
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

  'rdv-toasts': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: async ({ page, invoke, path: projectPath, session }) => {
    for (const [purpose, durationMs] of [['chapter-draft', 41_000], ['review-chapter', 27_000]]) {
      assert.equal((await invoke(page, 'db:log-llm-call', { modelId: FAKE_MODEL.id, modelName: FAKE_MODEL.name, purpose, promptTokens: 4000,
        completionTokens: 1200, totalTokens: 5200, durationMs, success: true }, projectPath, session)).success, true)
    }
  } }), run: async ({ page }) => {
    await page.evaluate(() => { navigator.clipboard.writeText = async () => {} })
    await stage.stageButton(page, '蓝图').click()
    await chapter.writeNextChapter(page, 100)
    await runSheet.waitUntilOpen(page)
    await runSheet.waitForRunDone(page)
    await runSheet.tab(page, '诊断').click()
    const copy = runSheet.sheet(page).getByRole('table').getByRole('button', { name: '复制安全诊断' }).first()
    await copy.waitFor({ state: 'visible', timeout: 10_000 })
    // 第一条通知会盖住侧页下方的复制按钮，后两次直接派发点击
    for (let i = 0; i < 3; i++) await copy.dispatchEvent('click')
    const stack = page.locator('.pi-toast-stack')
    await stack.locator('.pi-toast').nth(2).waitFor({ state: 'visible' })
    assert.equal(await stack.count(), 1, '只有一个提示栈')
    const boxes = await stack.locator('.pi-toast:not([data-exiting])').evaluateAll(items => items.map(item => item.getBoundingClientRect().toJSON()))
    for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i].top >= boxes[i - 1].bottom, '通知互不重叠')
    assert.ok(await inPaperInk(stack), '提示栈在纸墨宿主里')
    return { toasts: boxes.length }
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
}
