// RD-8 正文单章视图的实机场景：对应计划 RD-8 的 live lane 1～10、perf 的 chapter-open 与 typing-latency，以及评审导览。
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

import { FAKE_MODEL, FIXTURE_PROSE } from './fake-model.mjs'
import * as chapter from './pages/chapter.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as project from './pages/project.mjs'
import * as runPanel from './pages/run-panel.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { firstLine, seedStageSample } from './scenarios.mjs'
import { countUnits, STAGE_SAMPLE } from './stage-sample.mjs'

const isStage = async page => await stage.root(page).count() > 0

/** 预置示例作品；remember 把作品路径记进场景上下文，结束时据此重新打开作品读数据库。 */
const seed = ({ deleteChapters = [], extra } = {}) => context => seedStageSample(context, {
  landOnChapter3: deleteChapters.length === 0,
  beforeReload: async args => {
    const { page, invoke, path, session } = args
    context.projectPath = path
    for (const chapterNumber of deleteChapters) {
      for (const draft of await invoke(page, 'db:draft-list', chapterNumber, path, session)) {
        assert.equal((await invoke(page, 'db:draft-delete', draft.id, path, session)).success, true)
      }
    }
    await extra?.(args)
  },
})

async function createDraft({ page, invoke, path, session }, chapterNumber, version, text) {
  const created = await invoke(page, 'db:draft-create', { chapterNumber, version, source: version > 1 ? 'rewrite' : 'write', content: text, wordCount: countUnits(text) }, path, session)
  assert.equal(created.success, true, created.error)
}

