import { describe, expect, it } from 'vitest'
import { assembleMergedText, computeSegments } from '../merge-segments'

/** 复刻合并视图的初值：未改动段用同侧文字，改动段默认取原稿。 */
function mergedWith(original: string, modified: string, pick: 'original' | 'revised'): string {
  const segments = computeSegments(original, modified)
  const texts: Record<number, string> = {}
  segments.forEach((segment, index) => {
    if (segment.type === 'same') texts[index] = (segment.lines ?? []).join('\n')
    else if (segment.hunk) {
      texts[index] = (pick === 'revised' ? segment.hunk.modifiedLines : segment.hunk.originalLines).join('\n')
    }
  })
  return assembleMergedText(segments, texts)
}

/**
 * issue #127：「完成合并」会静默改坏正文。
 *
 * 修稿整段新增/整段删除时，对齐结果里那一对片段有**一侧是空数组**，文字是空串；
 * 而片段之间还有一个空行锚点（也是空串）。旧实现按「每个片段 join('\n')」拼，
 * 两个空串叠成 '\n\n\n'，于是作者「一处修稿都不采纳」也会拿到多出空行的正文。
 *
 * 判据（报告建议 2，可直接当回归跑）：**全部取原稿必须逐字等于原稿，
 * 全部取修稿必须逐字等于修稿**——不论修稿里有没有整段新增/删除。
 */
describe('修稿合并：合并结果必须与所选版本逐字相等 (issue #127)', () => {
  const ORIGINAL = '第一段。\n\n第二段。\n\n第三段。'

  it('keeps the invariant when the revision adds a whole paragraph', () => {
    const modified = '第一段。\n\n第二段。\n\n新增的一句台词。\n\n第三段。'
    expect(mergedWith(ORIGINAL, modified, 'original')).toBe(ORIGINAL)
    expect(mergedWith(ORIGINAL, modified, 'revised')).toBe(modified)
  })

  it('keeps the invariant when the revision removes a whole paragraph', () => {
    const modified = '第一段。\n\n第三段。'
    expect(mergedWith(ORIGINAL, modified, 'original')).toBe(ORIGINAL)
    expect(mergedWith(ORIGINAL, modified, 'revised')).toBe(modified)
  })

  it('keeps the invariant when one paragraph is split into two', () => {
    const modified = '第一段。\n\n第二段。\n\n第三段拆出的半句。\n\n第四段。'
    const source = '第一段。\n\n第二段。\n\n第三段拆出的半句。第四段。'
    expect(mergedWith(source, modified, 'original')).toBe(source)
    expect(mergedWith(source, modified, 'revised')).toBe(modified)
  })

  it('keeps the invariant for the paragraph-rewrite shape that already worked', () => {
    const modified = '雨从傍晚开始就没有停过。\n\n最后一班列车晚点了十七分钟，广播里的道歉一遍遍落进空站台。'
    const source = '雨从傍晚开始就没有停过。\n\n最后一班列车晚点了十七分钟。广播里的女声重复着同一句道歉。'
    expect(mergedWith(source, modified, 'original')).toBe(source)
    expect(mergedWith(source, modified, 'revised')).toBe(modified)
  })

  it('does not emit a blank block for an empty side, and never triples the separator', () => {
    // 「已选 0 处用修稿」时正文必须逐字等于原稿——这正是 issue 里第 56 章的现场。
    const modified = '第一段。\n\n第二段。\n\n新增的一句台词。\n\n第三段。'
    const merged = mergedWith(ORIGINAL, modified, 'original')
    expect(merged).toBe(ORIGINAL)
    expect(merged).not.toContain('\n\n\n')
  })
})
