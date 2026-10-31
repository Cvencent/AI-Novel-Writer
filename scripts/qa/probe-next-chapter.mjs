/**
 * 定点探针：在常驻测试书上「接着写下一章」，观察是否真的产生运行。
 * 用于区分「产品在已有运行残留时静默拒绝新运行」与「harness 选择器问题」。
 *
 * 只读地观察 + 点击，不改动任何作品内容以外的数据；工作区固定在 .qa/user-sim。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

import * as blueprintPage from '../redesign/pages/blueprint.mjs'
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

const log = (...args) => console.log('[probe]', ...args)

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
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'AI_NOVEL_SMOKE_OPEN_PROJECT']) delete env[key]

  const app = await electron.launch({
    executablePath: EXE,
    args: [`--user-data-dir=${path.join(WORK_ROOT, 'userData')}`, '--lang=zh-CN'],
    env, timeout: 90_000,
  })
  const page = await app.firstWindow({ timeout: 90_000 })
  page.setDefaultTimeout(60_000)
  await page.waitForFunction(() => Boolean(window.aiNovelAPI), null, { timeout: 90_000 })
  await stage.waitForStage(page, 90_000)
  await page.setViewportSize({ width: 1440, height: 900 })

  const ack = page.locator('.startup-migration-notice').getByRole('button', { name: '知道了', exact: true })
  if (await ack.isVisible().catch(() => false)) await ack.click()

  log('打开常驻测试书', state.bookName)
  await stage.openFromLibrary(page, state.bookName)

  log('进入蓝图页')
  await stage.stageButton(page, '蓝图').click()
  await blueprintPage.plan(page).waitFor({ state: 'visible', timeout: 60_000 })

  const writeButton = page.getByRole('button', { name: /^写第 \d+ 章$/ })
  const label = await writeButton.first().getAttribute('aria-label').catch(() => null)
  const text = await writeButton.first().innerText().catch(() => null)
  const disabled = await writeButton.first().isDisabled().catch(() => null)
  log('主按钮', JSON.stringify({ label, text, disabled }))
  await page.screenshot({ path: path.join(repo, '.runtime', 'qa', 'probe-before.png') })

  log('点击写作按钮')
  await writeButton.first().click()
  await page.waitForTimeout(20_000)

  const body = await page.evaluate(() => document.body.innerText)
  const toasts = await page.locator('.pi-toast-stack').innerText().catch(() => '')
  const dialogs = await page.getByRole('dialog').allInnerTexts().catch(() => [])
  const runSheetVisible = await page.getByRole('complementary', { name: /^(运行|Run)$/ }).isVisible().catch(() => false)
  const runSheetText = runSheetVisible
    ? await page.getByRole('complementary', { name: /^(运行|Run)$/ }).innerText().catch(() => '')
    : ''
  await page.screenshot({ path: path.join(repo, '.runtime', 'qa', 'probe-after.png') })

  const result = {
    label, text, disabled,
    toasts: toasts.slice(0, 800),
    dialogs: dialogs.map(item => item.slice(0, 600)),
    runSheetVisible,
    runSheetText: runSheetText.slice(0, 1500),
    bodyExcerpt: body.slice(0, 1200),
  }
  log(JSON.stringify(result, null, 2))
  fs.writeFileSync(path.join(repo, '.runtime', 'qa', 'probe-result.json'), JSON.stringify(result, null, 2))

  await app.close().catch(() => {})
}

main().catch(error => { console.error('[probe] fatal', error); process.exitCode = 1 })