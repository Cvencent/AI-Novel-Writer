// 新外壳的蓝图阶段与写作此章弹层（RD-7）。选择器用角色与可访问名称。
import * as stage from './stage.mjs'
import * as runSheet from './run-sheet.mjs'

export const plan = page => page.getByRole('complementary', { name: '章节规划' })
export const planItem = (page, number) => plan(page).getByRole('button', { name: new RegExp(`^${number}\\D`) })
export const card = page => page.getByRole('region', { name: /^第 \d+ 章蓝图$/ })
export const titleInput = page => card(page).getByRole('textbox', { name: '章节标题' })
export const writeButton = page => page.getByRole('button', { name: /^写第 \d+ 章$/ })
export const writeOptions = page => page.getByRole('button', { name: '本次写作选项' })
export const popover = page => page.getByRole('dialog', { name: '本次写作选项' })
export const preflight = page => popover(page).getByRole('region', { name: '一致性预检' })
export const emptyHeading = page => page.getByRole('heading', { name: '还没有章节蓝图' })

/**
 * 从流程脊进入蓝图阶段，等章节规划或空状态出现。
 * 等待时长显式给出（issue #50 建议 3）：默认 setDefaultTimeout(120s) 会让一个隐性卡顿
 * 白白吃掉 120 秒，而蓝图页出现只需十几秒；超时信息里带上当时的路径，便于下一轮定位。
 */
export async function open(page, { timeout = 30_000 } = {}) {
  await stage.stageButton(page, '蓝图').click({ timeout })
  await plan(page).or(emptyHeading(page)).waitFor({ state: 'visible', timeout })
}

/** 主按钮直接按蓝图开始写，不弹表单。 */
export async function writeNext(page) {
  await writeButton(page).click()
}

export async function openWriteOptions(page) {
  await writeOptions(page).click()
  await popover(page).waitFor({ state: 'visible' })
}

export async function pageMenu(page, item) {
  await page.getByRole('button', { name: '更多蓝图操作' }).click()
  await page.getByRole('menuitem', { name: item }).click()
}

export const confirmDialog = (page, title) => page.getByRole('dialog', { name: title })

export const generateDialog = page => page.getByRole('dialog', { name: 'AI 生成蓝图' })
export const batchDialog = page => page.getByRole('dialog', { name: '批量创作' })

/** 打开 AI 生成蓝图；existing 为 'append' 或 'full'（覆盖），只在已有蓝图时出现。 */
export async function openGenerate(page) {
  await page.getByRole('button', { name: 'AI 生成蓝图' }).click()
  await generateDialog(page).getByRole('button', { name: '开始生成', disabled: false }).waitFor({ state: 'visible' })
}

/**
 * 生成第 from～to 章蓝图（指定范围，保留已有），返回是否经过「架构还不完整」。
 * 运行开始时运行侧页自动展开，以它为「生成已开始」；侧页先开着就分不出来。
 * 因此调用前先把它收起——这正是作者会做的动作，也让上一步（粗纲续生成）
 * 留下的侧页不会把本轮后续步骤全挡死（issue #39）。
 */
export async function generateRange(page, from, to) {
  if (await runSheet.sheet(page).isVisible()) await runSheet.closeIfOpen(page)
  await openGenerate(page)
  const dialog = generateDialog(page)
  // issue #235：#232 之后起止章默认 disabled（要先选「第…章至第…章」单选才可编辑）。
  // 先读合同再操作：若起点输入框 disabled，先点范围单选；顺便把合同状态记进日志，
  // 未来交互合同再变时能在 call log 里直接看到原因。
  const startInput = dialog.getByLabel('蓝图起始章')
  if (await startInput.isDisabled()) {
    await dialog.getByRole('radio').nth(1).check()
    console.log('[blueprint.generateRange] start input was disabled; switched to range mode (issue #235)')
  }
  await startInput.fill(String(from))
  await dialog.getByLabel('蓝图结束章').fill(String(to))
  await dialog.getByRole('button', { name: '开始生成' }).click()
  // 生成对话框收起后警告才出现；先等它收起，否则「对话框或警告」会先命中还在卸载的对话框。
  await dialog.waitFor({ state: 'hidden' })
  const warning = page.getByRole('dialog', { name: '架构还不完整' })
  try {
    await warning.or(runSheet.sheet(page)).first().waitFor({ state: 'visible', timeout: 60_000 })
  } catch (error) {
    const body = await page.locator('body').innerText().catch(() => '<unreadable>')
    console.log('[blueprint.generateRange] neither warning nor run sheet appeared; body:', body.slice(0, 800).replace(/\n+/g, ' | '))
    throw error
  }
  if (!await warning.isVisible()) return false
  await warning.getByRole('button', { name: '继续生成' }).click()
  return true
}

/**
 * 点「写第 N 章」之后处理可能出现的「一致性预检」弹层（issue #53）。
 *
 * 预检有提醒时应用**不会**直接开写，而是把弹层打开、把「带提醒继续写」做成显式按钮——
 * 产品行为是对的，但 harness 若点完主按钮就去等运行，就会永远停在这一层
 * （本轮实测等了 6 分钟、零 chapter-draft 调用）。
 *
 * 这里按状态判断：弹层出现且带该按钮就点它（= 作者会做的动作），并返回提醒条数与首条摘要，
 * 供报告留痕；三点都判不到时返回 no-dialog（正常章节没有提醒时就是这个形态）。
 */
export async function continuePastPreflight(page, { timeout = 3_000 } = {}) {
  // 用 :visible 限定：本页同时可能存在「本次写作选项」这类 role=dialog 的弹层。
  const dialog = page.locator('[role="dialog"]:visible').first()
  const visible = await dialog.waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false)
  /**
   * `no-dialog` 也要能说出来（issue #210）。
   *
   * 原来三种 outcome 里只有前两种由调用方写日志，`no-dialog` 什么都不留：
   * 于是日志里「点完就跳到停滞」，看不出中间发生过什么。它本身就是诊断信息
   * （是弹层没出现、还是晚于 3 秒才出现），必须带回给调用方。
   */
  if (!visible) return { outcome: 'no-dialog', waitedMs: timeout }
  const summary = await dialog.innerText().catch(() => '')
  const go = dialog.getByRole('button', { name: /^(带提醒继续写|Continue with reminders)$/ })
  if (await go.count().catch(() => 0) === 0) return { outcome: 'no-continue-button', summary: summary.slice(0, 400) }
  await go.first().click({ timeout: 15_000 })
  return { outcome: 'continued', summary: summary.slice(0, 400) }
}

/** 批量创作 count 章，模型用默认，写完留作草稿。 */
export async function startBatch(page, count) {
  await page.getByRole('button', { name: '批量创作' }).click()
  const dialog = batchDialog(page)
  await dialog.getByLabel(/写几章/).fill(String(count))
  await dialog.getByRole('button', { name: `开始写 ${count} 章` }).click()
}
