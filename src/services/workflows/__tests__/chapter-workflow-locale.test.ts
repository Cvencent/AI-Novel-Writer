import { afterEach, describe, expect, it } from 'vitest'

import { useLocaleStore } from '../../../stores/locale-store'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'
import {
  createChapterWorkflow,
  createFinalizeWorkflow,
  createRefineFromReviewWorkflow,
  createRefineOnlyWorkflow,
  createReviewOnlyWorkflow,
} from '../chapter-workflow'

const projectPath = 'C:\\novels\\english-chapter'
const projectSession: ProjectSessionContext = {
  projectId: 'english-chapter',
  leaseId: 'english-chapter-lease',
  projectPath,
}
const originalLocale = useLocaleStore.getState().locale
const sourceDraft = {
  id: 2,
  chapterNumber: 2,
  version: 1,
  status: 'draft' as const,
  contentRevision: 0,
}

afterEach(() => useLocaleStore.setState({ locale: originalLocale }))

describe('chapter workflow locale', () => {
  it('freezes English titles, steps, descriptions, and completion copy for chapter workflows', () => {
    useLocaleStore.setState({ locale: 'en-US' })

    const workflows = [
      createChapterWorkflow({
        projectPath,
        chapterNumber: 2,
        title: 'A New Term',
        role: 'Development',
        purpose: 'Deepen the relationship',
        characters: ['Maya'],
        keyEvents: 'Maya joins the literature club.',
      }, projectSession),
      createReviewOnlyWorkflow({
        projectPath,
        chapterNumber: 2,
        chapterTitle: 'A New Term',
        draftPath: 'ai-novel://draft/2',
        draftContent: 'Draft',
        sourceDraft,
      }, projectSession),
      createRefineOnlyWorkflow({
        projectPath,
        chapterNumber: 2,
        chapterTitle: 'A New Term',
        draftPath: 'ai-novel://draft/2',
        draftContent: 'Draft',
        sourceDraft,
      }, projectSession),
      createRefineFromReviewWorkflow({
        projectPath,
        chapterNumber: 2,
        chapterTitle: 'A New Term',
        draftPath: 'ai-novel://draft/2',
        draftContent: 'Draft',
      }, projectSession),
      createFinalizeWorkflow({
        projectPath,
        chapterNumber: 2,
        chapterTitle: 'A New Term',
        draftPath: 'ai-novel://draft/2',
        draftContent: 'Draft',
      }, projectSession),
    ]

    expect(workflows.map(workflow => ({
      locale: workflow.uiLocale,
      title: workflow.title,
      step: workflow.steps[0].name,
      description: workflow.steps[0].description,
      completion: workflow.onComplete?.message,
    }))).toEqual([
      expect.objectContaining({ locale: 'en-US', title: 'Chapter 2 · Draft', step: 'Draft chapter' }),
      expect.objectContaining({ locale: 'en-US', title: 'Chapter 2 · Review', step: 'Review chapter' }),
      expect.objectContaining({ locale: 'en-US', title: 'Chapter 2 · Revise', step: 'Revise draft' }),
      expect.objectContaining({ locale: 'en-US', title: 'Chapter 2 · Apply review', step: 'Revise from review' }),
      expect.objectContaining({ locale: 'en-US', title: 'Chapter 2 · Finalize', step: 'Finalize chapter' }),
    ])
    expect(workflows.flatMap(workflow => [
      workflow.title,
      workflow.steps[0].name,
      workflow.steps[0].description,
      workflow.onComplete?.message ?? '',
    ]).join('\n')).not.toMatch(/[\u4e00-\u9fff]/u)
  })
})

/**
 * 编辑部评审（五角色）已并入 AI 审稿：点一次「AI 审稿」= 一致性审稿 + 深度检查 +
 * 五角色一次跑完。此前五角色是审稿侧页里独立一块，要再点一次「运行编辑部」。
 */
describe('review workflow carries the editorial panel (issue #245 现场)', () => {
  it('runs the editorial panel as a step of the review workflow', () => {
    const workflow = createReviewOnlyWorkflow({
      projectPath,
      chapterNumber: 2,
      chapterTitle: 'A New Term',
      draftPath: 'ai-novel://draft/2',
      draftContent: '本章正文。',
      sourceDraft,
    }, projectSession)
    const names = workflow.steps.map(step => step.name)
    expect(names).toHaveLength(3)
    expect(names.join('|')).toMatch(/编辑部评审|Editorial panel/)
    // 五角色是最后一步：前面两步的产出（含深度检查）都进同一份运行卡片。
    expect(names.at(-1)).toMatch(/编辑部评审|Editorial panel/)
  })
})

