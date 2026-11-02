import { describe, expect, it } from 'vitest'

import {
  BLUEPRINT_KEY_EVENTS_OVERSIZE_FACTOR,
  blueprintKeyEventsBudget,
  blueprintKeyEventsOversize,
  blueprintKeyEventsProseText,
  countBlueprintKeyEventsUnits,
} from '../blueprint-length'
import { findOversizedBlueprintKeyEvents } from '../consistency-preflight'

const KEY_EVENTS = '周叙把短褂撕成布条，缠住手腕的绳痕；他记得岸上有人在等。'

describe('blueprint keyEvents length budget (issue #64)', () => {
  it('scales the target with the chapter word target, clamped to 100–200', () => {
    expect(blueprintKeyEventsBudget(800)).toEqual({ target: 160, max: 320 })
    expect(blueprintKeyEventsBudget(3000)).toEqual({ target: 200, max: 400 })
    // 目标字数缺失/非法时退到下界，不产生 NaN。
    expect(blueprintKeyEventsBudget(0).target).toBe(100)
    expect(blueprintKeyEventsBudget(Number.NaN).target).toBe(100)
  })

  it('does not count the machine-read 【收束】/【装置】 labels as prose length', () => {
    const labelled = `${KEY_EVENTS}【收束：物件落幅】【装置：跳板口＋把笔撂在移交单上】`
    expect(blueprintKeyEventsProseText(labelled)).toBe(KEY_EVENTS)
    expect(countBlueprintKeyEventsUnits(labelled)).toBe(countBlueprintKeyEventsUnits(KEY_EVENTS))
  })

  it('only flags keyEvents that grew into near-prose, not a merely long one', () => {
    const budget = blueprintKeyEventsBudget(800)
    // 口径上限内：不提示。
    expect(blueprintKeyEventsOversize('事'.repeat(budget.max), 800)).toBeNull()
    // 刚好在 1.5 倍线上：仍不提示（作者的伸缩、多主角的章本来就更长）。
    expect(blueprintKeyEventsOversize('事'.repeat(Math.round(budget.max * BLUEPRINT_KEY_EVENTS_OVERSIZE_FACTOR)), 800)).toBeNull()
    // 实测样本量级（510 字 / 目标 320 上限）：提示。
    const oversize = blueprintKeyEventsOversize('事'.repeat(510), 800)
    expect(oversize).toMatchObject({ units: 510 })
  })
})

describe('findOversizedBlueprintKeyEvents', () => {
  it('stays silent on a blueprint within the budget', () => {
    expect(findOversizedBlueprintKeyEvents({ chapterNumber: 4, keyEvents: KEY_EVENTS, targetWordsPerChapter: 800 })).toEqual([])
  })

  it('reports a locatable finding with the measured count and the budget', () => {
    const findings = findOversizedBlueprintKeyEvents({
      chapterNumber: 4, keyEvents: '事'.repeat(510), targetWordsPerChapter: 800,
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      stableFactKey: 'blueprint:key-events-length:4',
      severity: 'warning',
      sourceChapter: 4,
    })
    expect(findings[0]!.evidence).toContain('约 510 字')
    expect(findings[0]!.evidence).toContain('目标 160 字、上限 320 字')
    expect(findings[0]!.suggestion.zhCN).toContain('删掉台词原文')
    expect(findings[0]!.suggestion.enUS).toContain('drop transcribed dialogue')
  })

  it('keeps the same stable key for the same chapter so one finding does not pile up', () => {
    const first = findOversizedBlueprintKeyEvents({ chapterNumber: 9, keyEvents: '事'.repeat(500), targetWordsPerChapter: 800 })
    const second = findOversizedBlueprintKeyEvents({ chapterNumber: 9, keyEvents: '事'.repeat(600), targetWordsPerChapter: 800 })
    expect(first[0]!.stableFactKey).toBe(second[0]!.stableFactKey)
  })
})