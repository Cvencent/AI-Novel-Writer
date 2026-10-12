// 新外壳的蓝图阶段与写作此章弹层（RD-7）。选择器用角色与可访问名称。
import * as stage from './stage.mjs'

export const plan = page => page.getByRole('complementary', { name: '章节规划' })
export const planItem = (page, number) => plan(page).getByRole('button', { name: new RegExp(`^${number}\\D`) })
export const card = page => page.getByRole('region', { name: /^第 \d+ 章蓝图$/ })
export const titleInput = page => card(page).getByRole('textbox', { name: '章节标题' })
export const writeButton = page => page.getByRole('button', { name: /^写第 \d+ 章$/ })
export const writeOptions = page => page.getByRole('button', { name: '本次写作选项' })
export const popover = page => page.getByRole('dialog', { name: '本次写作选项' })
export const preflight = page => popover(page).getByRole('region', { name: '一致性预检' })
export const emptyHeading = page => page.getByRole('heading', { name: '还没有章节蓝图' })

/** 从流程脊进入蓝图阶段，等章节规划或空状态出现。 */
export async function open(page) {
  await stage.stageButton(page, '蓝图').click()
  await plan(page).or(emptyHeading(page)).waitFor({ state: 'visible' })
}

/** 主按钮直接按蓝图开始写，不弹表单。 */
export async function writeNext(page) {
  await writeButton(page).click()
}

export async function openWriteOptions(page) {
  await writeOptions(page).click()
  await popover(page).waitFor({ state: 'visible' })
}

export async function pageMenu(page, item) {
  await page.getByRole('button', { name: '更多蓝图操作' }).click()
  await page.getByRole('menuitem', { name: item }).click()
}

export async function chapterMenu(page, number, item) {
  await page.getByRole('button', { name: `第 ${number} 章更多操作` }).click()
  await page.getByRole('menuitem', { name: item }).click()
}

export const confirmDialog = (page, title) => page.getByRole('dialog', { name: title })
