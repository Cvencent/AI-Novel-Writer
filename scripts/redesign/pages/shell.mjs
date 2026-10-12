// 外壳级选择器。替换外壳时只改本目录。
const SHELL_READY = '[data-shell-presentation="writer"][data-shell-variant="v3"]'
const SKIN_ROOT = '.app-skin-root'
const STARTUP_NOTICE = '[role="status"].fixed.inset-x-0.top-10'

export async function waitForShell(page, timeout) {
  await page.locator(SKIN_ROOT).waitFor({ state: 'visible', timeout })
  await page.locator(SHELL_READY).waitFor({ state: 'visible', timeout })
}

export async function dismissStartupNotice(page) {
  const acknowledge = page.locator(STARTUP_NOTICE).getByRole('button', { name: '知道了', exact: true })
  if (await acknowledge.isVisible()) await acknowledge.click()
}

/** 工作流完成提示没有角色或类名，只能从「打开查看」找到同卡片的「忽略」。审稿报告里也有「忽略」按钮，不能按名字直接点。 */
const completionToastIgnore = page =>
  page.getByRole('button', { name: '打开查看', exact: true }).locator('xpath=following-sibling::button[1]')

export async function waitForCompletionToast(page) {
  await completionToastIgnore(page).first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {})
}

/** 提示出现与自动消失的时机不固定，留着会让截图不可重复。 */
export async function dismissCompletionToasts(page) {
  for (const button of await completionToastIgnore(page).all()) await button.click().catch(() => {})
  await completionToastIgnore(page).last().waitFor({ state: 'detached' })
}

/** 首个可点击控件：书房的「新建作品」。startup-timing 以它出现为可交互时刻。 */
export function firstInteractiveControl(page) {
  return page.getByRole('button', { name: '新建作品', exact: true })
}
