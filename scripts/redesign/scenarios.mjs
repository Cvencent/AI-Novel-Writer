import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import { FAKE_MODEL, FIXTURE_PROSE } from './fake-model.mjs'
import * as bookshelf from './pages/bookshelf.mjs'
import * as chapter from './pages/chapter.mjs'
import * as materials from './pages/materials.mjs'
import * as project from './pages/project.mjs'
import * as runPanel from './pages/run-panel.mjs'
import * as settings from './pages/settings.mjs'
import * as shell from './pages/shell.mjs'
import * as stage from './pages/stage.mjs'
import { countUnits, STAGE_SAMPLE, stageChapterTitle } from './stage-sample.mjs'

const SAMPLE = Object.freeze({ name: '灯塔', chapterNumber: 1, blueprints: [[1, '旧港'], [2, '北堤']] })

/** 系统打开对话框直接返回 selected，文件夹与文件通用。 */
async function stubOpenDialog(app, selected) {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, selected)
}

/** 用公开 IPC 预置示例作品，然后重载，让界面从书房重新打开它。 */
async function seedSample({ app, page, roots, invoke, reload }, { withDraft }) {
  const created = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, roots.projects)).grantId,
    name: SAMPLE.name, genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
  assert.equal(created.success, true, created.error)
  const opened = await invoke(page, 'project:open', created.projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  const session = { projectId: created.projectId, projectPath: created.projectPath, leaseId: opened.project.sessionLease }
  assert.equal((await invoke(page, 'llm:save-model', FAKE_MODEL)).success, true)
  assert.equal((await invoke(page, 'llm:set-default-model', FAKE_MODEL.id)).success, true)
  const roster = await invoke(page, 'db:character-roster-read', created.projectPath, session)
  assert.equal((await invoke(page, 'db:character-roster-commit', { operationId: randomUUID(), expectedRevision: roster.revision,
    expectedIdentityRevision: roster.identityRevision, schemaVersion: 1, intent: 'manual_edit',
    entries: [{ characterId: `draft:${randomUUID()}`, name: '林岚', role: 'protagonist', gender: '', age: '', appearance: '',
      personality: '', background: '旧港潮汐记录的测绘师。', abilities: '', motivation: '查明失踪地图的来源。',
      relationships: [], arc: '', notes: '' }] }, created.projectPath, session)).success, true)
  for (const [chapterNumber, title] of SAMPLE.blueprints) {
    assert.equal((await invoke(page, 'db:blueprint-upsert', { chapterNumber, title, role: '发展', purpose: '核对地图与潮位',
      keyEvents: '林岚在灯塔下见到守塔人', characters: [] }, created.projectPath, session)).success, true)
  }
  if (withDraft) {
    const draft = await invoke(page, 'db:draft-create', { chapterNumber: SAMPLE.chapterNumber, version: 1, source: 'write',
      content: FIXTURE_PROSE, wordCount: FIXTURE_PROSE.length }, created.projectPath, session)
    assert.equal(draft.success, true, draft.error)
  }
  await reload()
  await openSample(page)
}

/** 从书房打开示例作品，等项目树的统一刷新结束；之前的画面随刷新进度变化。 */
async function openSample(page) {
  await bookshelf.openProject(page, SAMPLE.name)
  await project.waitForTreeRefreshed(page, SAMPLE.blueprints.length)
}

const seedWithDraft = context => seedSample(context, { withDraft: true })
const seedWithoutDraft = context => seedSample(context, { withDraft: false })

async function openLatestDraft(page) {
  await project.openLatestDraft(page)
  await chapter.editor(page).getByText(FIXTURE_PROSE.slice(0, 12)).waitFor({ state: 'visible' })
}

async function writeChapter({ page }) {
  await project.openBlueprints(page)
  await chapter.writeThisChapter(page, 100)
  await runPanel.waitForWorkflowDone(page)
  await chapter.editor(page).getByText(FIXTURE_PROSE.slice(0, 12)).waitFor({ state: 'visible' })
}

