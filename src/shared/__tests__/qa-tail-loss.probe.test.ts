import { describe, expect, it } from 'vitest'
import {
  plotOutlineNextChapter,
  plotOutlineRangeEffect,
  renderPlotOutlineSynopsis,
} from '../plot-outline-contract'
import { outlineProgress } from '../plot-outline-checkpoint'

const entry = (chapter: number) =>
  `## 第${chapter}章：第${chapter}章标题\n\n**场景与出场人物**：甲。\n\n**本章目标**：推进。\n\n**阻力与升级**：受阻。\n\n**转折与代价**：付出。\n\n**结尾钩子**：悬念。\n\n**伏笔**：线头。`
const nine = Array.from({ length: 9 }, (_, i) => entry(i + 1)).join('\n\n')

describe('总章数调大后细纲续写（issue #21 回归）', () => {
  it('「已覆盖 = 全书章数」时不写覆盖说明 → 事后调大总章数，bare 结尾仍能续写', () => {
    // 总章数为 9 时写满 9 章：renderPlotOutlineSynopsis 不加说明
    const fullAtNine = renderPlotOutlineSynopsis(nine, 9, { totalChapters: 9, writingLanguage: 'zh-CN' })
    expect(fullAtNine.includes('本大纲已覆盖至第')).toBe(false)

    // 作者把总章数改成 11（正文已写到第 9 章），沿用同一份细纲
    const asEleven = { synopsis: fullAtNine, totalChapters: 11, writingLanguage: 'zh-CN' as const }

    // 修复前：续写第 10 章被拒、「下一章」退化成 1、进度面板误报全书完成，
    // startContinuousOutline 因此一个请求都不发。8eb639b8 起 bare 结尾被接受为合法前缀。
    expect(plotOutlineRangeEffect(asEleven, { from: 10, to: 10 }).kind).toBe('continue')
    expect(plotOutlineNextChapter(asEleven)).toBe(10)
    expect(outlineProgress(fullAtNine, undefined, 'zh-CN', 11)).toEqual({ kind: 'partial', coveredTo: 9, total: 11 })
  })

  it('反证：只要末尾有第 9/11 章的覆盖说明，就能正常续写第 10 章', () => {
    const withTail = renderPlotOutlineSynopsis(nine, 9, { totalChapters: 11, writingLanguage: 'zh-CN' })
    expect(withTail).toContain('> 本大纲已覆盖至第 9 章（全书 11 章）')
    const source = { synopsis: withTail, totalChapters: 11, writingLanguage: 'zh-CN' as const }
    expect(plotOutlineRangeEffect(source, { from: 10, to: 10 }).kind).toBe('continue')
    expect(plotOutlineNextChapter(source)).toBe(10)
    expect(outlineProgress(withTail, undefined, 'zh-CN', 11)).toEqual({ kind: 'partial', coveredTo: 9, total: 11 })
  })

  it('作者在覆盖说明后补写文字：旧说明不能被当作正文通过 bare-prefix 比对（fail-closed）', () => {
    const withTail = renderPlotOutlineSynopsis(nine, 9, { totalChapters: 11, writingLanguage: 'zh-CN' })
    const edited = `${withTail}\n\n作者补的一句。`
    const source = { synopsis: edited, totalChapters: 11, writingLanguage: 'zh-CN' as const }
    expect(plotOutlineRangeEffect(source, { from: 10, to: 10 }).kind).toBe('invalid')
    expect(plotOutlineNextChapter(source)).toBe(1)
    expect(outlineProgress(edited, undefined, 'zh-CN', 11)).toEqual({ kind: 'unresumable' })
  })
})
