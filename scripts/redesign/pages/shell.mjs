// 外壳级选择器。RD-3 替换外壳时只改本目录。
export const SHELL_READY = '[data-shell-presentation="writer"][data-shell-variant="v3"]'
const SKIN_ROOT = '.app-skin-root'
const STARTUP_NOTICE = '[role="status"].fixed.inset-x-0.top-10'

export async function waitForShell(page, timeout) {
  await page.locator(SKIN_ROOT).waitFor({ state: 'visible', timeout })
  await page.locator(SHELL_READY).waitFor({ state: 'visible', timeout })
}

export async function dismissStartupNotice(page) {
  const notice = page.locator(STARTUP_NOTICE)
  if (await notice.isVisible()) await notice.getByRole('button', { name: '知道了', exact: true }).click()
}

/** 首个可点击控件：书房的「新建作品」。startup-timing 以它出现为可交互时刻。 */
export function firstInteractiveControl(page) {
  return page.getByRole('button', { name: '新建作品' }).first()
}
