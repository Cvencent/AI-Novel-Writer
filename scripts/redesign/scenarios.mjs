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

const SAMPLE = Object.freeze({ name: '灯塔', chapterNumber: 1, blueprints: [[1, '旧港'], [2, '北堤']] })

async function stubFolderPicker(app, directory) {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, directory)
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
    await stubFolderPicker(app, roots.projects)
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
    await stubFolderPicker(app, other.projectPath)
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
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
    }, file)
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

/** new-project 与示例作品都建「灯塔」，同一项目目录里不能共存，所以分两个会话。 */
export const BASELINE_SESSIONS = {
  shelf: ['settings', 'new-project'],
  sample: ['open-sample', 'write-chapter', 'run-panel', 'review', 'revise-merge', 'finalize'],
}
