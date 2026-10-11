const LEFT_RAIL = '.writer-left-rail'

export async function open(page) {
  await page.locator(LEFT_RAIL).getByRole('button', { name: '设置' }).click()
  await page.getByRole('button', { name: '关闭设置' }).waitFor({ state: 'visible' })
}
