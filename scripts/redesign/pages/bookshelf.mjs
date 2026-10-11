// 书房：新建、打开作品。
const SHELF = '.writer-shelf'
const PROJECT_TREE = '.writer-project-tree'

export async function createProject(page, name) {
  await page.getByRole('button', { name: '新建作品', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '新建小说项目' })
  await dialog.getByPlaceholder('如：斗破苍穹').fill(name)
  await dialog.getByRole('button', { name: '选择', exact: true }).click()
  await dialog.getByRole('button', { name: '创建项目', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
}

export async function openProject(page, name) {
  await page.locator(SHELF).getByRole('button', { name: `打开《${name}》` }).click()
  await page.locator(PROJECT_TREE).getByText(name, { exact: true }).waitFor({ state: 'visible' })
}
