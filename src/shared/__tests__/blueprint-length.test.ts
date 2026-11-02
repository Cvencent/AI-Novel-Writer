import { describe, expect, it } from 'vitest'

import {
  BLUEPRINT_KEY_EVENTS_OVERSIZE_FACTOR,
  blueprintKeyEventsBudget,
  blueprintKeyEventsOversize,
  blueprintKeyEventsProseText,
  countBlueprintKeyEventsUnits,
} from '../blueprint-length'
import { findClosingLabelConflicts, findOversizedBlueprintKeyEvents, findUltimatumStreak } from '../consistency-preflight'

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

describe('findClosingLabelConflicts (issue #65)', () => {
  it('flags a blueprint that claims an object close while the prose ends on dialogue', () => {
    const findings = findClosingLabelConflicts([{
      chapterNumber: 25,
      label: '物件落幅',
      content: ['他把签收联叠好。', '温珩把最后一圈绳从桩上抹下来：“那你今晚别下船。”'].join(String.fromCharCode(10) + String.fromCharCode(10)),
    }])
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      stableFactKey: 'chapter-ending:label-mismatch:25',
      severity: 'warning',
      sourceChapter: 25,
    })
    expect(findings[0]!.evidence).toContain('物件落幅')
    expect(findings[0]!.evidence).toContain('收在台词里')
  })

  it('stays silent when the label matches the prose', () => {
    expect(findClosingLabelConflicts([{
      chapterNumber: 16, label: '人物动作收束', content: '周叙没回头，只把箱子往怀里按紧了些。',
    }])).toEqual([])
  })

  it('ignores unlabelled chapters and labels it cannot verify', () => {
    expect(findClosingLabelConflicts([{ chapterNumber: 3, label: '', content: '“走吧。”' }])).toEqual([])
    expect(findClosingLabelConflicts([{ chapterNumber: 3, label: '悬念直陈', content: '“走吧。”' }])).toEqual([])
  })
})

describe('findUltimatumStreak (issue #66)', () => {
  it('reports one finding naming the whole streak', () => {
    const findings = findUltimatumStreak({
      chapters: [
        { chapterNumber: 23, content: '“但你泡了，它就化了。”' },
        { chapterNumber: 24, content: '“不签，箱子当场扣下。今夜别想开船。”' },
        { chapterNumber: 25, content: '“那你今晚别下船。”' },
      ],
      currentChapter: 25,
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      stableFactKey: 'chapter-ending:ultimatum-streak:25',
      sourceChapter: 25,
    })
    expect(findings[0]!.evidence).toContain('第 23–25 章连续 3 章')
    expect(findings[0]!.suggestion.zhCN).toContain('换一种收法')
  })

  it('stays silent when the streak is broken', () => {
    expect(findUltimatumStreak({
      chapters: [
        { chapterNumber: 23, content: '“但你泡了，它就化了。”' },
        { chapterNumber: 24, content: '周叙没回头，只把箱子往怀里按紧了些。' },
        { chapterNumber: 25, content: '“那你今晚别下船。”' },
      ],
      currentChapter: 25,
    })).toEqual([])
  })

  it('ignores empty chapters', () => {
    expect(findUltimatumStreak({
      chapters: [
        { chapterNumber: 1, content: '' },
        { chapterNumber: 2, content: '' },
        { chapterNumber: 3, content: '' },
      ],
      currentChapter: 3,
    })).toEqual([])
  })
})
