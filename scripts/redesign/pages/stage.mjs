// 新外壳（流程脊）。选择器用角色与可访问名称；只有正文编辑区沿用 CodeMirror 的 .cm-content。
const SHELL = '[data-shell-presentation="stage"]'

export const root = page => page.locator(SHELL)
export const spine = page => page.getByRole('navigation', { name: '创作流程' })
export const chapterList = page => spine(page).getByRole('list', { name: '章节' })
export const tabList = page => page.getByRole('tablist', { name: '已打开的页面' })
export const prose = page => page.locator(`${SHELL} .stage-content .cm-content`)

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 阶段行的可访问名称以阶段名开头，后面是状态说明。 */
export const stageButton = (page, name) => spine(page).getByRole('button', { name: new RegExp(`^${escape(name)}`) })

/** 阶段行上的状态：done、active 或 todo。 */
export async function stageStates(page) {
  return spine(page).locator('[data-stage]').evaluateAll(rows => Object.fromEntries(rows.map(row => [row.dataset.stage, row.dataset.state])))
}

export const chapterButton = (page, number) => chapterList(page).getByRole('button', { name: new RegExp(`^${number}\\D`) })

/** 章节列表每行的章号、所处阶段与是否为当前章。 */
export async function chapterRows(page) {
  return chapterList(page).getByRole('button').evaluateAll(rows => rows.map(row => ({
    number: Number(row.querySelector('.stage-chapter-no')?.textContent),
    phase: row.dataset.phase,
    current: row.getAttribute('aria-current') === 'page',
  })))
}

/** 从书房打开作品，等流程脊与落点页出现。 */
export async function openFromLibrary(page, name) {
  await page.locator('.writer-shelf').getByRole('button', { name: `打开《${name}》` }).click()
  await spine(page).waitFor({ state: 'visible' })
}

export async function waitForProse(page, text) {
  await prose(page).getByText(text).first().waitFor({ state: 'visible', timeout: 20_000 })
}

export const tab = (page, name) => tabList(page).getByRole('tab', { name })
export const closeTabButton = (page, name) => tabList(page).getByRole('button', { name: new RegExp(`^关闭「${escape(name)}」`) })

export const saveStatus = page => root(page).getByRole('banner').getByRole('status')

export const focusToggle = page => page.getByRole('button', { name: /^(进入|退出)沉浸写作$/ })

export const palette = page => page.getByRole('dialog', { name: /^(搜索与跳转|查找章节)$/ })
export const paletteInput = page => palette(page).getByRole('combobox')

export async function findChapter(page, query) {
  await page.keyboard.press('Control+P')
  await paletteInput(page).waitFor({ state: 'visible' })
  await paletteInput(page).fill(query)
  await page.keyboard.press('Enter')
  await palette(page).waitFor({ state: 'hidden' })
}

export const capsule = page => root(page).getByRole('button', { expanded: false }).filter({ hasText: /运行中|%|等你确认/ }).first()
