import { describe, expect, it } from 'vitest'
import { derivePlotOutlineCursor, isAcceptablePlotOutlineEntry } from '../plot-outline-contract'
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

  const transportFailure = {
    purpose: 'plot-outline:chapter:1:normal', status: 'settled' as const, finishReason: null,
    failureCode: 'GENERATION_PROVIDER_FAILED', artifact: null,
  }

  it('does not consume the chapter attempt when the transport died before any output', () => {
    // 上游 502 / 断网：没有产出，整批不该因此停在第 1 章。
    expect(derivePlotOutlineCursor(range, 0, [transportFailure] as never))
      .toEqual({ kind: 'request', chapterNumber: 1, attempt: 'normal' })
  })

  it('still stops when an upstream failure did return text', () => {
    const withText = { ...transportFailure, artifact: { artifactId: 'a3', text: '半截输出', revision: 3, textHash: 'h3' } }
    expect(derivePlotOutlineCursor(range, 0, [withText] as never).kind).toBe('stopped')
  })

  it('still stops on non-transport failures', () => {
    const other = { ...transportFailure, failureCode: null }
    expect(derivePlotOutlineCursor(range, 0, [other] as never).kind).toBe('stopped')
  })

  it('stops retrying once the transport keeps failing, instead of looping forever', () => {
    const many = Array.from({ length: 3 }, (_, index) => ({
      ...transportFailure,
      artifact: { artifactId: 'a' + index, text: '', revision: index, textHash: 'h' + index },
    }))
    expect(derivePlotOutlineCursor(range, 0, many as never).kind).toBe('stopped')
  })

  it('counts a retried real attempt once, not the failed transport attempts before it', () => {
    expect(derivePlotOutlineCursor(range, 0, [transportFailure, finalChapter] as never).kind).toBe('accept')
  })

  it('treats a chapter that is missing a required section as unacceptable, so it rebuilds', () => {
    // 真实事故：第 13 章模型漏写了「伏笔」小节。这一章不合格，必须触发一次 compact 重建，
    // 而不是推进游标后在合成阶段撞 ACCEPT_CONFLICT 把整批打断。
    const missingForeshadowing = finalChapter.artifact.text.replace(/\n\n\*\*伏笔\*\*：[^\n]*/u, '')
    expect(isAcceptablePlotOutlineEntry(missingForeshadowing, 1)).toBe(false)
    const attempt = { ...finalChapter, artifact: { ...finalChapter.artifact, text: missingForeshadowing } }
    // 不推进游标，而是按设计请求这一章的 compact 重建。
    expect(derivePlotOutlineCursor(range, 0, [attempt] as never))
      .toEqual({ kind: 'request', chapterNumber: 1, attempt: 'compact' })
    // 补全后同一章可以正常被接受。
    expect(isAcceptablePlotOutlineEntry(finalChapter.artifact.text, 1)).toBe(true)
  })
})