async function reviewLatestDraft({ page }) {
  await openLatestDraft(page)
  await chapter.review(page)
  await runPanel.waitForWorkflowDone(page)
}

/**
 * setup 是单跑该场景时的前置；run 从前置状态走到截图状态；after 在截图后执行。
 * baseline-all 按 BASELINE_SESSIONS 串联：只跑首个场景的 setup，之后每个场景的 run 接着上一个截图点的状态。
 */
export const SCENARIOS = {
  'new-project': { model: false, run: async ({ app, page, roots }) => {
    await stubOpenDialog(app, roots.projects)
    await bookshelf.createProject(page, SAMPLE.name)
    await page.getByText('小说配置', { exact: true }).first().waitFor({ state: 'visible' })
  } },
  'open-sample': { model: false, setup: seedWithDraft, run: async ({ page }) => {
    await project.tree(page).getByText('草稿_v1', { exact: true }).waitFor({ state: 'visible' })
  } },
  'write-chapter': { model: true, setup: seedWithoutDraft, run: writeChapter },
  review: { model: true, setup: seedWithDraft, run: reviewLatestDraft },
  'revise-merge': { model: true,
    setup: async context => { await seedWithDraft(context); await reviewLatestDraft(context) },
    run: async ({ page }) => {
      await chapter.reviseFromReview(page, FAKE_MODEL.id)
      await chapter.mergeDialog(page).waitFor({ state: 'visible', timeout: 60_000 })
    },
    after: ({ page }) => chapter.completeMerge(page) },
  finalize: { model: true, setup: seedWithDraft, run: async ({ page }) => {
    await openLatestDraft(page)
    await chapter.finalize(page, SAMPLE.chapterNumber)
    await runPanel.waitForWorkflowDone(page)
  } },
  'run-panel': { model: true,
    setup: async context => { await seedWithoutDraft(context); await writeChapter(context) },
    run: async ({ page, reload }) => {
      await reload()
      await openSample(page)
      await runPanel.open(page)
      await runPanel.waitForPersistedRun(page, `第${SAMPLE.chapterNumber}章候选`)
    } },
  settings: { model: false, run: ({ page }) => settings.open(page), after: ({ page }) => settings.close(page) },
}

async function assertRunPanelHiddenThenOpens(page, open) {
  await shell.showAssistant(page)
  assert.equal(await runPanel.isOpen(page), false, '切到写作助手后 AI 输出应隐藏')
  await open()
  await runPanel.waitUntilOpen(page)
}

async function assertBottomOpensOn(page, start) {
  await shell.closeBottomPanel(page)
  await start()
  await page.waitForFunction(() => !document.querySelector('#writer-bottom')?.hasAttribute('hidden'))
  await shell.bottomTabLabel(page, '任务').waitFor({ state: 'visible', timeout: 5_000 })
}

/**
 * 不进 baseline-all 的场景：性能测量，以及 RD-2 导航意图在旧外壳上的回归。run 的返回值写进结果的 measured。
 * nav- 场景对 trunk 与 head 各跑一次（--app-root 指向 trunk），两边都通过即行为一致。
 */
