import { describe, expect, it } from 'vitest'
import { validPlotOutlineEntry, isLedgerStyleOutline, derivePlotOutlineCursor, plotOutlinePurpose } from '../plot-outline-contract'

const diary = ['## 第196章：样品账', '', '七点，宿舍。账页最上面一行：停发第三日。', '七点半，地下二层。许照问：换不换。', '八点，界桩四号。断行一千一百八十米。', '九点，主路中段波动。', '十点签到后，公示区。', '**结算**：断供第一百五十七天。'].join(String.fromCharCode(10))
const prose = ['## 第196章：样品账', '', '许照把三份稳定剂推过桌面，问林澈换不换。林澈没有立刻答，先把下月预扣和门牌期限并排算了一遍，最终签了字。', '回到界桩四号时，断行已经涨到一千一百八十米。他把差值抄在账页背面，忽然意识到这不是误差。'].join(String.fromCharCode(10))
const range = { from: 196, to: 200 }
const attempt = (text: string) => ({ purpose: plotOutlinePurpose(196, 'normal'), status: 'settled', finishReason: 'stop', artifact: { artifactId: 'a', text, revision: 1, textHash: 'h' } })

describe('style rule must gate new output only', () => {
  it('history stays readable', () => {
    expect(validPlotOutlineEntry(diary, 196)).toBe(true)
  })
  it('still detects diary style', () => {
    expect(isLedgerStyleOutline(diary)).toBe(true)
    expect(isLedgerStyleOutline(prose)).toBe(false)
  })
  it('refuses to accept a diary-style chapter as final', () => {
    const cursor = derivePlotOutlineCursor(range, 0, [attempt(diary)] as never)
    expect(cursor.kind).not.toBe('accept')
  })
  it('accepts a normal chapter', () => {
    const cursor = derivePlotOutlineCursor(range, 0, [attempt(prose)] as never)
    expect(cursor.kind).toBe('accept')
  })
})
