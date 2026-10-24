import { describe, expect, it } from 'vitest'
import { derivePlotOutlineCursor } from '../plot-outline-contract'
const range = { from: 1, to: 10 }
const toolRound = { purpose: 'plot-outline:chapter:1:normal', status: 'settled' as const, finishReason: 'stop', artifact: { artifactId: 'a1', text: '我先读取资料。' + String.fromCharCode(10) + '<tool_call>' + String.fromCharCode(10) + '{"name":"read_architecture","arguments":{}}' + String.fromCharCode(10) + '</tool_call>', revision: 1, textHash: 'h1' } }
const finalChapter = { purpose: 'plot-outline:chapter:1:normal', status: 'settled' as const, finishReason: 'stop', artifact: { artifactId: 'a2', text: '## 第1章：零\n\n**场景与出场人物**：检测厅，林澈与教员。\n\n**本章目标**：弄清读数为零意味着什么。\n\n**阻力与升级**：窗口只回数据无误。\n\n**转折与代价**：他查到饱和值，代价是当月申诉额度。\n\n**结尾钩子**：档案编号是一个孤零零的 0。\n\n**伏笔**：编号 0 接后文源起-0。', revision: 2, textHash: 'h2' } }
describe('plot outline cursor with tool rounds', () => {
  it('ignores tool-call rounds and does not skip to compact', () => {
    expect(derivePlotOutlineCursor(range, 0, [toolRound] as never)).toEqual({ kind: 'request', chapterNumber: 1, attempt: 'normal' })
  })
  it('accepts the chapter once the final round produces a valid entry', () => {
    const cursor = derivePlotOutlineCursor(range, 0, [toolRound, finalChapter] as never)
    expect(cursor.kind).toBe('accept')
    if (cursor.kind === 'accept') expect(cursor.chapterNumber).toBe(1)
  })
})