export const EXTRA_SCENARIOS = {
  'write-latency': { model: true, setup: seedWithoutDraft, run: async ({ page }) => {
    await project.openBlueprints(page)
    const writeToOutputMs = await runPanel.msFromClickToOpen(page, '开始创作', () => chapter.writeThisChapter(page, 100))
    await runPanel.waitForWorkflowDone(page)
    return { writeToOutputMs }
  } },
  'nav-switch-project': { model: false, setup: seedWithDraft, run: async ({ app, page, roots, invoke }) => {
    const other = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, roots.projects)).grantId,
      name: '雾岛', genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
    assert.equal(other.success, true, other.error)
    await shell.clickRail(page, '角色')
    await shell.toggleImmersion(page)
    assert.equal(await shell.isImmersive(page), true)
    await stubOpenDialog(app, other.projectPath)
    await shell.switchProject(page)
    await project.tree(page).getByText('雾岛', { exact: true }).waitFor({ state: 'visible' })
    assert.equal(await shell.isImmersive(page), false, '切换项目后应退出沉浸')
    assert.equal((await shell.panels(page)).sidebar, true, '切换项目后侧栏应显示')
    await project.tree(page).waitFor({ state: 'visible' })
  } },
  'nav-toast-open': { model: true, setup: seedWithoutDraft, run: async ({ page }) => {
    await project.openBlueprints(page)
    await chapter.writeThisChapter(page, 100)
    await runPanel.waitForWorkflowDone(page)
    await assertRunPanelHiddenThenOpens(page, () => runPanel.openFromCompletionToast(page))
    await runPanel.waitForPersistedRun(page, `第${SAMPLE.chapterNumber}章候选`)
  } },
  'nav-status-capsule': { model: true, setup: seedWithoutDraft, run: async ({ page, fake }) => {
    fake.gate.hold()
    await project.openBlueprints(page)
    await chapter.writeThisChapter(page, 100)
    await runPanel.waitForStatusCapsule(page)
    await assertRunPanelHiddenThenOpens(page, () => runPanel.openFromStatusCapsule(page))
  }, after: async ({ page, fake }) => {
    fake.gate.release()
    await runPanel.waitForWorkflowDone(page)
  } },
  'nav-settings-model': { model: true, setup: seedWithoutDraft, run: async ({ page }) => {
    await shell.openBackupSettings(page)
    await settings.waitForSection(page, '项目备份')
    await settings.close(page)
    await shell.clickStatusBarModel(page)
    await settings.waitForSection(page, 'AI 生成模型')
  }, after: ({ page }) => settings.close(page) },
  'nav-kb-import': { model: true, setup: seedWithoutDraft, run: async ({ app, page, roots }) => {
    const file = path.join(roots.temp, '灯塔资料.txt')
    fs.writeFileSync(file, '林岚：旧港潮汐记录的测绘师，追查失踪地图的来源。')
    await stubOpenDialog(app, file)
    await shell.clickRail(page, '小说')
    await assertBottomOpensOn(page, () => materials.importPlanningMaterial(page))
  }, after: ({ page }) => runPanel.cancelActiveRuns(page) },
  'nav-card-import': { model: true, setup: seedWithoutDraft, run: async ({ page }) => {
    await shell.clickRail(page, '角色')
    await assertBottomOpensOn(page, () => materials.importCharacterCards(page, '姓名：守塔人\n身份：灯塔看守，记得每一次钟声。'))
  }, after: ({ page }) => runPanel.cancelActiveRuns(page) },
  'nav-batch': { model: true, setup: seedWithoutDraft, run: async ({ page }) => {
    await project.openBlueprints(page)
    await assertBottomOpensOn(page, () => chapter.startBatch(page, FAKE_MODEL.id, 100))
  }, after: ({ page }) => runPanel.waitForWorkflowDone(page) },
  'nav-home-import': { model: true, setup: seedWithoutDraft, run: async ({ app, page, roots, fake }) => {
    const file = path.join(roots.temp, '参考小说.txt')
    fs.writeFileSync(file, `第1章 旧港\n${FIXTURE_PROSE}\n\n第2章 北堤\n${FIXTURE_PROSE}\n`)
    await stubOpenDialog(app, file)
    await shell.clickRail(page, '首页')
    await shell.shelf(page).waitFor({ state: 'visible' })
    assert.equal(await project.tree(page).isVisible(), false, '首页不显示项目树')
    assert.equal(await runPanel.isOpen(page), false, '首页不显示 AI 输出')
    fake.gate.hold()
    await materials.importReferenceNovelIntoCurrentProject(page, 2)
    await project.tree(page).waitFor({ state: 'visible' })
    await runPanel.waitUntilOpen(page)
    assert.equal(await shell.shelf(page).isVisible(), false, '启动导入后应离开首页')
  }, after: async ({ page, fake }) => {
    fake.gate.release()
    await runPanel.waitForStatusCapsuleGone(page)
  } },
  'nav-immersive-twice': { model: false, setup: seedWithDraft, run: async ({ page }) => {
    await shell.closeBottomPanel(page)
    const before = await shell.panels(page)
    await shell.toggleImmersion(page)
    assert.deepEqual(await shell.panels(page), { sidebar: false, assistant: false, bottom: false })
    await shell.toggleImmersion(page)
    assert.deepEqual(await shell.panels(page), before, '两次切换后面板应恢复到切换前')
    assert.equal(await shell.isImmersive(page), false)
  } },
}

