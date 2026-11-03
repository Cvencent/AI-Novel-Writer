import { describe, expect, it } from 'vitest'

import {
  STATE_VERBS,
  STALE_DURATION_WINDOW,
  calendarUnitToDays,
  declaredTimeAdvanceDays,
  findStaleStateDurations,
  findStaleStateDurationFindings,
  stateDurationStatements,
} from '../stale-state-duration'

const ch = (chapterNumber: number, content: string) => ({ chapterNumber, content })

/**
 * issue #115：第 11 章「柯有顺的铺位**空了三天**」→ 第 12 章（开篇「**重抄后一个多月**」）
 * 仍说「柯有顺的铺**空了三天**」。两处都是当前状态的陈述，不是回忆；
 * 而现有 `undated` 判的是「有没有交代跨日」，第 12 章写了「一个多月」恰好**达标**、躲过检查。
 */
describe('stateDurationStatements (issue #115)', () => {
  it('extracts 「名词 + 状态动词 + 了 + 时长」', () => {
    const [hit] = stateDurationStatements(11, '柯有顺的铺位空了三天，铺盖卷走了。')
    expect(hit).toBeDefined()
    expect(hit!.verb).toBe('空')
    expect(hit!.durationText).toBe('三天')
    expect(hit!.claimedDays).toBe(3)
  })

  it('stays silent on durations inside short units (息／盏茶) — those repeat within one day', () => {
    // ⚠️ 刻意不收短单位：同章内「过了两息」这类会误报（#84 的同一收窄）。
    expect(stateDurationStatements(1, '铺位空了两息。')).toEqual([])
  })

  it('ignores sub-day claims (a state may legitimately repeat within a day)', () => {
    expect(stateDurationStatements(1, '门关了半晌。')).toEqual([])
  })

  it('uses a closed state-verb class, not an open word list', () => {
    // 状态动词是封闭功能类：换一本书、换一批名词照样成立。
    for (const verb of STATE_VERBS) {
      expect(stateDurationStatements(1, `那处${verb}了两天。`)).toHaveLength(1)
    }
    // 普通动词不是状态动词。
    expect(stateDurationStatements(1, '他写了两天。')).toEqual([])
  })

  it('reads Chinese numerals and 半', () => {
    expect(stateDurationStatements(1, '门关了十五天。')[0]!.claimedDays).toBe(15)
    expect(stateDurationStatements(1, '铺位空了一年。')[0]!.claimedDays).toBe(365)
    expect(stateDurationStatements(1, '铺位空了半个月。')[0]!.claimedDays).toBe(15)
  })
})

describe('declaredTimeAdvanceDays (issue #115)', () => {
  it('reads the chapter-level advance', () => {
    expect(declaredTimeAdvanceDays('重抄后一个多月，行会保下的“监写”成了每月一场茶。')).toBe(30)
    expect(declaredTimeAdvanceDays('过了两日，他又来问。')).toBe(2)
  })

  it('returns 0 when the chapter declares no advance', () => {
    expect(declaredTimeAdvanceDays('他放下碗，走了。')).toBe(0)
  })

  it('maps calendar units to days (月 30 / 年 365 / 其余 1)', () => {
    expect(calendarUnitToDays('个月')).toBe(30)
    expect(calendarUnitToDays('年')).toBe(365)
    expect(calendarUnitToDays('夜')).toBe(1)
  })
})

describe('findStaleStateDurations (issue #115)', () => {
  const reported = [
    ch(11, '柯有顺的铺位空了三天，铺盖卷走了，没人问去了哪里。'),
    ch(12, '重抄后一个多月，行会保下的“监写”成了每月一场茶。\n\n“柯有顺的铺空了三天。”'),
  ]

  it('catches the reported case (铺位 the same state, a month advanced)', () => {
    const hits = findStaleStateDurations(reported)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.advancedDays).toBe(30)
    expect(hits[0]!.later.claimedDays).toBe(3)
  })

  it('stays silent when the later chapter does not advance beyond the claim', () => {
    // 下一章没有推进（或推进量不超过三天）→ 不报。
    expect(findStaleStateDurations([
      ch(11, '柯有顺的铺位空了三天。'),
      ch(12, '次日，柯有顺的铺位空了三天，仍没人问。'),
    ])).toEqual([])
  })

  it('stays silent when the later chapter restates a DIFFERENT duration (that is an update, not a conflict)', () => {
    // 「空了三天」→「空了三十天」是**改对了**，不是矛盾（逐字不同的时长不算同一陈述）。
    expect(findStaleStateDurations([
      ch(11, '柯有顺的铺位空了三天。'),
      ch(12, '重抄后一个多月，柯有顺的铺空了三十天。'),
    ])).toEqual([])
  })

  it('does not pair across distant chapters (that could be a new event)', () => {
    const far = [
      ch(1, '那扇门关了两天。'),
      ...Array.from({ length: STALE_DURATION_WINDOW + 2 }, (_, i) => ch(i + 2, '无事。')),
      ch(STALE_DURATION_WINDOW + 3, '过了五年，那扇门关了两天。'),
    ]
    expect(findStaleStateDurations(far)).toEqual([])
  })

  it('does not pair two different subjects that merely share a state verb', () => {
    expect(findStaleStateDurations([
      ch(1, '货舱空了三天。'),
      ch(2, '过了半年，档案柜空了三天。'),
    ])).toEqual([])
  })

  it('does not cross-compare two different state verbs', () => {
    expect(findStaleStateDurations([
      ch(1, '铺位空了三天。'),
      ch(2, '过了半年，铺位停了三天。'),
    ])).toEqual([])
  })
})

describe('findStaleStateDurationFindings (issue #115 finding shape)', () => {
  const reported = [
    ch(11, '柯有顺的铺位空了三天，铺盖卷走了，没人问去了哪里。'),
    ch(12, '重抄后一个多月，行会保下的“监写”成了每月一场茶。\n\n“柯有顺的铺空了三天。”'),
  ]

  it('names both chapters, both claims and the advanced days, and stays a warning', () => {
    const findings = findStaleStateDurationFindings(reported)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('warning')
    expect(findings[0]!.evidence).toContain('11')
    expect(findings[0]!.evidence).toContain('12')
    expect(findings[0]!.evidence).toContain('30')
  })

  it('keeps the key anchored to the earliest claim and free of moving chapter numbers (#86/#89/#98/#108)', () => {
    const finding = findStaleStateDurationFindings(reported)[0]!
    expect(finding.stableFactKey).toContain('11')
    expect(finding.sourceChapter).toBe(11)
    // 追加一章不应改变 key（锚在最早陈述）。
    const longer = [...reported, ch(13, '别的事。')]
    expect(findStaleStateDurationFindings(longer)[0]!.stableFactKey).toBe(finding.stableFactKey)
  })

  it('hands over two actionable exits', () => {
    const finding = findStaleStateDurationFindings(reported)[0]!
    expect(finding.suggestion.zhCN).toContain('改成推进后的时长')
    expect(finding.suggestion.zhCN).toContain('交代掉')
    expect(finding.suggestion.enUS).toContain('update the later mention')
  })

  it('does not report internal/dev artifacts in user-facing copy (issue #112)', () => {
    const finding = findStaleStateDurationFindings(reported)[0]!
    for (const text of [finding.evidence, finding.issue.zhCN, finding.issue.enUS, finding.suggestion.zhCN, finding.suggestion.enUS]) {
      expect(text).not.toMatch(/issue\s*#\d+/u)
      expect(text).not.toMatch(/样本/u)
    }
  })
})