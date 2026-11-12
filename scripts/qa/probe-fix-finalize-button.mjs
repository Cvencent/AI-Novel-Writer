/**
 * 定点探针（issue #55 验收）：点弹层里新增的「去修复第 N 章的定稿后处理」按钮，
 * 看它是否真的落到那一章的定稿后处理面板、且「重试失败步骤」可用。
 * 只读观察 + 点击，不改作品内容；工作区固定在 .qa/user-sim。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

import * as blueprintPage from '../redesign/pages/blueprint.mjs'
import * as stage from '../redesign/pages/stage.mjs'
import * as chapterView from '../redesign/pages/chapter-view.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORK_ROOT = path.join(repo, '.qa', 'user-sim')
const state = JSON.parse(fs.readFileSync(path.join(WORK_ROOT, 'state.json'), 'utf8'))
const EXE = 'F:\\aiNovel\\ai-novel-writer\\AI小说作家.exe'
const MODEL = {
  id: 'qa-deepseek-flash', name: 'QA DeepSeek V4.1 Flash', provider: 'custom', protocol: 'openai',
  modelName: 'deepseek-v4.1-flash', apiKey: 'test_key', baseUrl: 'http://127.0.0.1:8790/v1',
  temperature: 0.7, maxTokens: 32768, purposes: ['generation', 'refinement', 'summary'],
}
const log = (...a) => console.log('[p55]', ...a)

async function main() {
  fs.writeFileSync(path.join(WORK_ROOT, 'legacy', 'models.json'), JSON.stringify([MODEL], null, 2))
  const env = {
    ...process.env,
    AI_NOVEL_APP_DATA_HOME: path.join(WORK_ROOT, 'appData'),
    AI_NOVEL_LEGACY_SOURCE_HOME: path.join(WORK_ROOT, 'legacy'),
    HOME: path.join(WORK_ROOT, 'home'), USERPROFILE: path.join(WORK_ROOT, 'home'),
    LOCALAPPDATA: path.join(WORK_ROOT, 'localappdata'),
    APPDATA: path.join(WORK_ROOT, 'appdata-roaming'),
    TEMP: path.join(WORK_ROOT, 'temp'), TMP: path.join(WORK_ROOT, 'temp'),
  }
  for (const k of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) delete env[k]

  const app = await electron.launch({ executablePath: EXE, args: [`--user-data-dir=${path.join(WORK_ROOT, 'userData')}`, '--lang=zh-CN'], env, timeout: 90_000 })
  const page = await app.firstWindow({ timeout: 90_000 })
  page.setDefaultTimeout(60_000)
  await page.waitForFunction(() => Boolean(window.aiNovelAPI), null, { timeout: 90_000 })
  await stage.waitForStage(page, 90_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const ack = page.locator('.startup-migration-notice').getByRole('button', { name: '知道了', exact: true })
  if (await ack.isVisible().catch(() => false)) await ack.click()

  await stage.openFromLibrary(page, state.bookName)
  await stage.stageButton(page, '蓝图').click()
  await blueprintPage.plan(page).waitFor({ state: 'visible', timeout: 60_000 })

  await page.getByRole('button', { name: /^写第 \d+ 章$/ }).first().click()
  await page.getByRole('dialog').first().waitFor({ state: 'visible', timeout: 30_000 })

  const repair = page.getByRole('dialog').getByRole('button', { name: /去修复第 \d+ 章的定稿后处理/ })
  const stay = page.getByRole('dialog').getByRole('button', { name: '留在蓝图' })
  log('出口按钮:', JSON.stringify({
    repairText: await repair.first().innerText().catch(() => null),
    repairCount: await repair.count(),
    stayCount: await stay.count(),
  }))
  await page.screenshot({ path: path.join(repo, '.runtime', 'qa', 'p55-popover.png') })

  log('点「去修复…」')
  await repair.first().click()
  await page.waitForTimeout(5_000)

  const dialogGone = !(await page.getByRole('dialog').first().isVisible().catch(() => false))
  const chapterOpen = await chapterView.view(page).isVisible().catch(() => false)
  const heading = await page.getByRole('heading', { level: 1 }).first().innerText().catch(() => '')
  const panelVisible = await chapterView.postProcess(page).isVisible().catch(() => false)
  const panelText = panelVisible ? await chapterView.postProcess(page).innerText().catch(() => '') : ''
  const steps = panelVisible ? await chapterView.postProcessSteps(page).catch(() => []) : []
  const buttons = panelVisible ? await chapterView.postProcess(page).getByRole('button').allInnerTexts().catch(() => []) : []

  const result = {
    dialogGone, chapterOpen, heading,
    panelVisible,
    panelText: panelText.slice(0, 900),
    steps,
    buttons,
  }
  await page.screenshot({ path: path.join(repo, '.runtime', 'qa', 'p55-after-repair.png') })
  log(JSON.stringify(result, null, 2))
  fs.writeFileSync(path.join(repo, '.runtime', 'qa', 'p55-result.json'), JSON.stringify(result, null, 2))

  await app.close().catch(() => {})
}

main().catch(e => { console.error('[p55] fatal', e); process.exitCode = 1 })
