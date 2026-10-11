// 运行面板。旧外壳里是右侧「AI 输出」，与写作助手共用 .writer-ai-panel。
const PANEL = '.writer-ai-panel'

export const panel = page => page.locator(PANEL)

export async function open(page) {
  const header = panel(page).getByText('AI 输出', { exact: true })
  if (!await header.isVisible()) await page.getByRole('button', { name: 'AI 输出', exact: true }).click()
  await header.waitFor({ state: 'visible' })
}

export async function waitForPersistedRun(page, label) {
  await panel(page).getByRole('region', { name: '持久正文候选' }).getByText(label, { exact: true }).waitFor({ state: 'visible' })
}

/** 等工作流完成，并关掉完成提示；提示出现的时机不固定，留着会让截图不可重复。 */
export async function waitForWorkflowDone(page) {
  await panel(page).getByText('整个工作流已全部完成', { exact: true }).waitFor({ state: 'visible', timeout: 90_000 })
  const toast = page.getByRole('button', { name: '忽略', exact: true })
  await toast.waitFor({ state: 'visible', timeout: 5_000 }).then(() => toast.click(), () => {})
}
