import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeWithProjectSession = vi.fn()
vi.mock('../ipc-client', () => ({
  ipc: { invokeWithProjectSession: (...args: unknown[]) => invokeWithProjectSession(...args) },
}))

import { useProjectStore } from '../../stores/project-store'

const { guardSynopsisNeedsConfirmedArc, needsConfirmedArcGate } = await import('../workflow-guards')

const session = { projectId: 'p', leaseId: 'l', projectPath: 'C:/novels/gate' }
const project = { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId }

/**
 * 粗纲是细纲的方向来源：粗纲没铺满、或还有没确认的段时，直接生成细纲就等于在没有方向的情况下
 * 往下写，写歪了也没法回头对齐。这组测试固定住这条闸门。
 */
describe('guardSynopsisNeedsConfirmedArc', () => {
  beforeEach(() => {
    invokeWithProjectSession.mockReset()
    useProjectStore.setState({ currentProject: project } as never)
  })

  const withArcs = (arcs: unknown[], totalChapters = 100) => {
    invokeWithProjectSession.mockImplementation(async (_s: unknown, channel: string) => {
      if (channel === 'db:arc-outline-list') return arcs
      if (channel === 'db:project-core-get') return { totalChapters }
      return null
    })
  }

  it('一段粗纲都没有时，拦下并让作者先生成粗纲', async () => {
    withArcs([])
    const result = await guardSynopsisNeedsConfirmedArc(session.projectPath, session, 'zh-CN')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('粗纲')
    expect(result.action).toBe('open-world-building')
  })

  it('粗纲只覆盖到一半时也拦下，并说清差到第几章', async () => {
    withArcs([{ arcIndex: 1, fromChapter: 1, toChapter: 40, status: 'confirmed' }], 100)
    const result = await guardSynopsisNeedsConfirmedArc(session.projectPath, session, 'zh-CN')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('40')
    expect(result.message).toContain('100')
  })

  it('粗纲铺满但还有段没确认时拦下', async () => {
    withArcs([
      { arcIndex: 1, fromChapter: 1, toChapter: 50, status: 'confirmed' },
      { arcIndex: 2, fromChapter: 51, toChapter: 100, status: 'draft' },
    ], 100)
    const result = await guardSynopsisNeedsConfirmedArc(session.projectPath, session, 'zh-CN')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('确认')
  })

  it('粗纲铺满且全部确认时放行', async () => {
    withArcs([
      { arcIndex: 1, fromChapter: 1, toChapter: 50, status: 'confirmed' },
      { arcIndex: 2, fromChapter: 51, toChapter: 100, status: 'confirmed' },
    ], 100)
    expect((await guardSynopsisNeedsConfirmedArc(session.projectPath, session, 'zh-CN')).ok).toBe(true)
  })

  it('全书总章数为 0（还没设篇幅）时不拦：那时无从判断粗纲该铺到哪', async () => {
    withArcs([], 0)
    expect((await guardSynopsisNeedsConfirmedArc(session.projectPath, session, 'zh-CN')).ok).toBe(true)
  })

  it('读不到粗纲台账时不误拦：不能因为一次读取失败就挡住作者', async () => {
    invokeWithProjectSession.mockImplementation(async (_s: unknown, channel: string) => {
      if (channel === 'db:arc-outline-list') throw new Error('读取失败')
      if (channel === 'db:project-core-get') return { totalChapters: 100 }
      return null
    })
    expect((await guardSynopsisNeedsConfirmedArc(session.projectPath, session, 'zh-CN')).ok).toBe(true)
  })

  it('只生成情节大纲时才走闸门；按段生成细纲（带 arcContext）不走', () => {
    // 例外本身是纯函数，单独钉住：按某个已确认的粗纲段生成细纲时，
    // 那一段就是作者认可的走向，不需要全书粗纲先铺满。
    expect(needsConfirmedArcGate({ selectedSteps: ['synopsis'] })).toBe(true)
    expect(needsConfirmedArcGate({ selectedSteps: ['synopsis'], arcContext: { arcId: 1 } })).toBe(false)
    // 整套架构生成（含节奏前提等）不在细纲这一支路上
    expect(needsConfirmedArcGate({ selectedSteps: ['premise', 'worldbuilding'] })).toBe(false)
    expect(needsConfirmedArcGate({})).toBe(false)
  })

  it('英文界面给出英文说明', async () => {
    withArcs([])
    const result = await guardSynopsisNeedsConfirmedArc(session.projectPath, session, 'en-US')
    expect(result.message).toContain('arc outline')
  })
})
