// 运行面板。旧外壳里是右侧「AI 输出」，与写作助手共用 .writer-ai-panel。
import { waitForCompletionToast } from './shell.mjs'

const PANEL = '.writer-ai-panel'

const panel = page => page.locator(PANEL)

export async function open(page) {
  const header = panel(page).getByText('AI 输出', { exact: true })
  if (!await header.isVisible()) await page.getByRole('button', { name: 'AI 输出', exact: true }).click()
  await header.waitFor({ state: 'visible' })
}

export async function waitForPersistedRun(page, label) {
  await panel(page).getByRole('region', { name: '持久正文候选' }).getByText(label, { exact: true }).waitFor({ state: 'visible' })
}

export async function waitForWorkflowDone(page) {
  await panel(page).getByText('整个工作流已全部完成', { exact: true }).waitFor({ state: 'visible', timeout: 90_000 })
  await waitForCompletionToast(page)
}
