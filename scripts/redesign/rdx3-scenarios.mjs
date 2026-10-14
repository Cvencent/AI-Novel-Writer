// RD-X3 外部审查修复的实机场景：浮层在小窗口里的位置与内部滚动、键盘焦点环、导入对话框的主按钮数、缩窗后的提示栈、长作品名的顶栏。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import * as blueprint from './pages/blueprint.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'
import { seedStageSample } from './scenarios.mjs'

const DEAD = ['林岚', '守塔人', '阿潮']
const LONG_NAME = '雾钟每晚提前一刻响起'.repeat(8)

/** 第 3 章的出场人物是三位，主进程的连续性事实写他们都已死：写作弹层里出三条一致性预检提醒。 */
const withThreeFindings = context => seedStageSample(context, { beforeReload: async ({ page, invoke, path: projectPath, session }) => {
  assert.equal((await invoke(page, 'db:blueprint-upsert', { chapterNumber: 3, title: STAGE_SAMPLE.titles[2], role: '发展',
    purpose: '推进灯塔与沉船的线索', keyEvents: '林岚在灯塔里找到新的线索', characters: DEAD, userGuidance: '' }, projectPath, session)).success, true)
} })

async function injectThreeDead(app, names) {
  const wrapped = await app.evaluate(({ ipcMain }, dead) => {
    const handlers = ipcMain._invokeHandlers
    if (!(handlers instanceof Map) || !handlers.has('db:continuity-list-before')) return false
    globalThis.__rdx3ContinuityOriginal = handlers.get('db:continuity-list-before')
    handlers.set('db:continuity-list-before', () => [{
      draftId: 1, chapterNumber: 1, chapterTitle: '旧港', chapterNotes: '风暴之夜。',
      source: { draftId: 1, finalizationId: 'rdx3-fixture', chapterNumber: 1, contentHash: 'a'.repeat(64) },
      sourceStatus: 'current',
      facts: dead.map(name => ({ category: 'character-state', entities: [name], statement: `${name}已经死亡。`, sourceChapter: 1, evidence: `${name}在风暴里没有再回来。` })),
    }])
    return true
  }, names)
  assert.ok(wrapped, '能在主进程里替换连续性事实的读取')
}

const restoreContinuity = app => app.evaluate(({ ipcMain }) => ipcMain._invokeHandlers.set('db:continuity-list-before', globalThis.__rdx3ContinuityOriginal))

async function setViewport(page, width, height) {
  await page.setViewportSize({ width, height })
  await page.waitForFunction(size => innerWidth === size.width && innerHeight === size.height, { width, height })
}

/** 写作弹层在 width×height 的窗口里：三条预检提醒时停在视口内，内部滚到底点得到「仅本次忽略」，内部滚动不关闭弹层。 */
const popoverIn = (width, height) => ({ model: true, shell: 'stage', setup: withThreeFindings, run: async ({ app, page, shoot }) => {
  await setViewport(page, width, height)
  await injectThreeDead(app, DEAD)
  await blueprint.open(page)
  await blueprint.writeNext(page)
  await blueprint.preflight(page).waitFor({ state: 'visible' })
  await blueprint.popover(page).getByText(/一致性预检 · 3 条线索提醒/).waitFor({ state: 'visible' })
  const layer = blueprint.popover(page)
  const box = await layer.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom, viewport: innerHeight, scrolls: element.scrollHeight > element.clientHeight, maxHeight: element.style.maxHeight }
  })
  assert.ok(box.top >= 0 && box.bottom <= box.viewport - 8, `弹层停在视口内：${box.top}–${box.bottom} / ${box.viewport}`)
  assert.ok(box.scrolls, '内容高过可用空间时在弹层内部滚动')
  await shoot(`rdx3-popover-${width}x${height}-top`)
  await layer.evaluate(element => { element.scrollTop = element.scrollHeight })
  await page.waitForTimeout(200)
  assert.equal(await layer.count(), 1, '弹层内部滚动不关闭弹层')
  const ignore = blueprint.preflight(page).getByRole('button', { name: '仅本次忽略' })
  const hit = await ignore.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return { inside: rect.bottom <= innerHeight, hit: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === element }
  })
  assert.deepEqual(hit, { inside: true, hit: true }, '滚到底后「仅本次忽略」在视口内且点得到')
  return box
}, after: async ({ app, page }) => {
  await restoreContinuity(app)
  await page.keyboard.press('Escape')
} })

