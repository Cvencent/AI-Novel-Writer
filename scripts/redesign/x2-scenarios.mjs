// RD-X2 外部审查修复的实机场景：页面状态与显示不对的缺陷，各按作者的操作在真实 Electron 里走一遍。
// 每个场景把作者看到的值收进 measured，最后一次性断言，对照构建上失败时能看到每一项各是什么。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { renderPlotOutlineSynopsis } from '../../src/shared/plot-outline-contract.ts'
import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import { FAKE_MODEL } from './fake-model.mjs'
import * as architecture from './pages/architecture.mjs'
import * as blueprint from './pages/blueprint.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as refs from './pages/refs.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { importMaterials } from './refs-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'
import { STAGE_SAMPLE, stageChapterTitle } from './stage-sample.mjs'
import { HARBOR, holdChannel, releaseChannel, seedHarbor, untilHeld } from './x1-scenarios.mjs'

/** 情节大纲分批写到第 6 章（全书 12 章），尾标与主进程写入的一字不差：能从第 7 章续写，架构部分完成。 */
const partialOutline = () => renderPlotOutlineSynopsis(
  Array.from({ length: 6 }, (_, index) => `## 第${index + 1}章：${stageChapterTitle(index + 1)}\n林岚在第${index + 1}夜核对雾钟与潮位。`).join('\n\n'),
  6, { totalChapters: STAGE_SAMPLE.totalChapters, writingLanguage: 'zh-CN' })

const updateSynopsis = synopsis => async ({ page, invoke, path: projectPath, session }) => {
  const updated = await invoke(page, 'db:project-core-update', { ...STAGE_SAMPLE.core, synopsis, totalChapters: STAGE_SAMPLE.totalChapters,
    wordsPerChapter: STAGE_SAMPLE.wordsPerChapter }, projectPath, session)
  assert.equal(updated.success, true, updated.error)
}

/** 另建一部只有设定与架构（大纲分批没写完）的作品；blueprints 为 true 时再加前三章蓝图，没有正文。 */
async function seedOutlineBook(context, name, { blueprints }) {
  const { app, page, roots, invoke } = context
  const created = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, roots.projects)).grantId,
    name, genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
  assert.equal(created.success, true, created.error)
  const opened = await invoke(page, 'project:open', created.projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  const session = { projectId: created.projectId, projectPath: created.projectPath, leaseId: opened.project.sessionLease }
  assert.equal((await invoke(page, 'db:project-core-update', { ...STAGE_SAMPLE.core, synopsis: partialOutline(),
    totalChapters: STAGE_SAMPLE.totalChapters, wordsPerChapter: STAGE_SAMPLE.wordsPerChapter }, created.projectPath, session)).success, true)
  if (!blueprints) return
  for (const number of [1, 2, 3]) {
    assert.equal((await invoke(page, 'db:blueprint-upsert', { chapterNumber: number, title: stageChapterTitle(number), role: '发展',
      purpose: '推进灯塔与沉船的线索', keyEvents: '林岚在灯塔里找到新的线索', characters: [] }, created.projectPath, session)).success, true)
  }
}

/** 落点稳定后的位置面包屑：等到出现，再等半秒确认不再变。 */
async function settledLanding(page) {
  const deadline = Date.now() + 20_000
  let last = null
  for (;;) {
    const { crumbs } = await stage.landing(page)
    const key = crumbs.join('/')
    if (key && key === last) return crumbs
    assert.ok(Date.now() < deadline, `20 秒内落点没有稳定（最后是 ${key || '空'}）`)
    last = key
    await page.waitForTimeout(500)
  }
}

/** 从书房的「打开作品」选文件夹打开：主进程的文件夹对话框换成直接选中这部作品。 */
async function openFolder(app, page, folder) {
  await app.evaluate(({ dialog }, selected) => {
    globalThis.__x2Dialog = dialog.showOpenDialog
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, folder)
  try {
    await stage.root(page).getByRole('button', { name: '打开作品', exact: true }).click()
    await stage.spine(page).waitFor({ state: 'visible' })
  } finally {
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = globalThis.__x2Dialog })
  }
}