const firstLine = text => text.split('\n')[0].slice(0, 16)

/** 用公开 IPC 预置新外壳示例作品：12 章蓝图，1、2 章定稿，3 章已审稿，4 章草稿；架构四节齐全。 */
async function seedStageSample({ app, page, roots, invoke, reload }) {
  const created = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, roots.projects)).grantId,
    name: STAGE_SAMPLE.name, genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
  assert.equal(created.success, true, created.error)
  const opened = await invoke(page, 'project:open', created.projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  const path = created.projectPath
  const session = { projectId: created.projectId, projectPath: path, leaseId: opened.project.sessionLease }
  assert.equal((await invoke(page, 'llm:save-model', FAKE_MODEL)).success, true)
  assert.equal((await invoke(page, 'llm:set-default-model', FAKE_MODEL.id)).success, true)
  const roster = await invoke(page, 'db:character-roster-read', path, session)
  assert.equal((await invoke(page, 'db:character-roster-commit', { operationId: randomUUID(), expectedRevision: roster.revision,
    expectedIdentityRevision: roster.identityRevision, schemaVersion: 1, intent: 'manual_edit',
    entries: [{ characterId: `draft:${randomUUID()}`, name: '林岚', role: 'protagonist', gender: '', age: '', appearance: '',
      personality: '', background: '旧港潮汐记录的测绘师。', abilities: '', motivation: '查明失踪地图的来源。',
      relationships: [], arc: '', notes: '' }] }, path, session)).success, true)
  const core = await invoke(page, 'db:project-core-update', { ...STAGE_SAMPLE.core, totalChapters: STAGE_SAMPLE.totalChapters,
    wordsPerChapter: STAGE_SAMPLE.wordsPerChapter }, path, session)
  assert.equal(core.success, true, core.error)
  for (const [index, title] of STAGE_SAMPLE.titles.entries()) {
    assert.equal((await invoke(page, 'db:blueprint-upsert', { chapterNumber: index + 1, title, role: '发展', purpose: '推进灯塔与沉船的线索',
      keyEvents: '林岚在灯塔里找到新的线索', characters: [] }, path, session)).success, true)
  }
  const imported = await invoke(page, 'db:draft-import-finalized-batch', { operationId: randomUUID(),
    chapters: Object.entries(STAGE_SAMPLE.finalized).map(([number, content]) => ({ chapterNumber: Number(number),
      title: stageChapterTitle(Number(number)), content, wordCount: countUnits(content) })) }, path, session)
  assert.equal(imported.success, true, imported.error)
  for (const [number, { status, text }] of Object.entries(STAGE_SAMPLE.drafts)) {
    const draft = await invoke(page, 'db:draft-create', { chapterNumber: Number(number), version: 1, source: 'write',
      content: text, wordCount: countUnits(text) }, path, session)
    assert.equal(draft.success, true, draft.error)
    if (status !== 'draft') assert.equal((await invoke(page, 'db:draft-update-status', draft.id, status, undefined, path, session)).success, true)
  }
  await reload()
  if (await stage.root(page).count() > 0) {
    await stage.openFromLibrary(page, STAGE_SAMPLE.name)
    await stage.waitForProse(page, firstLine(STAGE_SAMPLE.drafts[3].text))
    return
  }
  await bookshelf.openProject(page, STAGE_SAMPLE.name)
  await project.waitForTreeRefreshed(page, STAGE_SAMPLE.titles.length)
  await project.draftOfChapter(page, 3).click()
  await chapter.editor(page).getByText(firstLine(STAGE_SAMPLE.drafts[3].text)).waitFor({ state: 'visible' })
}