/** 按 Tab 直到焦点落在 target 上，读它的 box-shadow，截一张它周围的图。 */
async function tabTo(page, target, shoot, name, limit = 60) {
  const handle = await target.elementHandle()
  for (let step = 0; step < limit; step++) {
    if (await handle.evaluate(element => element === document.activeElement)) {
      const ring = await handle.evaluate(element => ({ boxShadow: getComputedStyle(element).boxShadow, focusVisible: element.matches(':focus-visible') }))
      await shoot(name)
      return ring
    }
    await page.keyboard.press('Tab')
  }
  throw new Error(`${name}：按 ${limit} 次 Tab 没有到达`)
}

const hasRing = ({ boxShadow, focusVisible }, accent) => focusVisible && boxShadow.includes(accent)

export const RDX3_SCENARIOS = {
  'rdx3-popover-1280': popoverIn(1280, 720),
  'rdx3-popover-1024': popoverIn(1024, 640),

  /** 键盘焦点环：运行侧页分段页签的选中项、激活的内容标签、流程脊当前阶段行、拆分主按钮两半。 */
  'rdx3-keyboard': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page, shoot }) => {
    const accent = await stage.root(page).evaluate(root => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--accent)'
      root.append(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    })
    await blueprint.open(page)
    await stage.stageButton(page, '架构').click()
    await stage.stageButton(page, '蓝图').click()
    const rings = {}
    await stage.spine(page).locator('button').first().focus()
    rings.spineCurrent = await tabTo(page, stage.stageButton(page, '蓝图'), shoot, 'rdx3-focus-spine-current')
    rings.activeTab = await tabTo(page, stage.tabList(page).getByRole('tab', { selected: true }), shoot, 'rdx3-focus-active-tab')
    rings.splitMain = await tabTo(page, blueprint.writeButton(page), shoot, 'rdx3-focus-split-main')
    rings.splitToggle = await tabTo(page, blueprint.writeOptions(page), shoot, 'rdx3-focus-split-toggle')
    await runSheet.openFromPalette(page)
    await runSheet.sheet(page).getByRole('heading').first().focus()
    rings.segmentedTab = await tabTo(page, runSheet.sheet(page).getByRole('tab', { selected: true }), shoot, 'rdx3-focus-segmented-tab')
    for (const [name, ring] of Object.entries(rings)) assert.ok(hasRing(ring, accent), `${name} 有可见的焦点环：${JSON.stringify(ring)}`)
    return rings
  } },

  /** 新外壳里的导入对话框：同屏只有一个上墨的主按钮，用途与目标的选中项是按下的次按钮。 */
  'rdx3-import-dialog': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await stage.root(page).getByRole('banner').getByRole('button', { name: `《${STAGE_SAMPLE.name}》作品菜单` }).click()
    await page.getByRole('menuitem', { name: '小说拆解与仿写…', exact: true }).click()
    const dialog = page.getByRole('dialog').first()
    await dialog.waitFor({ state: 'visible' })
    await page.waitForTimeout(400)
    const buttons = await dialog.evaluate(element => ({
      primary: [...element.querySelectorAll('.pi-btn--primary')].map(button => ({ text: button.textContent, disabled: button.disabled })),
      toggles: [...element.querySelectorAll('button[aria-pressed]')].map(button => ({ text: button.textContent, pressed: button.getAttribute('aria-pressed'), secondary: button.classList.contains('pi-btn--secondary') })),
    }))
    assert.equal(buttons.primary.length, 1, `只有一个主按钮：${JSON.stringify(buttons.primary)}`)
    assert.ok(buttons.toggles.length >= 4 && buttons.toggles.every(toggle => toggle.secondary), `切换按钮都是次按钮：${JSON.stringify(buttons.toggles)}`)
    return buttons
  }, after: async ({ page }) => {
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').first().waitFor({ state: 'hidden' })
  } },

  /** 1440×900 下放得下的 11 条常驻通知，缩到 1100×640 后栈改成可滚动、最新一条露在底部，卡片右缘不因滚动条左移。 */
  'rdx3-toast-resize': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page, shoot }) => {
    const appPath = await app.evaluate(({ app: electronApp }) => electronApp.getAppPath())
    const chunk = fs.readdirSync(path.join(appPath, 'dist', 'assets')).find(name => /^ToastStack-.*\.js$/.test(name))
    assert.ok(chunk, '构建产物里有提示栈模块')
    const pushed = await page.evaluate(async ({ chunkName, count }) => {
      const module = await import(new URL(`./assets/${chunkName}`, location.href).href)
      const push = Object.values(module).find(value => typeof value === 'function' && String(value).includes('exiting:!1'))
      if (!push) return 'no-push'
      for (let i = 1; i <= count; i++) push({ tone: 'danger', message: `第 ${i} 章保存失败`, duration: 0 })
      return 'ok'
    }, { chunkName: chunk, count: 11 })
    assert.equal(pushed, 'ok')
    await page.mouse.move(4, 4)
    await page.waitForTimeout(400)
    const stack = page.locator('.pi-toast-stack')
    const geometry = () => stack.evaluate(element => {
      const cards = [...element.querySelectorAll('.pi-toast:not([data-exiting])')]
      const box = element.getBoundingClientRect()
      const newest = cards.at(-1).getBoundingClientRect()
      return { overflow: element.hasAttribute('data-overflow'), scrollbar: element.offsetWidth - element.clientWidth, right: newest.right,
        newestInside: newest.top >= box.top - 0.5 && newest.bottom <= box.bottom + 0.5, marginRight: element.style.marginRight }
    })
    const before = await geometry()
    assert.equal(before.overflow, false, `1440×900 下 11 条放得下：${JSON.stringify(before)}`)
    await setViewport(page, 1100, 640)
    await page.waitForTimeout(300)
    const after = await geometry()
    assert.ok(after.overflow, `缩窗后改成可滚动：${JSON.stringify(after)}`)
    assert.ok(after.newestInside, '最新一条露在栈底')
    assert.ok(Math.abs(after.right - (before.right - 340)) <= 0.5, `卡片右缘与窗口右缘的距离不变：${before.right} → ${after.right}`)
    const shift = await stack.evaluate(element => {
      const card = element.querySelector('.pi-toast:not([data-exiting])')
      const compensated = card.getBoundingClientRect().right
      const saved = element.style.marginRight
      element.style.marginRight = ''
      const uncompensated = card.getBoundingClientRect().right
      element.style.marginRight = saved
      return Math.round((compensated - uncompensated) * 10) / 10
    })
    await shoot('rdx3-toast-resize')
    return { before, after, shiftWithoutCompensation: shift }
  } },

  /** 80 个字的作品名：顶栏标题收成省略号，窗口控制按钮仍在窗口内。 */
  'rdx3-long-title': { model: false, shell: 'stage', setup: async context => {
    // 项目文件夹以作品名命名，隔离目录加数据库路径会超出 Windows 路径上限：建普通的示例作品，打开时由主进程把作品名换成长名字
    await seedStageSample(context, { open: false })
    await context.app.evaluate(({ ipcMain }, name) => {
      const handlers = ipcMain._invokeHandlers
      const open = handlers.get('project:open')
      handlers.set('project:open', async (...args) => {
        const result = await open(...args)
        if (result?.project) result.project.name = name
        return result
      })
    }, LONG_NAME)
    await stage.openFromLibrary(context.page, STAGE_SAMPLE.name)
  }, run: async ({ page }) => {
    await setViewport(page, 1024, 640)
    const layout = await stage.root(page).getByRole('banner').evaluate(banner => {
      // 修复前没有 .stage-work-name，作品名直接在按钮里：退回按钮本身，先比关闭按钮的位置
      const title = banner.querySelector('.stage-work-name') ?? banner.querySelector('.stage-work-title')
      const close = banner.querySelector('.stage-window-close').getBoundingClientRect()
      return { title: title.textContent, closeRight: close.right, viewport: innerWidth, ellipsis: getComputedStyle(title).textOverflow, clipped: title.scrollWidth > title.clientWidth }
    })
    assert.ok(layout.closeRight <= layout.viewport, `关闭按钮在窗口内：${layout.closeRight} / ${layout.viewport}`)
    assert.deepEqual([layout.title, layout.ellipsis, layout.clipped], [LONG_NAME, 'ellipsis', true], '作品名以省略号收尾')
    return layout
  } },
}
