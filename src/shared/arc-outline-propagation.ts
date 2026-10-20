import type { ArcStatus } from '../../electron/repositories/arc-outline-repository'

export interface PropagationPlan {
  /** 因粗纲改动而过期的细纲章号。 */
  staleChapters: number[]
  /** 需要重新生成的后续粗纲段序号。 */
  arcsNeedingRegen: number[]
}

/**
 * 粗纲第 i 段被改动后的影响范围。
 * 只标记归属该段、且生成时修订号落后的章节；后续段整体标记待重生成。
 */
export function planArcEditPropagation(
  editedArcIndex: number,
  arcs: readonly { arcIndex: number; revision: number; status: ArcStatus }[],
  bound: readonly { chapterNumber: number; arcRevisionAtBuild: number; arcId: number }[],
  arcIdByIndex: ReadonlyMap<number, number>,
): PropagationPlan {
  const editedArcId = arcIdByIndex.get(editedArcIndex)
  const edited = arcs.find(arc => arc.arcIndex === editedArcIndex)
  const staleChapters = editedArcId === undefined || !edited
    ? []
    : bound
        .filter(item => item.arcId === editedArcId && item.arcRevisionAtBuild < edited.revision)
        .map(item => item.chapterNumber)
        .sort((left, right) => left - right)
  const arcsNeedingRegen = arcs
    .filter(arc => arc.arcIndex > editedArcIndex)
    .map(arc => arc.arcIndex)
    .sort((left, right) => left - right)
  return { staleChapters, arcsNeedingRegen }
}

/**
 * 作者手改细纲某一章：不动粗纲。
 * 返回 touchesArc:false 是刻意的——细纲编辑即权威，不触发粗纲改动，也不弹窗。
 */
export function planChapterEditPropagation(): { touchesArc: false } {
  return { touchesArc: false }
}
