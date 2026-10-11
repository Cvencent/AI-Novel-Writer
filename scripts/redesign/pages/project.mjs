// 作品内导航：项目树。
const PROJECT_TREE = '.writer-project-tree'

export const tree = page => page.locator(PROJECT_TREE)

export async function openNode(page, label) {
  await tree(page).getByText(label, { exact: true }).click()
}

export async function openBlueprints(page) {
  await openNode(page, '章节蓝图')
  await page.getByRole('button', { name: '写作此章' }).waitFor({ state: 'visible' })
}

/** 打开作品后项目树统一刷新文件树、架构状态、草稿与蓝图数量；结束时蓝图徽标显示数量，刷新按钮恢复可用。 */
export async function waitForTreeRefreshed(page, blueprintCount) {
  await tree(page).getByText(new RegExp(`^${blueprintCount}/\\d+ 章$`)).waitFor({ state: 'visible' })
  await tree(page).getByRole('button', { name: '刷新', disabled: false }).waitFor({ state: 'visible' })
}

/** 同一章的草稿在项目树里按版本倒序排列，第一个即最新一稿。 */
export async function openLatestDraft(page) {
  await tree(page).getByText(/^草稿_v[0-9]+$/).first().click()
}
