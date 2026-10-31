/**
 * 定向探针：点第 2 章的写作主按钮，看它到底弹什么、有没有真的开始生成。
 * 场景：第 1 章已定稿，第 2 章有蓝图无草稿。用户视角就是「点了没反应」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

import * as stage from '../redesign/pages/stage.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORK_ROOT = path.join(repo, '.qa', 'user-sim')
const state = JSON.parse(fs.readFileSync(path.join(WORK_ROOT, 'state.json'), 'utf8'))
const EXE = 'F:\\aiNovel\\ai-novel-writer\\AI小说作家.exe'
const log = (...args) => console.log('[probe2]', ...args)

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
  page.setDefaultTimeout(60_000)
  await page.waitForFunction(() => Boolean(window.aiNovelAPI), null, { timeout: 90_000 })
  await stage.waitForStage(page, 90_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const ack = page.locator('.startup-migration-notice').getByRole('button', { name: '知道了', exact: true })
  if (await ack.isVisible().catch(() => false)) await ack.click()

  await stage.openFromLibrary(page, state.bookName)
  await stage.stageButton(page, '蓝图').click()

  const button = page.getByRole('button', { name: /^写第 \d+ 章$/ }).first()
  await button.waitFor({ state: 'visible', timeout: 60_000 })
  const before = (await button.innerText()).trim()
  log('主按钮:', before)

  await button.click()
  const snapshots = []
  for (const waitMs of [3000, 8000, 15000]) {
    await page.waitForTimeout(waitMs)
    const dialogs = await page.getByRole('dialog').allInnerTexts().catch(() => [])
    const toasts = await page.locator('.pi-toast-stack').innerText().catch(() => '')
    const sheet = page.getByRole('complementary', { name: /^(运行|Run)$/ })
    const sheetVisible = await sheet.isVisible().catch(() => false)
    const sheetText = sheetVisible ? await sheet.innerText().catch(() => '') : ''
    snapshots.push({
      afterMs: waitMs,
      dialogs: dialogs.map(d => d.slice(0, 400)),
      toasts: toasts.slice(0, 400),
      sheetVisible,
      sheetText: sheetText.slice(0, 900),
      buttonNow: await button.innerText().catch(() => null),
    })
  }
  const out = { buttonBefore: before, snapshots }
  log(JSON.stringify(out, null, 2))
  await page.screenshot({ path: path.join(repo, '.runtime', 'qa', 'probe2-after.png') })
  fs.writeFileSync(path.join(repo, '.runtime', 'qa', 'probe2-result.json'), JSON.stringify(out, null, 2))
  await app.close().catch(() => {})
}

main().catch(error => { console.error('[probe2] fatal', error); process.exitCode = 1 })