/** 在渲染进程里计时：从点击 trigger 指向的元素到正文编辑区出现 text，单位毫秒，帧粒度。 */
async function msFromClickToProse(page, target, proseSelector, text, deadlineMs = 20_000) {
  const handle = await target.elementHandle()
  await page.evaluate(({ element, proseSelector, text, deadlineMs }) => {
    let clickedAt = null
    element.addEventListener('click', () => { clickedAt ??= performance.now() }, { capture: true, once: true })
    window.__driveProseLatency = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`正文在 ${deadlineMs} ms 内未出现`)), deadlineMs)
      const tick = () => {
        const shown = [...document.querySelectorAll(proseSelector)].some(node => node.textContent.includes(text) && node.getClientRects().length > 0)
        if (clickedAt !== null && shown) {
          clearTimeout(deadline)
          resolve(Math.round(performance.now() - clickedAt))
        } else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, { element: handle, proseSelector, text, deadlineMs })
  await target.click()
  return page.evaluate(() => window.__driveProseLatency)
}

async function assertSpineMatchesSample(page) {
  assert.deepEqual(await stage.stageStates(page), { setup: 'done', architecture: 'done', blueprint: 'done', manuscript: 'active' })
  const rows = await stage.chapterRows(page)
  assert.deepEqual(rows.map(row => row.number), STAGE_SAMPLE.titles.map((_, index) => index + 1))
  assert.deepEqual(rows.slice(0, 5).map(row => row.phase), ['final', 'final', 'reviewed', 'draft', 'todo'])
  assert.deepEqual(rows.filter(row => row.current).map(row => row.number), [3], '落点应是第一章写到一半的第 3 章')
}

