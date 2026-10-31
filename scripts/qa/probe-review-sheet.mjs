/**
 * 定点探针：审稿结果已在库里时，界面上能不能看到审稿报告。
 * 用于区分「审稿面板不出（产品 bug）」与「只是生成慢（harness 超时太短）」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

import * as chapterView from '../redesign/pages/chapter-view.mjs'
import * as stage from '../redesign/pages/stage.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORK_ROOT = path.join(repo, '.qa', 'user-sim')
const state = JSON.parse(fs.readFileSync(path.join(WORK_ROOT, 'state.json'), 'utf8'))
const EXE = 'F:\\aiNovel\\ai-novel-writer\\AI小说作家.exe'
const MODEL = {
  id: 'qa-deepseek-flash', name: 'QA DeepSeek V4.1 Flash', provider: 'custom', protocol: 'openai',
  modelName: 'deepseek-v4.1-flash', apiKey: 'test_key', baseUrl: 'http://127.0.0.1:8790/v1',
  temperature: 0.7, maxTokens: 32768, purposes: ['generation', 'refinement', 'summary'],
}
const chapter = Number(process.argv.find(a => a.startsWith('--chapter='))?.split('=')[1] ?? 1)
const log = (...args) => console.log('[review-probe]', ...args)

async function main() {
  const env = {
    ...process.env,
    AI_NOVEL_APP_DATA_HOME: path.join(WORK_ROOT, 'appData'),
    AI_NOVEL_LEGACY_SOURCE_HOME: path.join(WORK_ROOT, 'legacy'),
    HOME: path.join(WORK_ROOT, 'home'), USERPROFILE: path.join(WORK_ROOT, 'home'),
    LOCALAPPDATA: path.join(WORK_ROOT, 'localappdata'),
    APPDATA: path.join(WORK_ROOT, 'appdata-roaming'),
    TEMP: path.join(WORK_ROOT, 'temp'), TMP: path.join(WORK_ROOT, 'temp'),
  }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) delete env[key]

  const app = await electron.launch({
    executablePath: EXE,
    args: [`--user-data-dir=${path.join(WORK_ROOT, 'userData')}`, '--lang=zh-CN'],
    env, timeout: 90_000,
  })
  const page = await app.firstWindow({ timeout: 90_000 })
  page.setDefaultTimeout(120_000)
  await page.waitForFunction(() => Boolean(window.aiNovelAPI), null, { timeout: 90_000 })
  await stage.waitForStage(page, 90_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const ack = page.locator('.startup-migration-notice').getByRole('button', { name: '知道了', exact: true })
  if (await ack.isVisible().catch(() => false)) await ack.click()

  await stage.openFromLibrary(page, state.bookName)

  const result = { chapter, openedAt: Date.now() }
  log(`打开第 ${chapter} 章`)
  await chapterView.open(page, chapter)
  await page.waitForTimeout(3000)

  // 库里已有审稿记录时，面板是否自己出现（不该要用户再点一次审稿）
  result.sheetAutoVisible = await chapterView.reviewSheet(page).isVisible().catch(() => false)
  result.sheetWaitMs = null
  if (!result.sheetAutoVisible) {
    const started = Date.now()
    await chapterView.reviewSheet(page).waitFor({ state: 'visible', timeout: 90_000 })
      .then(() => { result.sheetWaitMs = Date.now() - started })
      .catch(() => { result.sheetWaitMs = 'timeout-90s' })
  }
  result.sheetTextExcerpt = await chapterView.reviewSheet(page).innerText().catch(() => '').then(t => t.slice(0, 700))
  result.primaryButtons = await page.locator('.pi-btn--primary').evaluateAll(btns => btns.filter(b => b.getClientRects().length).map(b => b.textContent.trim()))
  result.lifecycle = await chapterView.lifecycleCurrent(page).innerText().catch(() => null)
  await page.screenshot({ path: path.join(repo, '.runtime', 'qa', 'probe-review.png') })
  log(JSON.stringify(result, null, 2))
  fs.writeFileSync(path.join(repo, '.runtime', 'qa', 'probe-review.json'), JSON.stringify(result, null, 2))
  await app.close().catch(() => {})
}

main().catch(error => { console.error('[review-probe] fatal', error); process.exitCode = 1 })