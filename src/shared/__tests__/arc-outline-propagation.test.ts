import { describe, expect, it } from 'vitest'
import type { ArcStatus } from '../../../electron/repositories/arc-outline-repository'
import { planArcEditPropagation, planChapterEditPropagation } from '../arc-outline-propagation'

const arcs: { arcIndex: number; revision: number; status: ArcStatus }[] = [
  { arcIndex: 1, revision: 3, status: 'confirmed' },
  { arcIndex: 2, revision: 2, status: 'confirmed' },
  { arcIndex: 3, revision: 1, status: 'draft' },
]
const arcIdByIndex = new Map<number, number>([[1, 101], [2, 102], [3, 103]])
// 归属：第1段含 1-3 章（生成时 rev=2，落后于当前 rev=3），第2段含 4-5 章（rev 最新）
const bound = [
  { chapterNumber: 1, arcRevisionAtBuild: 2, arcId: 101 },
  { chapterNumber: 2, arcRevisionAtBuild: 2, arcId: 101 },
  { chapterNumber: 3, arcRevisionAtBuild: 2, arcId: 101 },
  { chapterNumber: 4, arcRevisionAtBuild: 2, arcId: 102 },
  { chapterNumber: 5, arcRevisionAtBuild: 2, arcId: 102 },
]

describe('planArcEditPropagation', () => {
  it('只标记归属被改段且修订号落后的章节', () => {
    expect(planArcEditPropagation(1, arcs, bound, arcIdByIndex).staleChapters).toEqual([1, 2, 3])
  })

  it('不影响其他段落的章节', () => {
    const plan = planArcEditPropagation(1, arcs, bound, arcIdByIndex)
    expect(plan.staleChapters).not.toContain(4)
    expect(plan.staleChapters).not.toContain(5)
  })

  it('后续段标记为待重生成', () => {
    expect(planArcEditPropagation(1, arcs, bound, arcIdByIndex).arcsNeedingRegen).toEqual([2, 3])
  })

  it('改最后一段时没有后续段', () => {
    expect(planArcEditPropagation(3, arcs, bound, arcIdByIndex).arcsNeedingRegen).toEqual([])
  })

  it('修订号已最新的段不产生 stale 章节', () => {
    const freshArcs = [{ arcIndex: 1, revision: 2, status: 'confirmed' as ArcStatus }]
    expect(planArcEditPropagation(1, freshArcs, bound, arcIdByIndex).staleChapters).toEqual([])
  })
})

describe('planChapterEditPropagation', () => {
  it('改细纲章不触发粗纲改动', () => {
    expect(planChapterEditPropagation()).toEqual({ touchesArc: false })
  })
})
