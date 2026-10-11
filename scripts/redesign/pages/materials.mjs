// 作品资料导入：知识库创作资料与角色卡。两者都会在确认发送后启动提取工作流。
async function confirmSend(page) {
  await page.getByRole('button', { name: '发送并提取', exact: true }).click()
}

export async function importPlanningMaterial(page) {
  await page.getByRole('button', { name: '导入创作资料' }).click()
  await confirmSend(page)
}

export async function importCharacterCards(page, source) {
  await page.getByRole('button', { name: '粘贴 / 导入角色卡' }).first().click()
  await page.getByLabel('角色卡全文').fill(source)
  await page.getByRole('button', { name: 'AI 提取并预览' }).click()
  await confirmSend(page)
}