/** 新外壳场景只在 head 上跑（trunk 没有新外壳）；chapter-switch 两种外壳都能跑，用于性能对照。 */
export const STAGE_SCENARIOS = {
  'stage-open-sample': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await assertSpineMatchesSample(page)
    assert.equal(await stage.tabList(page).count(), 0, '只有一个标签时标签条收起')
  } },
  'stage-tabs': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await stage.stageButton(page, '设定').click()
    await stage.tabList(page).waitFor({ state: 'visible' })
    await stage.stageButton(page, '蓝图').click()
    await stage.tab(page, '章节蓝图').waitFor({ state: 'visible' })
    assert.equal(await stage.tabList(page).getByRole('tab').count(), 3)
    await stage.closeTabButton(page, '小说配置').click()
    await stage.tab(page, '小说配置').waitFor({ state: 'detached' })
    assert.equal(await stage.tabList(page).getByRole('tab').count(), 2, '关掉一个后还剩两个，标签条仍在')
  }, after: async ({ page }) => {
    await stage.closeTabButton(page, '章节蓝图').click()
    await stage.tabList(page).waitFor({ state: 'detached' })
  } },
  'stage-dirty-close': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await stage.stageButton(page, '设定').click()
    const field = page.getByPlaceholder('如：修仙/重生/末世')
    await field.fill('海港悬疑')
    await stage.saveStatus(page).filter({ hasText: '未保存' }).waitFor({ state: 'visible' })
    await stage.closeTabButton(page, '小说配置').click()
    await page.getByRole('dialog', { name: '放弃未保存的修改？' }).waitFor({ state: 'visible' })
  }, after: async ({ page }) => {
    await page.getByRole('button', { name: '继续编辑', exact: true }).click()
    await page.getByRole('dialog', { name: '放弃未保存的修改？' }).waitFor({ state: 'hidden' })
    assert.equal(await stage.tab(page, '小说配置').getAttribute('aria-selected'), 'true', '取消后标签仍在')
    assert.equal(await page.getByPlaceholder('如：修仙/重生/末世').inputValue(), '海港悬疑', '取消后修改保留')
  } },
  'stage-save': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await stage.stageButton(page, '设定').click()
    await page.getByPlaceholder('如：修仙/重生/末世').fill('海港悬疑')
    await stage.saveStatus(page).filter({ hasText: '未保存' }).waitFor({ state: 'visible' })
    await page.keyboard.press('Control+S')
    await stage.saveStatus(page).filter({ hasText: '已保存' }).waitFor({ state: 'visible' })
  } },
  'stage-find-chapter': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await stage.stageButton(page, '蓝图').click()
    await stage.tab(page, '章节蓝图').waitFor({ state: 'visible' })
    await stage.stageButton(page, '设定').click()
    await stage.findChapter(page, '4')
    await stage.waitForProse(page, firstLine(STAGE_SAMPLE.drafts[4].text))
    assert.deepEqual((await stage.chapterRows(page)).filter(row => row.current).map(row => row.number), [4])
    await stage.findChapter(page, '第3章')
    await stage.waitForProse(page, firstLine(STAGE_SAMPLE.drafts[3].text))
    assert.deepEqual((await stage.chapterRows(page)).filter(row => row.current).map(row => row.number), [3])
  } },
  'stage-focus': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await stage.focusToggle(page).click()
    await stage.spine(page).waitFor({ state: 'detached' })
    assert.equal(await stage.tabList(page).count(), 0)
    await stage.waitForProse(page, firstLine(STAGE_SAMPLE.drafts[3].text))
    await page.getByRole('button', { name: 'AI 审稿', exact: true }).waitFor({ state: 'visible' })
  }, after: async ({ page }) => {
    await page.keyboard.press('Escape')
    await stage.spine(page).waitFor({ state: 'visible' })
  } },
  'stage-1280': { model: false, shell: 'stage', setup: async context => {
    await context.page.setViewportSize({ width: 1280, height: 900 })
    await seedStageSample(context)
  }, run: async ({ page }) => {
    const overflow = await page.evaluate(() => {
      const scroller = document.scrollingElement
      const clipped = [...document.querySelectorAll('.stage-row-name, .stage-chapter-title, .stage-crumb, .stage-work-title, .stage-search-hint, .stage-saved')]
        .filter(node => node.scrollWidth > node.clientWidth + 1 || node.getClientRects().length > 1)
        .map(node => node.textContent)
      return { horizontal: scroller.scrollWidth - scroller.clientWidth, clipped }
    })
    assert.deepEqual(overflow, { horizontal: 0, clipped: [] })
  } },
  'chapter-switch': { model: false, setup: seedStageSample, run: async ({ page }) => {
    const target = firstLine(STAGE_SAMPLE.drafts[4].text)
    if (await stage.root(page).count() > 0) {
      return { chapterSwitchMs: await msFromClickToProse(page, stage.chapterButton(page, 4), '.stage-content .cm-content', target) }
    }
    return { chapterSwitchMs: await msFromClickToProse(page, project.draftOfChapter(page, 4), chapter.EDITOR, target) }
  } },
}

/** new-project 与示例作品都建「灯塔」，同一项目目录里不能共存，所以分两个会话。 */
export const BASELINE_SESSIONS = {
  shelf: ['settings', 'new-project'],
  sample: ['open-sample', 'write-chapter', 'run-panel', 'review', 'revise-merge', 'finalize'],
}