/** 把主进程 channel 之后每次调用的参数记下来（不改行为）。 */
async function recordArgs(app, channel) {
  await app.evaluate(({ ipcMain }, channel) => {
    const calls = (globalThis.__x2Args ??= {})[channel] = []
    const original = ipcMain._invokeHandlers.get(channel)
    ipcMain._invokeHandlers.set(channel, (event, ...args) => {
      calls.push(args)
      return original(event, ...args)
    })
  }, channel)
}
const recordedArgs = (app, channel) => app.evaluate((_, channel) => globalThis.__x2Args[channel], channel)

/** 数据库 datetime('now') 的时刻按本机时区显示成什么，与页面用同一组 toLocaleString 选项。 */
const localTime = (page, value, options) => page.evaluate(([value, options]) =>
  new Date(`${value.replace(' ', 'T')}Z`).toLocaleString('zh-CN', options), [value, options])

export const X2_SCENARIOS = {
  // #394 §6（用户决定 B）：大纲分批没写完时，只有蓝图与正文都没有才落在架构；有蓝图或正文就落到当前写作位置。
  // 书房打开三部作品，再用「打开作品」选文件夹打开灯塔。
  'x2-landing': { model: false, shell: 'stage', setup: async context => {
    await seedOutlineBook(context, '荒岛', { blueprints: false })
    await seedOutlineBook(context, '北堤', { blueprints: true })
    await seedStageSample(context, { open: false, beforeReload: updateSynopsis(partialOutline()) })
  }, run: async ({ app, page, samplePath, shoot }) => {
    const landed = {}
    for (const name of ['荒岛', '北堤', STAGE_SAMPLE.name]) {
      await stage.openFromLibrary(page, name)
      landed[name] = (await settledLanding(page)).join(' / ')
      await shoot(`x2-landing-${name}`)
      await stage.backToLibrary(page, name)
    }
    await openFolder(app, page, samplePath)
    landed['灯塔（打开作品）'] = (await settledLanding(page)).join(' / ')
    const architectureState = (await stage.stageStates(page)).architecture
    const measured = { landed, architectureState }
    assert.deepEqual(landed, {
      荒岛: '架构', 北堤: '正文 / 第 1 章', [STAGE_SAMPLE.name]: '正文 / 第 3 章', '灯塔（打开作品）': '正文 / 第 3 章',
    }, JSON.stringify(measured))
    return measured
  } },

  // #394 §1：大纲末尾带分批尾标但多了一个换行（主进程已接不上续写）不算已确认；§2：超过单批上限的范围在对话框里直接判无效。
  'x2-outline': { model: false, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: updateSynopsis(`${partialOutline()}\n`) }),
    run: async ({ page, shoot }) => {
      await architecture.open(page)
      const shown = {
        badge: await architecture.badge(page, 'synopsis').innerText(),
        progress: (await architecture.page(page).locator('.arch-progress').innerText()).trim(),
        next: await architecture.next(page).isEnabled(),
      }
      // 判为已确认时主按钮是「下一步」，生成对话框改从页头的更多操作里打开。
      if (shown.next) {
        await stage.root(page).getByRole('button', { name: '架构的更多操作' }).click()
        await page.getByRole('menuitem', { name: 'AI 生成架构…' }).click()
      } else await architecture.primary(page).click()
      await architecture.dialog(page).waitFor({ state: 'visible' })
      if (!await architecture.dialog(page).locator('[data-step="synopsis"] input[type="checkbox"]').isChecked()) await architecture.stepCheck(page, 'synopsis').click()
      await architecture.setRange(page, 1, 12)
      const range = {
        mark: await architecture.mark(page, 'synopsis').innerText(),
        submit: await architecture.dialog(page).getByRole('button', { name: /开始生成 \d 项/ }).isEnabled(),
      }
      await shoot('x2-outline-range')
      await architecture.dialog(page).getByRole('button', { name: '取消', exact: true }).click()
      const measured = { shown, range }
      assert.deepEqual(measured, { shown: { badge: '不完整', progress: '· 3 / 4 已确认', next: false }, range: { mark: '范围无效', submit: false } }, JSON.stringify(measured))
      return measured
    } },

  // #380 C3+O2：预览港口后回到灯塔，概览不停在「正在读取」；O23：正在预览的港口被移出最近项目后，灯塔名下不显示港口的统计。
  'x2-library-overview': { model: false, shell: 'stage', setup: async context => {
    await seedHarbor(context)
    await seedStageSample(context)
  }, run: async ({ page, shoot }) => {
    await stage.backToLibrary(page, STAGE_SAMPLE.name)
    const current = stage.overview(page, STAGE_SAMPLE.name)
    const excerpt = current.locator('.stage-ov-excerpt')
    await excerpt.waitFor({ state: 'visible', timeout: 15_000 })
    await stage.previewBook(page, HARBOR)
    await stage.overview(page, HARBOR).getByRole('button', { name: `打开《${HARBOR}》` }).waitFor({ state: 'visible' })
    await stage.overview(page, HARBOR).getByRole('button', { name: `回到《${STAGE_SAMPLE.name}》` }).click()
    await page.waitForTimeout(2000)
    const back = { busy: await current.getAttribute('aria-busy'), excerpt: await excerpt.isVisible() }
    await shoot('x2-library-back')

    await stage.previewBook(page, HARBOR)
    await stage.overview(page, HARBOR).getByRole('button', { name: `打开《${HARBOR}》` }).waitFor({ state: 'visible' })
    await stage.bookMenu(page, HARBOR, '从最近项目移除…')
    await page.getByRole('dialog').getByRole('button', { name: '移除记录' }).click()
    await stage.cover(page, HARBOR).waitFor({ state: 'detached' })
    await page.waitForTimeout(1500)
    const removed = { busy: await current.getAttribute('aria-busy'), excerpt: await excerpt.isVisible() }
    const measured = { back, removed }
    assert.deepEqual(measured, { back: { busy: 'false', excerpt: true }, removed: { busy: 'false', excerpt: true } }, JSON.stringify(measured))
    return measured
  } },

  // #388 T2/T12/T8：版本历史再点当前章各稿还在；换章读到之前显示正在读取；稿的时间按 UTC 换成本地时间（单章视图的版本切换器同样）。
  'x2-history': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page, invoke, shoot }) => {
    await watchSession(app)
    await refs.open(page, 'history')
    const chapter3 = refs.historyChapters(page).getByRole('button', { name: /雾钟/ })
    await chapter3.click()
    await refs.timeline(page).waitFor({ state: 'visible' })
    const historyTime = (await refs.timeline(page).locator('.stage-hist-meta').last().innerText()).split(' · ').at(-1)
    await chapter3.click()
    await page.waitForTimeout(1500)
    const reclicked = { timeline: await refs.timeline(page).isVisible() }

    await holdChannel(app, 'db:draft-list')
    await refs.historyChapters(page).getByRole('button', { name: /守塔人/ }).click()
    await untilHeld(app, 'db:draft-list')
    const whileLoading = await page.getByRole('region', { name: '这一章的各稿' }).locator('.stage-hist-help').innerText()
    await shoot('x2-history-loading')
    await releaseChannel(app, 'db:draft-list')
    await page.waitForTimeout(1000)

    await stage.tab(page, /^第 3 章/).click()
    await chapterView.versionButton(page).click()
    const switcherTime = (await page.getByRole('menu', { name: '本章版本' }).getByRole('menuitemradio').first().locator('small').innerText()).split(' · ').at(-1)
    await page.keyboard.press('Escape')

    const session = await app.evaluate(() => globalThis.__x2Session)
    const [draft] = await invoke(page, 'db:draft-list', 3, session.projectPath, session)
    const expected = {
      history: await localTime(page, draft.createdAt, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
      switcher: await localTime(page, draft.updatedAt ?? draft.createdAt, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    }
    const shown = { reclicked, whileLoading, times: { history: historyTime, switcher: switcherTime } }
    const measured = { ...shown, expected, stored: { createdAt: draft.createdAt, updatedAt: draft.updatedAt } }
    assert.deepEqual(shown, { reclicked: { timeline: true }, whileLoading: '正在读取…', times: expected }, JSON.stringify(measured))
    return measured
  } },
}

/** 记下界面发给主进程的最近一次带项目会话的调用参数，驱动用同一会话读数据库。 */
async function watchSession(app) {
  await app.evaluate(({ ipcMain }) => {
    for (const [channel, handler] of ipcMain._invokeHandlers) {
      ipcMain._invokeHandlers.set(channel, (event, ...args) => {
        const session = args.at(-1)
        if (session && typeof session === 'object' && 'leaseId' in session) globalThis.__x2Session = session
        return handler(event, ...args)
      })
    }
  })
}
