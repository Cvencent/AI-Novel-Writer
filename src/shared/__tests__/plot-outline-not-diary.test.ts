import { describe, expect, it } from 'vitest'
import { isLedgerStyleOutline, validPlotOutlineEntry, plotOutlineRequestContract } from '../plot-outline-contract'

const diary = ['## 第196章：样品账','','七点，宿舍。账页最上面一行：停发第三日。','七点半，地下二层。许照问：换不换。','八点，界桩四号。断行一千一百八十米。','九点，主路中段波动。','十点签到后，公示区。','**结算**：断供第一百五十七天。'].join(String.fromCharCode(10))
const prose = ['## 第196章：样品账','','许照把三份稳定剂推过桌面，问林澈换不换。林澈没有立刻答，先把下月预扣、门牌期限和样品停发日并排算了一遍：换，下月只剩二十点六份；不换，门牌先塌。他最终签了字，代价当场落在下月配额上。','回到界桩四号时，断行已经涨到一千一百八十米，核减仍按一百九十米。他把差值抄在账页背面，忽然意识到这不是误差，是有人每天把界桩往外挪十米。'].join(String.fromCharCode(10))

describe('chapter outline must be a plan, not a diary', () => {
  it('detects timestamped ledger-style outlines', () => {
    expect(isLedgerStyleOutline(diary)).toBe(true)
  })
  it('keeps structure validation independent from style so history stays readable', () => {
    // 日记体拒绝发生在「新产出准入」闸门，不在读取历史数据的结构校验里。
    expect(validPlotOutlineEntry(diary, 196)).toBe(true)
  })
  it('accepts a normal scene-based chapter outline', () => {
    expect(validPlotOutlineEntry(prose, 196)).toBe(true)
  })
  it('tells the model not to apply prose style to the outline layout', () => {
    const progress = { protocol: 'chapter-outline-v3', range: { from: 1, to: 10 }, content: { maxAttemptsPerChapter: 2 }, targetUnits: 300, cursor: { kind: 'request', chapterNumber: 1, attempt: 'normal' }, confirmedPrefix: '', composition: null, sourceExpected: { synopsis: '', premise: 'p', charactersArch: 'c', worldbuilding: 'w', genre: 'g', totalChapters: 10, wordsPerChapter: 3000, writingLanguage: 'zh-CN', plotStructure: 'three_act', narrativePov: 'third_limited', globalGuidance: '' } }
    const text = plotOutlineRequestContract(progress as never, 1, 'normal')
    expect(text).toContain('这一章的大纲怎么写')
    expect(text).toContain('不是按时间罗列日程')
    expect(text).toContain('不要套用到细纲的排版上')
  })
})
