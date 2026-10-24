import { describe, expect, it } from 'vitest'
import { validPlotOutlineEntry, derivePlotOutlineCursor, plotOutlinePurpose, plotOutlineRequestContract, hasRequiredOutlineSections, OUTLINE_SECTIONS } from '../plot-outline-contract'

const range = { from: 1, to: 10 }
const attempt = (text: string) => ({ purpose: plotOutlinePurpose(1, 'normal'), status: 'settled' as const, finishReason: 'stop', artifact: { artifactId: 'a', text, revision: 1, textHash: 'h' } })

// 六小节齐全的新格式
const full = ['## 第1章：读数为零', '', '**场景与出场人物**：检测厅，林澈、教员。', '**本章目标**：弄清读数为零意味着什么。', '**阻力与升级**：窗口只回数据无误，他拿不到原始记录。', '**转折与代价**：他查到饱和值，但用掉了当月唯一申诉额度。', '**结尾钩子**：档案页角落编号是一个孤零零的 0。', '**伏笔**：编号 0 接后文源起-0 命名空间。'].join(String.fromCharCode(10))

// 缺小节（只有部分）
const partial = ['## 第1章：读数为零', '', '检测厅读数为零。他去申诉，被驳回。他把编号 0 记了下来。'].join(String.fromCharCode(10))

describe('WP1 locked outline sections', () => {
  it('exposes the six canonical sections', () => {
    expect(OUTLINE_SECTIONS).toHaveLength(6)
    expect(OUTLINE_SECTIONS).toContain('转折与代价')
    expect(OUTLINE_SECTIONS).toContain('伏笔')
  })
  it('recognises a chapter that carries all six sections', () => {
    expect(hasRequiredOutlineSections(full)).toBe(true)
  })
  it('rejects a chapter missing sections at the admission gate', () => {
    expect(hasRequiredOutlineSections(partial)).toBe(false)
    const cursor = derivePlotOutlineCursor(range, 0, [attempt(partial)] as never)
    expect(cursor.kind).not.toBe('accept')
  })
  it('still accepts a fully sectioned chapter', () => {
    expect(derivePlotOutlineCursor(range, 0, [attempt(full)] as never).kind).toBe('accept')
  })
  it('keeps historical readability independent from the section rule', () => {
    expect(validPlotOutlineEntry(partial, 1)).toBe(true)
  })
  it('states the section format as a hard output contract', () => {
    const progress = { protocol: 'chapter-outline-v3', range, content: { maxAttemptsPerChapter: 2 }, targetUnits: 300, cursor: { kind: 'request', chapterNumber: 1, attempt: 'normal' }, confirmedPrefix: '', composition: null, sourceExpected: { synopsis: '', premise: 'p', charactersArch: 'c', worldbuilding: 'w', genre: 'g', totalChapters: 10, wordsPerChapter: 3000, writingLanguage: 'zh-CN', plotStructure: 'three_act', narrativePov: 'third_limited', globalGuidance: '' } }
    const text = plotOutlineRequestContract(progress as never, 1, 'normal')
    for (const section of OUTLINE_SECTIONS) expect(text).toContain(section)
  })
})
