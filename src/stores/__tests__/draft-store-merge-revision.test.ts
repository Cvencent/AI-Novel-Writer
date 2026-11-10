import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  invokeWithProjectSession,
  syncTabContent,
  markTabSaved,
  settleMergedRevision,
  startWorkflow,
  editorTabs,
  workflowHistory,
} = vi.hoisted(() => ({
  invokeWithProjectSession: vi.fn(),
  syncTabContent: vi.fn(),
  markTabSaved: vi.fn(),
  settleMergedRevision: vi.fn(),
  startWorkflow: vi.fn(),
  workflowHistory: [] as Array<{ id: string; status: string; error: string }>,
  editorTabs: [] as Array<{
    id: string
    filePath: string
    projectKey: string
    content: string
    contentRevision: number
    dirty: boolean
  }>,
}))

vi.mock('../../services/ipc-client', () => ({
  ipc: { invokeWithProjectSession },
}))

vi.mock('../project-store', () => ({
  useProjectStore: {
    getState: () => ({
      currentProject: {
        id: 'project-a',
        name: '隔离测试项目',
        path: 'C:\\novels\\project-a',
        sessionLease: 'lease-a',
      },
        }),
  },
}))

vi.mock('../editor-store', () => ({
  useEditorStore: {
    getState: () => ({
      tabs: editorTabs,
      syncTabContent,
      markTabSaved,
      settleMergedRevision,
    }),
  },
}))

vi.mock('../workflow-store', () => ({
  useWorkflowStore: { getState: () => ({ startWorkflow, history: workflowHistory }) },
  workflowResourceKey: (...parts: unknown[]) => parts.join(':'),
}))

vi.mock('../locale-store', () => ({
  useLocaleStore: { getState: () => ({ locale: 'zh-CN' }) },
}))

import { useDraftStore } from '../draft-store'

const projectPath = 'C:\\novels\\project-a'
const projectSession = {
  projectId: 'project-a',
  leaseId: 'lease-a',
  projectPath,
}

describe('draft-store merged revision persistence', () => {
  beforeEach(() => {
    workflowHistory.length = 0
    invokeWithProjectSession.mockReset()
      syncTabContent.mockReset()
    markTabSaved.mockReset()
    settleMergedRevision.mockReset()
    startWorkflow.mockReset()
    editorTabs.splice(0)
      startWorkflow.mockResolvedValue('recheck')

    invokeWithProjectSession.mockImplementation(async (_session: unknown, channel: string) => {
      if (channel === 'db:draft-list') {
        return [{
          id: 11,
          chapterNumber: 1,
          version: 1,
          status: 'draft',
          wordCount: 0,
          source: 'write',
          createdAt: '2026-08-22T00:00:00.000Z',
        }]
      }
      if (channel === 'db:revision-merge') {
        return {
          success: true,
          receipt: {
            revisionId: 1,
            targetDraftId: 11,
            status: 'revised',
            wordCount: 9,
            idempotent: false,
          },
        }
      }
      return { success: true }
    })

    useDraftStore.setState({
      draftsByChapter: {},
      loading: false,
      dataProjectKey: null,
      dataProjectSession: null,
      loadingProjectKey: null,
      loadingProjectSession: null,
    })
  })

  it('marks the direct vela revision URI as merged after its target draft is updated', async () => {
    const result = await useDraftStore.getState().applyMergedRevision(
      'ai-novel://draft/ch1',
      1,
      'ai-novel://draft/11',
      'ai-novel://revision/1',
      '已人工合并的修订稿',
      '原稿',
      projectPath,
      projectSession,
    )

    expect(result).toMatchObject({ success: true, receipt: { revisionId: 1, targetDraftId: 11 } })
    expect(invokeWithProjectSession).toHaveBeenCalledWith(
      projectSession,
      'db:revision-merge',
      {
        revisionId: 1,
        targetDraftId: 11,
        expectedDraftContent: '原稿',
        mergedContent: '已人工合并的修订稿',
        wordCount: 9,
      },
      projectPath,
    )
    expect(invokeWithProjectSession).not.toHaveBeenCalledWith(
      projectSession,
      'db:draft-update-content',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      projectPath,
    )
  })

  it('freezes the editor snapshot before awaiting the merge receipt', async () => {
    let releaseMerge!: () => void
    const mergePending = new Promise<void>(resolve => { releaseMerge = resolve })
    editorTabs.push({
      id: 'draft-11',
      filePath: 'ai-novel://draft/11',
      projectKey: projectPath,
      content: '原稿',
      contentRevision: 3,
      dirty: false,
    })
    invokeWithProjectSession.mockImplementation(async (_session: unknown, channel: string) => {
      if (channel === 'db:revision-merge') {
        await mergePending
        return { success: true, receipt: { idempotent: false } }
      }
      if (channel === 'db:draft-list') return []
      return { success: true }
    })

    const merging = useDraftStore.getState().applyMergedRevision(
      'ai-novel://draft/ch1',
      1,
      'ai-novel://draft/11',
      'ai-novel://revision/1',
      '合并正文',
      '原稿',
      projectPath,
      projectSession,
    )
    editorTabs[0].content = '提交等待期间继续输入 C'
    editorTabs[0].contentRevision = 4
    editorTabs[0].dirty = true
    releaseMerge()

    await expect(merging).resolves.toMatchObject({ success: true, receipt: { idempotent: false } })
    expect(settleMergedRevision).toHaveBeenCalledWith(
      'draft-11',
      { content: '原稿', contentRevision: 3 },
      '合并正文',
    )
  })

  it('starts exactly one targeted recheck only when the merge receipt requires it', async () => {
    startWorkflow.mockImplementation(async definition => {
      definition.onStarted()
      return new Promise<string>(() => {})
    })
    editorTabs.push({ id: 'draft-11', filePath: 'ai-novel://draft/11', projectKey: projectPath,
      content: '原稿', contentRevision: 2, dirty: false })
    invokeWithProjectSession.mockImplementation(async (_session: unknown, channel: string) => {
      if (channel === 'db:revision-merge') return { success: true, receipt: { revisionId: 1, targetDraftId: 11,
        status: 'revised', wordCount: 4, idempotent: false, chapterNumber: 1, version: 1,
        reviewCycle: { cycleId: 'cycle-1', mergedHash: 'a'.repeat(64), disposition: 'required' } } }
      if (channel === 'db:draft-list') return []
      return { success: true }
    })
    const result = await useDraftStore.getState().applyMergedRevision('ai-novel://draft/ch1', 1,
      'ai-novel://draft/11', 'ai-novel://revision/1', '合并正文', '原稿', projectPath, projectSession)
    expect(result.error).toBeUndefined()
    expect(result).toMatchObject({ success: true, receipt: { reviewCycle: { disposition: 'required' } } })
    expect(startWorkflow).toHaveBeenCalledTimes(1)
    expect(startWorkflow.mock.calls[0]?.[0]).toMatchObject({ projectPath, steps: [{ name: expect.any(String) }] })
    expect(startWorkflow.mock.calls[0]?.[1]).toBe(false)
  })

  it.each(['reject', 'failed-history'] as const)('reports a post-commit recheck launch %s without claiming the durable merge failed', async failure => {
    editorTabs.push({ id: 'draft-11', filePath: 'ai-novel://draft/11', projectKey: projectPath,
      content: '原稿', contentRevision: 2, dirty: false })
    invokeWithProjectSession.mockImplementation(async (_session: unknown, channel: string) => {
      if (channel === 'db:revision-merge') return { success: true, receipt: { revisionId: 1, targetDraftId: 11,
        status: 'revised', wordCount: 4, idempotent: false, chapterNumber: 1, version: 1,
        reviewCycle: { cycleId: 'cycle-1', mergedHash: 'a'.repeat(64), disposition: 'required' } } }
      if (channel === 'db:draft-list') return []
      return { success: true }
    })
    if (failure === 'reject') startWorkflow.mockRejectedValue(new Error('synthetic recheck launch failure'))
    else workflowHistory.push({ id: 'recheck', status: 'failed', error: 'synthetic recheck launch failure' })

    await expect(useDraftStore.getState().applyMergedRevision('ai-novel://draft/ch1', 1,
      'ai-novel://draft/11', 'ai-novel://revision/1', '合并正文', '原稿', projectPath, projectSession))
      .resolves.toMatchObject({ success: true, receipt: { reviewCycle: { disposition: 'required' } },
        postCommitError: 'Error: synthetic recheck launch failure' })
  })
})

