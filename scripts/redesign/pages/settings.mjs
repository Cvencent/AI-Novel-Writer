const LEFT_RAIL = '.writer-left-rail'

export async function open(page) {
  await page.locator(LEFT_RAIL).getByRole('button', { name: '设置' }).click()
  await page.getByRole('button', { name: '关闭设置' }).waitFor({ state: 'visible' })
}

export async function close(page) {
  const button = page.getByRole('button', { name: '关闭设置' })
  await button.click()
  await button.waitFor({ state: 'hidden' })
}

export async function waitForSection(page, title) {
  await page.getByRole('heading', { name: title, level: 2, exact: true }).waitFor({ state: 'visible' })
}

/** 外观里的「界面布局」：工作台或创作流程（预览）。 */
export async function chooseShell(page, label) {
  await page.getByRole('button', { name: '外观', exact: true }).click()
  await page.getByRole('group', { name: '界面布局' }).getByRole('button', { name: label }).click()
}