/** 界面打开作品后会话租约换了新的；核对数据库时回到书房，由驱动自己再打开一次拿会话。 */
async function reopenForReading({ page, invoke, reload, projectPath }) {
  await reload()
  const opened = await invoke(page, 'project:open', projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  return { projectId: opened.project.id, projectPath, leaseId: opened.project.sessionLease }
}

/** 第 n 章定稿正文的摘要与后处理各步的成败，两种外壳都从数据库读。 */
async function finalizedFacts(context, chapterNumber) {
  const { page, invoke, projectPath } = context
  const session = await reopenForReading(context)
  const drafts = await invoke(page, 'db:draft-list', chapterNumber, projectPath, session)
  const finalized = drafts.find(draft => draft.status === 'finalized')
  assert.ok(finalized, `第 ${chapterNumber} 章已定稿`)
  const full = await invoke(page, 'db:draft-get-full', finalized.id, projectPath, session)
  const run = await invoke(page, 'db:post-process-get-latest-run', 'chapter_finalize', String(chapterNumber), projectPath, session)
  const steps = run ? await invoke(page, 'db:post-process-get-steps', run.id, projectPath, session) : []
  return {
    contentSha256: createHash('sha256').update(full.content).digest('hex'),
    content: full.content,
    steps: steps.map(step => ({ key: step.stepKey, ok: Boolean(step.ok) })).sort((a, b) => a.key.localeCompare(b.key)),
  }
}

async function waitRunDone(page) {
  if (await isStage(page)) await runSheet.waitForRunDone(page)
  else await runPanel.waitForWorkflowDone(page)
}

/** 两种外壳各自写第 3 章：新外壳在待写章的单章视图点「写作此章」，旧外壳从章节蓝图的「写作第3章」对话框直接开始。 */
async function writeChapter3(page) {
  if (await isStage(page)) {
    await chapterView.open(page, 3)
    await chapterView.view(page).getByRole('button', { name: '写作此章', exact: true }).click()
    await runSheet.waitUntilOpen(page)
    await waitRunDone(page)
    await chapterView.prose(page).getByText(firstLine(FIXTURE_PROSE)).first().waitFor({ state: 'visible', timeout: 30_000 })
    return
  }
  await project.openNode(page, '章节蓝图')
  await page.getByRole('button', { name: /^写作第3章$/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: '开始创作' }).click()
  await waitRunDone(page)
  await chapter.editor(page).getByText(firstLine(FIXTURE_PROSE)).first().waitFor({ state: 'visible', timeout: 30_000 })
}

/** 新外壳：审稿、按意见修稿、等合并视图。 */
async function reviewAndRevise(page) {
  await chapterView.review(page)
  await waitRunDone(page)
  await chapterView.reviseButton(page).click()
  await chapterView.merge(page).waitFor({ state: 'visible', timeout: 60_000 })
  await waitRunDone(page)
}

/** 两种外壳各自走完审稿、按意见修稿、全部用修稿合并、等合并后复验、定稿。 */
async function reviewReviseMergeFinalize(page) {
  if (await isStage(page)) {
    await reviewAndRevise(page)
    await chapterView.merge(page).getByRole('button', { name: '全部用修稿' }).click()
    await chapterView.merge(page).getByRole('button', { name: '完成合并' }).click()
    await chapterView.view(page).getByRole('button', { name: '定稿', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    await waitRunDone(page)
    await chapterView.finalize(page, 3)
    await chapterView.postProcess(page).waitFor({ state: 'visible', timeout: 60_000 })
    await waitRunDone(page)
    return
  }
  await chapter.review(page)
  await chapter.reviseFromReview(page, FAKE_MODEL.id)
  await chapter.mergeDialog(page).waitFor({ state: 'visible', timeout: 60_000 })
  await chapter.completeMerge(page)
  await waitRunDone(page)
  await project.draftOfChapter(page, 3).click()
  await chapter.finalize(page, 3)
  await waitRunDone(page)
}

/** 计时：点击 target 到正文出现 text 且所在滚动区可以滚动。frameMs 按动画帧检查，domMs 在 DOM 变化回调里记，不依赖动画帧。 */
async function openTiming(page, target, text) {
  const handle = await target.elementHandle()
  await page.evaluate(({ element, text }) => {
    let clickedAt = null
    let domMs = null
    element.addEventListener('click', () => { clickedAt ??= performance.now() }, { capture: true, once: true })
    const ready = () => {
      const content = [...document.querySelectorAll('.cm-content')].find(node => node.textContent.includes(text) && node.getClientRects().length > 0)
      if (!content) return false
      for (let node = content; node; node = node.parentElement) {
        const overflow = getComputedStyle(node).overflowY
        if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight + 1) return true
      }
      return false
    }
    const observer = new MutationObserver(() => {
      if (clickedAt !== null && domMs === null && ready()) domMs = Math.round(performance.now() - clickedAt)
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true })
    window.__driveOpen = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('20 秒内正文没有出现')), 20_000)
      const tick = () => {
        if (clickedAt !== null && ready()) {
          clearTimeout(deadline)
          observer.disconnect()
          const frameMs = Math.round(performance.now() - clickedAt)
          resolve({ frameMs, domMs: domMs ?? frameMs })
        } else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, { element: handle, text })
  await target.click()
  return page.evaluate(() => window.__driveOpen)
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]
}

/**
 * 按键到渲染：每个按键从 beforeinput 起，到正文 DOM 里出现这个字（MutationObserver 回调，domMs），
 * 再到其后第一帧（frameMs）。屏幕外窗口的动画帧可能被节流，两种口径都报。
 */
async function typingLatency(page, content, keys) {
  await content.evaluate(element => {
    window.__driveTyping = []
    let pending = null
    element.addEventListener('beforeinput', () => { pending = { start: performance.now() } }, { capture: true })
    new MutationObserver(() => {
      if (!pending || pending.dom !== undefined) return
      const current = pending
      current.dom = performance.now() - current.start
      requestAnimationFrame(() => {
        window.__driveTyping.push({ domMs: current.dom, frameMs: performance.now() - current.start })
      })
    }).observe(element, { childList: true, subtree: true, characterData: true })
  })
  for (const key of keys) {
    await page.keyboard.type(key)
    await page.waitForTimeout(60)
  }
  await page.waitForTimeout(300)
  const samples = await page.evaluate(() => window.__driveTyping)
  assert.ok(samples.length >= keys.length * 0.9, `只记到 ${samples.length} 次按键`)
  const round = value => Math.round(value * 10) / 10
  return {
    keys: samples.length,
    domP95Ms: round(percentile(samples.map(sample => sample.domMs), 0.95)),
    frameP95Ms: round(percentile(samples.map(sample => sample.frameMs), 0.95)),
    domMedianMs: round(percentile(samples.map(sample => sample.domMs), 0.5)),
    frameMedianMs: round(percentile(samples.map(sample => sample.frameMs), 0.5)),
  }
}

/** 正文里第一段长段落的第一个视觉行放了几个字：逐字取位置，换行时停。 */
function charsPerLine(page) {
  return chapterView.prose(page).evaluate(content => {
    const line = [...content.querySelectorAll('.cm-line')].find(node => (node.textContent ?? '').length > 60)
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    let top = null
    let count = 0
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (let index = 0; index < node.textContent.length; index++) {
        range.setStart(node, index)
        range.setEnd(node, index + 1)
        const rect = range.getBoundingClientRect()
        if (top === null) top = rect.top
        if (rect.top > top + 4) return count
        count++
      }
    }
    return count
  })
}