/**
 * issue #137：把定稿后的修稿应用为新版本后，**版本下拉必须立刻更新**。
 *
 * 旧实现只 `reload()`——那只会重读**当前这一稿**的元数据（`parseDraftMeta(filePath)`），
 * 不会重读这一章的草稿列表；而版本下拉读的是 `draftsByChapter[chapterNumber]`。
 * 于是作者点完「应用为新版本」看不到新版本，要等切页/定稿才出现。
 */
describe('applyRevisionAsNewVersion 必须与列表刷新同一步 (issue #137)', () => {
  it('refreshes this chapter’s draft list as part of the action', async () => {
    const calls: string[] = []
    invokeWithProjectSession.mockImplementation(async (_session: unknown, channel: string) => {
      calls.push(channel)
      if (channel === 'db:revision-apply-as-new-version') return { draftId: 12, version: 2 }
      // 新版本出现后，这一章应当有 v1 与 v2 两稿。
      if (channel === 'db:draft-list') {
        return [
          { id: 11, chapterNumber: 1, version: 1, status: 'finalized', wordCount: 0, source: 'write', createdAt: '2026-08-22T00:00:00.000Z' },
          { id: 12, chapterNumber: 1, version: 2, status: 'draft', wordCount: 0, source: 'rewrite', createdAt: '2026-08-22T00:00:01.000Z' },
        ]
      }
      return { success: true }
    })

    await expect(useDraftStore.getState().applyRevisionAsNewVersion(1, 1, projectPath, projectSession))
      .resolves.toMatchObject({ success: true })
    // 落库与列表读取都在，且落库在前。
    expect(calls).toEqual(['db:revision-apply-as-new-version', 'db:draft-list'])
    // 关键断言：下拉的数据源已经有两个版本。
    expect(useDraftStore.getState().draftsByChapter[1]).toMatchObject([
      expect.objectContaining({ id: 12, version: 2 }),
      expect.objectContaining({ id: 11, version: 1 }),
    ])
  })

  it('reports the failure without touching the draft list when the write is rejected', async () => {
    invokeWithProjectSession.mockImplementation(async (_session: unknown, channel: string) => {
      if (channel === 'db:revision-apply-as-new-version') throw new Error('REVISION_BASE_NOT_FINALIZED')
      return []
    })
    const before = useDraftStore.getState().draftsByChapter[1]
    await expect(useDraftStore.getState().applyRevisionAsNewVersion(1, 1, projectPath, projectSession))
      .resolves.toEqual({ success: false, error: expect.stringContaining('REVISION_BASE_NOT_FINALIZED') })
    expect(useDraftStore.getState().draftsByChapter[1]).toBe(before)
  })
})
