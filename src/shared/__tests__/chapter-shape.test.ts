import { describe, expect, it } from 'vitest'
import { extractChapterShape, isShapeRepetitive } from '../chapter-shape'

const ledgerChapter = (n: number) => `## 第${n}章：对账
清晨对账，陈砚翻开台账，主角补了两条遗忘，钟厥七点前出门蹲点。
钟厥回报线索，陈砚记录在册。`

const variedChapter = (n: number) => `## 第${n}章：突变
入夜时分，主母突然病倒，主角连夜奔走求医，放弃了原有计划。
天亮时他意识到代价已经发生。`

describe('extractChapterShape', () => {
  it('识别「清晨对账」开场', () => {
    expect(extractChapterShape(ledgerChapter(1), ['陈砚', '钟厥']).opening).toBe('morning-ledger')
  })

  it('识别入夜开场', () => {
    expect(extractChapterShape(variedChapter(1), []).opening).toBe('night')
  })

  it('统计固定班底', () => {
    expect(extractChapterShape(ledgerChapter(1), ['陈砚', '钟厥']).recurringCast).toEqual(['陈砚', '钟厥'])
  })
})

describe('isShapeRepetitive', () => {
  it('连续 5 章同开场且固定班底重合时判重复', () => {
    const recent = Array.from({ length: 5 }, (_v, i) => extractChapterShape(ledgerChapter(i + 1), ['陈砚', '钟厥']))
    const next = extractChapterShape(ledgerChapter(6), ['陈砚', '钟厥'])
    expect(isShapeRepetitive(next, recent)).toBe(true)
  })

  it('开场不同时不判重复', () => {
    const recent = Array.from({ length: 5 }, (_v, i) => extractChapterShape(ledgerChapter(i + 1), ['陈砚', '钟厥']))
    const next = extractChapterShape(variedChapter(6), ['陈砚', '钟厥'])
    expect(isShapeRepetitive(next, recent)).toBe(false)
  })

  it('历史不足窗口时不判重复', () => {
    const recent = Array.from({ length: 3 }, (_v, i) => extractChapterShape(ledgerChapter(i + 1), ['陈砚']))
    const next = extractChapterShape(ledgerChapter(4), ['陈砚'])
    expect(isShapeRepetitive(next, recent)).toBe(false)
  })
})
