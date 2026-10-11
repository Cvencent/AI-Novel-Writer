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