/**
 * issue #245 现场：编辑部那一步模型失败（`GENERATION_PROVIDER_FAILED`）时，
 * 前一步的审稿报告**已经成功落库**，但整个工作流却报失败——作者在界面上看到的
 * 是「审稿失败」，实际上审稿好好的、只是五角色没跑成；更糟的是重试耗尽的失败
 * 被当成"没问题"，因为面板停在空状态，跟"还没跑过"长得一模一样。
 *
 * 修法：这一步瞬时失败按工作流层口径**重试一次**；最终仍失败**不抛**，
 * 而是把失败写进这一步的返回值（运行卡片可见），由审稿报告侧页显示成
 * 「编辑部评审没跑成」而不是「还没有评分」。
 */
describe('editorial step failure does not sink the review (issue #245 现场)', () => {
  const build = () => createReviewOnlyWorkflow({
    projectPath,
    chapterNumber: 2,
    chapterTitle: 'A New Term',
    draftPath: 'ai-novel://draft/2',
    draftContent: '本章正文。',
    sourceDraft,
  }, projectSession)

  it('wraps the panel call in the workflow-layer transient retry', async () => {
    // 步骤 executor 的源码里必须出现 withTransientRetry —— 裸调用会让一次抖动
    // 直接判死整个审稿（审稿单次 100+ 秒，作者白等）。
    const source = await import('node:fs').then(fs => fs.readFileSync(
      new URL('../chapter-workflow.ts', import.meta.url), 'utf8'))
    const editorialBlock = source.slice(source.indexOf('编辑部评审（五角色）并入 AI 审稿'))
    expect(editorialBlock).toContain('withTransientRetry')
    expect(editorialBlock).toContain('limit: 1')
  })

  it('catches the failure and returns an explicit failure message instead of throwing', async () => {
    const source = await import('node:fs').then(fs => fs.readFileSync(
      new URL('../chapter-workflow.ts', import.meta.url), 'utf8'))
    const editorialBlock = source.slice(source.indexOf('编辑部评审（五角色）并入 AI 审稿'))
    // 必须有 catch，且返回值里明确写「失败、未产生评分」——不能静默变 pass
    expect(editorialBlock).toContain('catch (error)')
    expect(editorialBlock).toContain('编辑部评审失败')
    // 取消是作者意图，仍要上抛（否则取消会被记成失败）
    expect(editorialBlock).toContain('if (context.cancelled) throw error')
  })

  it('keeps three steps so the panel still runs as part of AI review', () => {
    expect(build().steps).toHaveLength(3)
  })
})

/**
 * issue #245 现场：作者点完「合并」又看到一次「第 N 章 · 审稿」，以为自己白重审了全章。
 *
 * 那其实是**复核（recheck）**——只裁决刚修过的那几条意见，不是整章重审。
 * 但两者原来共用同一个标题、同一个首步名，界面上完全分不出来。
 * 现在：带 `reviewCycleId` 的一律显示「复核已修意见」，并且不再重复跑五角色评分。
 */
describe('recheck reads as a recheck, not a full review (issue #245 现场)', () => {
  const build = (over: Record<string, unknown> = {}) => createReviewOnlyWorkflow({
    projectPath,
    chapterNumber: 2,
    chapterTitle: 'A New Term',
    draftPath: 'ai-novel://draft/2',
    draftContent: '本章正文。',
    sourceDraft,
    ...over,
  }, projectSession)

  it('titles the recheck run differently from a full review', () => {
    const full = build()
    const recheck = build({ reviewCycleId: 'cycle:abc', expectedMergedHash: 'a'.repeat(64) })
    expect(full.title).toMatch(/审稿|Review/)
    expect(full.title).not.toMatch(/复核|Recheck/)
    expect(recheck.title).toMatch(/复核已修意见|Recheck revised notes/)
    // 首步名也要区分，否则运行卡片里第一行仍然是「审稿」
    expect(recheck.steps[0].name).toMatch(/复核已修意见|Recheck revised notes/)
    expect(recheck.steps[0].description).toMatch(/不是重审全章|not a full re-review/)
  })

  it('does not rescore the editorial panel during a recheck', async () => {
    const source = await import('node:fs').then(fs => fs.readFileSync(
      new URL('../chapter-workflow.ts', import.meta.url), 'utf8'))
    const editorialBlock = source.slice(source.indexOf('编辑部评审（五角色）并入 AI 审稿'))
    expect(editorialBlock).toContain('frozenParams.reviewCycleId')
    expect(editorialBlock).toContain('复核不重算评分')
  })
})
