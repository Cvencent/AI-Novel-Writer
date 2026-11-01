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

describe('总章数调大后细纲无法续写', () => {
  it('当「已覆盖 = 全书章数」时应用不写覆盖说明 → 事后调大总章数就断链', () => {
    // 总章数为 9 时写满 9 章：renderPlotOutlineSynopsis 不加说明
    const fullAtNine = renderPlotOutlineSynopsis(nine, 9, { totalChapters: 9, writingLanguage: 'zh-CN' })
    expect(fullAtNine.includes('本大纲已覆盖至第')).toBe(false)

    // 作者把总章数改成 11（正文已写到第 9 章），沿用同一份细纲
    const asEleven = { synopsis: fullAtNine, totalChapters: 11, writingLanguage: 'zh-CN' as const }

    // 想接着写第 10 章：被拒
    expect(plotOutlineRangeEffect(asEleven, { from: 10, to: 10 }).kind).toBe('invalid')
    // 「下一章」退化成 1
    expect(plotOutlineNextChapter(asEleven)).toBe(1)
    // 进度面板因此认为全书完成 → 面板显示 11/11，之后 startContinuousOutline 直接 return
    expect(outlineProgress(fullAtNine, undefined, 'zh-CN', 11).kind).toBe('complete')
  })

  it('反证：只要末尾有第 9/11 章的覆盖说明，就能正常续写第 10 章', () => {
    const withTail = renderPlotOutlineSynopsis(nine, 9, { totalChapters: 11, writingLanguage: 'zh-CN' })
    expect(withTail).toContain('> 本大纲已覆盖至第 9 章（全书 11 章）')
    const source = { synopsis: withTail, totalChapters: 11, writingLanguage: 'zh-CN' as const }
    expect(plotOutlineRangeEffect(source, { from: 10, to: 10 }).kind).toBe('continue')
    expect(plotOutlineNextChapter(source)).toBe(10)
    expect(outlineProgress(withTail, undefined, 'zh-CN', 11).kind).toBe('partial')
  })
})