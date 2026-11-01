// 新外壳的架构阶段与角色名单（RD-6 起）。选择器用角色与可访问名称；分节卡按 data-section 区分五节（粗纲也算一节）。
import { root, spine } from './stage.mjs'

/** 五节。arc（粗纲）不在「AI 生成架构」对话框里，所以另用 GENERATE_SECTION_NAMES 遍历对话框步骤。 */
export const SECTION_NAMES = { premise: '故事前提', characters: '角色名单', worldbuilding: '世界观', arc: '粗纲', synopsis: '情节大纲' }
export const GENERATE_SECTION_NAMES = { premise: '故事前提', characters: '角色名单', worldbuilding: '世界观', synopsis: '情节大纲' }

export const page = page => root(page).locator('.arch-page')
export const section = (page, key) => root(page).getByRole('region', { name: SECTION_NAMES[key], exact: true })
export const badge = (page, key) => section(page, key).locator('.arch-badge')
export const summary = (page, key) => section(page, key).locator('.arch-section-summary')
export const primary = page => root(page).locator('.arch-header .pi-btn--primary')
export const next = page => root(page).locator('.arch-header').getByRole('button', { name: /^下一步：章节蓝图/ })
export const dialog = page => page.getByRole('dialog', { name: '生成架构' })
export const mark = (page, key) => dialog(page).locator(`[data-step="${key}"] .arch-mark`)
/** 勾选框是视觉隐藏的原生 checkbox，点它所在的 label。 */
export const stepCheck = (page, key) => dialog(page).locator(`[data-step="${key}"] label.pi-check`)
const stepBox = (page, key) => dialog(page).locator(`[data-step="${key}"] input[type="checkbox"]`)
export const castRoster = page => root(page).getByRole('complementary', { name: '角色名单' })
export const castRow = (page, name) => castRoster(page).getByRole('button', { name: new RegExp(`^${name}`) })
export const profileName = page => root(page).locator('.cast-profile-name')

/** 从流程脊进入架构阶段，等四节与角色名单都读完。 */
export async function open(page) {
  await spine(page).getByRole('button', { name: /^架构/ }).click()
  await waitReady(page)
}

export async function waitReady(page) {
  await root(page).locator('.arch-page:not([data-loading]):not([data-cast-loading])').waitFor({ state: 'visible', timeout: 20_000 })
  await root(page).locator('.arch-section').nth(4).waitFor({ state: 'visible' })
}

export async function openSectionMenu(page, key) {
  await section(page, key).getByRole('button', { name: `「${SECTION_NAMES[key]}」的更多操作` }).click()
}

/** 在生成架构对话框里把勾选改成只有 keys 这几节。 */
export async function selectOnly(page, keys) {
  for (const key of Object.keys(GENERATE_SECTION_NAMES)) {
    if (await stepBox(page, key).isChecked() !== keys.includes(key)) await stepCheck(page, key).click()
  }
}

export async function setRange(page, from, to) {
  await dialog(page).getByRole('spinbutton', { name: '本次生成范围的起始章' }).fill(String(from))
  await dialog(page).getByRole('spinbutton', { name: '本次生成范围的结束章' }).fill(String(to))
}

export async function startGenerate(page) {
  await dialog(page).getByRole('button', { name: /^开始生成 \d+ 项$/ }).click()
  await dialog(page).waitFor({ state: 'hidden' })
}

/** 打开角色名单页：从架构阶段的「角色名单」一节进入。 */
export async function openCast(page) {
  await section(page, 'characters').getByRole('button', { name: '打开角色名单' }).click()
  await castRoster(page).waitFor({ state: 'visible' })
}

/**
 * 续写细纲（issue #46）：五节都已确认时，架构页的主按钮是**禁用的**「下一步：章节蓝图」，
 * 硬点「继续生成架构」会等满默认超时——那个按钮在这个状态下根本不存在。
 *
 * 按状态选入口，与作者实际会做的动作一致：
 * 1. 「一键生成全部剩余细纲」（细纲未覆盖全书时才有）：连续按批生成，自己算范围，不覆盖已写章节；
 * 2. 否则走「更多操作 → 一次生成全部剩余大纲…」，范围由对话框默认值（= 已有末章 + 1）给出。
 *
 * 无论走哪条，都**不显式填 1–to**：那会把已写好的章节整批重写（issue #46 的第二处危险）。
 * 返回实际走的入口，失败时把当时的按钮文案带进错误里，便于下一轮定位。
 */
export async function continueSynopsis(page, { timeout = 180_000 } = {}) {
  const continuous = page.getByRole('button', { name: '一键生成全部剩余细纲' })
  if (await continuous.count() > 0) {
    await continuous.first().click({ timeout })
    return 'continuous'
  }
  await openSectionMenu(page, 'synopsis')
  const entry = page.getByRole('menuitem', { name: /^一次生成全部剩余大纲/ })
  try {
    await entry.waitFor({ state: 'visible', timeout: 15_000 })
  } catch (error) {
    const buttons = await page.getByRole('button').allInnerTexts().catch(() => [])
    throw new Error(`细纲续写入口不存在；当前按钮：${buttons.join(' | ')}`)
  }
  await entry.click({ timeout })
  await dialog(page).waitFor({ state: 'visible', timeout: 15_000 })
  return 'dialog'
}
