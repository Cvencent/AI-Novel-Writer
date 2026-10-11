// 运行面板。旧外壳里是「AI 输出」侧栏。
const PANEL = '.writer-ai-panel'

export const panel = page => page.locator(PANEL)

export async function open(page) {
  if (!await panel(page).isVisible()) await page.getByTitle('AI 输出', { exact: true }).click()
  await panel(page).waitFor({ state: 'visible' })
}

/** 等工作流完成，并关掉完成提示；提示出现的时机不固定，留着会让截图不可重复。 */
export async function waitForWorkflowDone(page) {
  await panel(page).getByText('整个工作流已全部完成', { exact: true }).waitFor({ state: 'visible', timeout: 90_000 })
  const toast = page.getByRole('button', { name: '忽略', exact: true })
  await toast.waitFor({ state: 'visible', timeout: 5_000 }).then(() => toast.click(), () => {})
}
