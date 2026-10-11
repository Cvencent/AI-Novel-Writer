import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import { FAKE_MODEL, FIXTURE_PROSE } from './fake-model.mjs'
import * as bookshelf from './pages/bookshelf.mjs'
import * as chapter from './pages/chapter.mjs'
import * as project from './pages/project.mjs'
import * as runPanel from './pages/run-panel.mjs'
import * as settings from './pages/settings.mjs'

export const SAMPLE = Object.freeze({ name: '灯塔', chapterTitle: '旧港', chapterNumber: 1 })

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
  for (const [chapterNumber, title] of [[1, SAMPLE.chapterTitle], [2, '北堤']]) {
    assert.equal((await invoke(page, 'db:blueprint-upsert', { chapterNumber, title, role: '发展', purpose: '核对地图与潮位',
      keyEvents: '林岚在灯塔下见到守塔人', characters: [] }, created.projectPath, session)).success, true)
  }
  if (withDraft) {
    const draft = await invoke(page, 'db:draft-create', { chapterNumber: SAMPLE.chapterNumber, version: 1, source: 'write',
      content: FIXTURE_PROSE, wordCount: FIXTURE_PROSE.length }, created.projectPath, session)
    assert.equal(draft.success, true, draft.error)
  }
  await reload()
  await bookshelf.openProject(page, SAMPLE.name)
}

async function openSampleDraft(context) {
  await seedSample(context, { withDraft: true })
  await project.openNode(context.page, '草稿_v1')
  await chapter.editor(context.page).getByText(FIXTURE_PROSE.slice(0, 12)).waitFor({ state: 'visible' })
}

async function reviewSample(context) {
  await openSampleDraft(context)
  await chapter.review(context.page)
  await runPanel.waitForWorkflowDone(context.page)
}

async function writeSample(context) {
  const { page } = context
  await seedSample(context, { withDraft: false })
  await project.openBlueprints(page)
  await chapter.writeThisChapter(page, 100)
  await runPanel.waitForWorkflowDone(page)
}

export const SCENARIOS = {
  'new-project': { model: false, run: async ({ app, page, roots }) => {
    await stubFolderPicker(app, roots.projects)
    await bookshelf.createProject(page, SAMPLE.name)
    await page.getByText('小说配置', { exact: true }).first().waitFor({ state: 'visible' })
  } },
  'open-sample': { model: false, run: async context => {
    await seedSample(context, { withDraft: true })
    await project.tree(context.page).getByText('草稿_v1', { exact: true }).waitFor({ state: 'visible' })
  } },
  'write-chapter': { model: true, run: async context => {
    await writeSample(context)
    await chapter.editor(context.page).getByText(FIXTURE_PROSE.slice(0, 12)).waitFor({ state: 'visible' })
  } },
  review: { model: true, run: reviewSample },
  'revise-merge': { model: true, run: async context => {
    await reviewSample(context)
    await chapter.reviseFromReview(context.page, FAKE_MODEL.id)
    await chapter.mergeDialog(context.page).waitFor({ state: 'visible', timeout: 60_000 })
    await context.shoot()
    await chapter.completeMerge(context.page)
  } },
  finalize: { model: true, run: async context => {
    await openSampleDraft(context)
    await chapter.finalize(context.page, SAMPLE.chapterNumber)
    await runPanel.waitForWorkflowDone(context.page)
  } },
  'run-panel': { model: true, run: async context => {
    await writeSample(context)
    await context.reload()
    await bookshelf.openProject(context.page, SAMPLE.name)
    await runPanel.open(context.page)
    await runPanel.waitForPersistedRun(context.page, `第${SAMPLE.chapterNumber}章候选`)
  } },
  settings: { model: false, run: async ({ page }) => { await settings.open(page) } },
}

export const SCREENSHOT_SCENARIOS = Object.keys(SCENARIOS)
