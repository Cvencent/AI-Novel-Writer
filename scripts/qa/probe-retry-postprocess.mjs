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
const log = (...a) => console.log('[p8]', ...a)

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

  log('打开第 12 章')
  await chapterView.open(page, 12)
  const panel = chapterView.postProcess(page)
  await panel.waitFor({ state: 'visible', timeout: 60_000 })
  const before = await chapterView.postProcessSteps(page).catch(() => [])
  log('点前:', JSON.stringify(before))

  log('点「重试失败步骤」')
  const started = Date.now()
  await panel.getByRole('button', { name: '重试失败步骤', exact: true }).click()

  // 等到面板里不再出现「这一步没有执行」，或超时
  const deadline = Date.now() + 8 * 60_000
  let after = before, text = ''
  while (Date.now() < deadline) {
    await page.waitForTimeout(5_000)
    after = await chapterView.postProcessSteps(page).catch(() => after)
    text = await panel.innerText().catch(() => '')
    if (!after.some(s => s.state === 'failed') && !/没有执行/.test(text)) break
  }
  const result = {
    waitedMs: Date.now() - started,
    before, after,
    panelText: text.slice(0, 900),
    buttons: await panel.getByRole('button').allInnerTexts().catch(() => []),
  }
  await page.screenshot({ path: path.join(repo, '.runtime', 'qa', 'p8-after-retry.png') })
  log(JSON.stringify(result, null, 2))
  fs.writeFileSync(path.join(repo, '.runtime', 'qa', 'p8-result.json'), JSON.stringify(result, null, 2))
  await app.close().catch(() => {})
}
main().catch(e => { console.error('[p8] fatal', e); process.exitCode = 1 })