const LONG_CHAPTER = 5
/** 1 万字的第 5 章草稿：50 段，每段 200 字，段首带段号便于定位。 */
const LONG_TEXT = Array.from({ length: 50 }, (_, index) => {
  const head = `第${index + 1}段。`
  return head + '雾是从海面上一层一层爬上来的林岚把潮汐表压在值班室的窗台上用铅笔圈出昨夜的那一格钟声比往常早了一刻潮水却没有任何变化'.repeat(4).slice(0, 200 - head.length)
}).join('\n\n')

/** 打开 1 万字的第 5 章：新外壳点流程脊里的章，旧外壳点草稿箱里的草稿。 */
async function openLongChapter(page) {
  const target = await isStage(page) ? stage.chapterButton(page, LONG_CHAPTER) : project.draftOfChapter(page, LONG_CHAPTER)
  await target.scrollIntoViewIfNeeded()
  await target.hover()
  await page.waitForTimeout(300)
  return openTiming(page, target, '第1段。')
}

const proseOf = async page => await isStage(page) ? chapterView.prose(page) : chapter.editor(page)

/** 合并视图里每处改动当前选中的那一栏的文字。 */
const chosenTexts = page => chapterView.merge(page).locator('[data-chosen="true"]').allInnerTexts()

export const CHAPTER_SCENARIOS = {
  /** lane 1：同一章在 trunk（旧外壳，--app-root）与 head（新外壳，--shell stage）走完写作、审稿、修稿、合并、定稿；两边 measured 相同即通过。 */
  'chapter-regression': { model: true, setup: seed({ deleteChapters: [3, 4] }), run: async context => {
    await writeChapter3(context.page)
    await reviewReviseMergeFinalize(context.page)
    const shell = await isStage(context.page) ? 'stage' : 'writer'
    return { shell, ...await finalizedFacts(context, 3) }
  } },

  /** lane 2：草稿状态的主按钮是 AI 审稿，生命周期停在审稿。 */
  'chapter-draft': { model: false, shell: 'stage', setup: seed(), run: async ({ page }) => {
    await chapterView.open(page, 4)
    await chapterView.prose(page).getByText(firstLine(STAGE_SAMPLE.drafts[4].text)).waitFor({ state: 'visible' })
    assert.equal(await chapterView.primary(page).innerText(), 'AI 审稿')
    assert.equal(await chapterView.lifecycleCurrent(page).innerText(), '审稿')
    assert.match(await chapterView.versionButton(page).innerText(), /^草稿 v1 · \d+ 字/)
  } },

  /** lane 3：审稿后侧页展开，勾选数与主按钮「按 N 项意见修稿」、侧页底部计数同步。 */
  'chapter-review': { model: true, shell: 'stage', setup: seed(), run: async ({ page }) => {
    await chapterView.open(page, 4)
    await chapterView.review(page)
    await waitRunDone(page)
    const sheet = chapterView.reviewSheet(page)
    const counts = async () => ({ button: await chapterView.reviseButton(page).innerText(), footer: await sheet.locator('.stage-ch-sheet-count').innerText() })
    const total = await sheet.getByRole('checkbox').count()
    const before = await counts()
    await sheet.getByRole('checkbox').first().uncheck({ force: true })
    const unchecked = await counts()
    await sheet.getByRole('checkbox').first().check({ force: true })
    const rechecked = await counts()
    assert.deepEqual({ before, unchecked, rechecked }, {
      before: { button: '按 1 项意见修稿', footer: `1 / ${total}` },
      unchecked: { button: '按 0 项意见修稿', footer: `0 / ${total}` },
      rechecked: { button: '按 1 项意见修稿', footer: `1 / ${total}` },
    }, '勾选数与主按钮、侧页计数同步')
    assert.equal(await chapterView.reviseButton(page).isEnabled(), true)
  } },

  /** lane 4：添加作者意见后修稿，修稿请求里带着这条意见。 */
  'chapter-manual': { model: true, shell: 'stage', setup: seed(), run: async ({ page, fake }) => {
    await chapterView.open(page, 4)
    await chapterView.review(page)
    await waitRunDone(page)
    const note = '守塔人的咳嗽要提前到第一段出现。'
    await chapterView.reviewSheet(page).getByRole('button', { name: '添加我的意见' }).click()
    await chapterView.reviewSheet(page).getByRole('textbox', { name: '审稿问题' }).fill(note)
    assert.equal(await chapterView.reviseButton(page).innerText(), '按 2 项意见修稿')
    await chapterView.reviseButton(page).click()
    await chapterView.merge(page).waitFor({ state: 'visible', timeout: 60_000 })
    const revision = fake.chats.find(chat => chat.kind === 'revision')
    assert.ok(revision, '假模型收到了修稿请求')
    assert.ok(JSON.stringify(revision.messages).includes(note), '人工意见进入了修稿输入')
  } },

  /** lane 5：合并视图逐段选择后完成合并，草稿正文里是选中的那些文字。 */
  'chapter-merge': { model: true, shell: 'stage', setup: seed(), run: async context => {
    const { page } = context
    await chapterView.open(page, 4)
    await reviewAndRevise(page)
    const groups = chapterView.merge(page).getByRole('group', { name: /用哪一版$/ })
    const hunks = await groups.count()
    assert.ok(hunks >= 1, '修稿至少有一处改动')
    await groups.first().getByRole('button', { name: '用修稿' }).click()
    const manual = '（作者手改的一段。）'
    if (hunks > 1) {
      await groups.nth(1).getByRole('button', { name: '手动编辑' }).click()
      await chapterView.merge(page).getByRole('textbox').first().fill(manual)
    }
    context.chosen = await chosenTexts(page)
    context.manual = hunks > 1 ? manual : null
    return { hunks, chosen: context.chosen }
  }, after: async ({ page, chosen, manual }) => {
    await chapterView.merge(page).getByRole('button', { name: '完成合并' }).click()
    await chapterView.view(page).getByRole('button', { name: '定稿', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    const merged = (await chapterView.prose(page).innerText()).replace(/\s+/g, '')
    for (const text of chosen) assert.ok(merged.includes(text.replace(/\s+/g, '')), `合并结果含选中的「${text.slice(0, 12)}」`)
    if (manual) assert.ok(merged.includes(manual), '合并结果含手动编辑的文字')
  } },

  /** lane 6：定稿确认后正文只读，定稿视图列出后处理四步（正文文件与三步后处理）。 */
  'chapter-finalize': { model: true, shell: 'stage', setup: seed(), run: async ({ page }) => {
    await chapterView.open(page, 3)
    await chapterView.more(page, '定稿…')
    await chapterView.finalizeDialog(page, 3).waitFor({ state: 'visible' })
    await chapterView.finalizeDialog(page, 3).getByRole('button', { name: '确认定稿', exact: true }).click()
    await chapterView.view(page).getByText('已定稿，只读', { exact: true }).waitFor({ state: 'visible', timeout: 60_000 })
    await waitRunDone(page)
    await chapterView.postProcess(page).getByText('4 / 4 完成').waitFor({ state: 'visible', timeout: 60_000 })
    assert.equal(await chapterView.prose(page).getAttribute('contenteditable'), 'false', '定稿后正文只读')
    return { steps: await chapterView.postProcessSteps(page) }
  } },

  /** lane 7：后处理里角色状态更新失败（夹具回复不是 JSON），点重试只重跑这一步：之后只有角色状态请求，没有章节要点与入库。 */
  'chapter-retry': { model: true, shell: 'stage', setup: seed(), run: async ({ page, fake }) => {
    fake.breakCharacterState()
    await chapterView.open(page, 3)
    await chapterView.finalize(page, 3)
    await waitRunDone(page)
    const failed = chapterView.postProcess(page).locator('li[data-state="failed"]')
    await failed.first().waitFor({ state: 'visible', timeout: 60_000 })
    const before = await chapterView.postProcessSteps(page)
    fake.breakCharacterState(false)
    const from = fake.requests.length
    await chapterView.postProcess(page).getByRole('button', { name: '重试失败步骤' }).click()
    await waitRunDone(page)
    await chapterView.postProcess(page).getByText('4 / 4 完成').waitFor({ state: 'visible', timeout: 60_000 })
    const retried = fake.requests.slice(from)
    assert.deepEqual([...new Set(retried)], ['character-state'], '只重试了失败的角色状态更新')
    return { before, after: await chapterView.postProcessSteps(page), retried }
  } },

  /** lane 8：选中一段正文用选区工具条润色，预览后替换；再选一段润色后取消，正文不变。 */
  'chapter-selection': { model: true, shell: 'stage', setup: seed(), run: async ({ page }) => {
    await chapterView.open(page, 4)
    const prose = chapterView.prose(page)
    const line = prose.getByText(firstLine(STAGE_SAMPLE.drafts[4].text)).first()
    await line.click({ clickCount: 3 })
    const toolbar = page.getByRole('toolbar', { name: '选中文字的操作' })
    await toolbar.waitFor({ state: 'visible' })
    assert.deepEqual(await toolbar.getByRole('button').allInnerTexts(), ['润色', '扩写', '续写', '改成对话'])
    await toolbar.getByRole('button', { name: '润色' }).click()
    await toolbar.getByText(firstLine(FIXTURE_PROSE)).waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal(await toolbar.getByRole('button', { name: '替换' }).isEnabled(), true, '预览后可以替换')
    await toolbar.getByRole('button', { name: '替换' }).click()
    await prose.getByText(firstLine(FIXTURE_PROSE)).first().waitFor({ state: 'visible' })
    const second = prose.getByText('你父亲也问过钟的事').first()
    await second.click({ clickCount: 3 })
    await toolbar.getByRole('button', { name: '润色' }).click()
    await toolbar.getByRole('button', { name: '取消' }).waitFor({ state: 'visible' })
    await toolbar.getByRole('button', { name: '取消' }).click()
    await toolbar.waitFor({ state: 'hidden' })
    assert.ok((await prose.innerText()).includes('你父亲也问过钟的事'), '取消后原文不变')
    await prose.getByText(firstLine(FIXTURE_PROSE)).first().click({ clickCount: 3 })
    await toolbar.waitFor({ state: 'visible' })
  } },

  /** lane 9：第 4 章有两稿，删除当前这一稿要危险确认，之后版本切换器只剩另一稿。 */
  'chapter-delete': { model: false, shell: 'stage', setup: seed({ extra: args => createDraft(args, 4, 2, `${STAGE_SAMPLE.drafts[4].text}\n\n这是改写的第二稿，林岚决定先不问钟的事。`) }), run: async ({ page }) => {
    await chapterView.open(page, 4)
    assert.deepEqual(await chapterView.versions(page), ['草稿 v2 · 当前', '草稿 v1'])
    await chapterView.more(page, '删除这一稿…')
    const confirm = page.getByRole('dialog', { name: '删除第 4 章 v2？' })
    await confirm.getByText('删除后无法恢复；本章其他版本不受影响。').waitFor({ state: 'visible' })
    return { confirm: true }
  }, after: async ({ page }) => {
    await page.getByRole('dialog', { name: '删除第 4 章 v2？' }).getByRole('button', { name: '删除这一稿' }).click()
    await chapterView.versionButton(page).getByText(/^草稿 v1/).waitFor({ state: 'visible' })
    assert.deepEqual(await chapterView.versions(page), ['草稿 v1 · 当前'], '版本切换器不再列出删掉的那一稿')
  } },

  /** lane 10：1280 宽深色（--theme dark）下正文一行约 34 字；运行侧页打开后纸面收窄，正文一行仍不少于 24 字，页面没有横向滚动。 */
  'chapter-1280': { model: false, shell: 'stage', setup: seed(), run: async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await chapterView.prose(page).getByText(firstLine(STAGE_SAMPLE.drafts[3].text)).first().waitFor({ state: 'visible' })
    // 打开作品的流程在文件树读完后才回到作品页，那一步会收起侧页；等它结束再打开运行侧页。
    await page.waitForTimeout(2000)
    const alone = await charsPerLine(page)
    await runSheet.openFromPalette(page)
    await page.waitForTimeout(500)
    assert.equal(await runSheet.sheet(page).isVisible(), true, '运行侧页开着')
    const withSheet = await charsPerLine(page)
    const horizontal = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
    assert.ok(alone >= 32 && alone <= 35, `1280 宽正文一行约 34 字，实际 ${alone}`)
    assert.ok(withSheet >= 24, `运行侧页打开后正文一行 ${withSheet} 字，被挤得太窄`)
    assert.equal(horizontal, false, '页面没有横向滚动')
    return { charsPerLine: alone, charsPerLineWithRunSheet: withSheet }
  } },

  /** 评审导览：草稿审稿、侧页勾选、按意见修稿、逐段合并、定稿后处理。配 --video 录 30～60 秒。 */
  'chapter-tour': { model: true, shell: 'stage', setup: seed(), run: async ({ page }) => {
    const pause = ms => page.waitForTimeout(ms)
    await pause(1200)
    await chapterView.open(page, 4)
    await pause(2000)
    await chapterView.view(page).getByRole('button', { name: '检查维度' }).click()
    await pause(2000)
    await page.keyboard.press('Escape')
    await chapterView.review(page)
    await waitRunDone(page)
    await pause(3000)
    await chapterView.reviewSheet(page).getByRole('button', { name: '添加我的意见' }).click()
    await chapterView.reviewSheet(page).getByRole('textbox', { name: '审稿问题' }).pressSequentially('守塔人的咳嗽提前出现。', { delay: 90 })
    await pause(1500)
    await chapterView.reviseButton(page).click()
    await chapterView.merge(page).waitFor({ state: 'visible', timeout: 60_000 })
    await waitRunDone(page)
    await pause(2500)
    await chapterView.merge(page).getByRole('group', { name: /用哪一版$/ }).first().getByRole('button', { name: '用修稿' }).click()
    await pause(2000)
    await chapterView.merge(page).getByRole('button', { name: '完成合并' }).click()
    await chapterView.view(page).getByRole('button', { name: '定稿', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
    await waitRunDone(page)
    await pause(2000)
    await chapterView.view(page).getByRole('button', { name: '定稿', exact: true }).click()
    await pause(3000)
    await chapterView.finalizeDialog(page, 4).getByRole('button', { name: '再看看' }).click()
    await pause(800)
    await chapterView.open(page, 3)
    await pause(1500)
    await chapterView.finalize(page, 3)
    await waitRunDone(page)
    await pause(3000)
  } },

  /** perf：从点击第 5 章（1 万字）到正文出现且纸面可以滚动。两种外壳都能跑。 */
  'chapter-open': { model: false, setup: seed({ extra: args => createDraft(args, LONG_CHAPTER, 1, LONG_TEXT) }), run: async ({ page }) => {
    return { ...await openLongChapter(page), shell: await isStage(page) ? 'stage' : 'writer' }
  } },

  /** perf：在 1 万字的第 5 章里连续输入 40 个字母，按键到渲染的 p95。两种外壳都能跑。 */
  'typing-latency': { model: false, setup: seed({ extra: args => createDraft(args, LONG_CHAPTER, 1, LONG_TEXT) }), run: async ({ page }) => {
    await openLongChapter(page)
    const content = await proseOf(page)
    await content.getByText('第1段。', { exact: false }).first().click()
    await page.keyboard.press('End')
    const keys = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmn'.split('')
    return { ...await typingLatency(page, content, keys), shell: await isStage(page) ? 'stage' : 'writer' }
  } },
}
