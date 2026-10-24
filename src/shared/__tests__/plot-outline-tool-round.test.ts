import { describe, expect, it } from 'vitest'
import { derivePlotOutlineCursor } from '../plot-outline-contract'
const range = { from: 1, to: 10 }
const toolRound = { purpose: 'plot-outline:chapter:1:normal', status: 'settled' as const, finishReason: 'stop', artifact: { artifactId: 'a1', text: '我先读取资料。' + String.fromCharCode(10) + '<tool_call>' + String.fromCharCode(10) + '{"name":"read_architecture","arguments":{}}' + String.fromCharCode(10) + '</tool_call>', revision: 1, textHash: 'h1' } }
const finalChapter = { purpose: 'plot-outline:chapter:1:normal', status: 'settled' as const, finishReason: 'stop', artifact: { artifactId: 'a2', text: '## 第1章：零' + String.fromCharCode(10) + '正文。', revision: 2, textHash: 'h2' } }
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
