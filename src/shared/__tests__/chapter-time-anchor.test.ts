import { describe, expect, it } from 'vitest'

import {
  findUndatedStreak,
  findUndatedStreakFindings,
  statesDayBoundaryText,
  timeAnchorOf,
} from '../chapter-time-anchor'

const ch = (chapterNumber: number, content: string) => ({ chapterNumber, content })

describe('statesDayBoundaryText: 跨日/间隔的交代形态（issue #84）', () => {
  it('recognizes the ordinal day-boundary words', () => {
    for (const text of ['次日，他来了。', '翌日清晨。', '隔天一早。', '第二天，他来了。',
      '到了第二天夜里。', '转天他就走了。', '第三天夜里，船靠埠。']) {
      expect(statesDayBoundaryText(text)).toBe(true)
    }
  })

  it('recognizes 数量 + 时间单位 + 之后 而不是只枚举固定的「N天后」', () => {
    // 反面教训：第一版只列了「三天后」却漏了「三日后」，正文写了日界仍被判「没交代」。
    for (const text of ['三日后，他走了。', '半个月后，账改了。', '两个礼拜以后。', '一周之后。',
      '十天后。', '3天后。', '两个月后。', '第二年春天。', '两天后。']) {
      expect(statesDayBoundaryText(text)).toBe(true)
    }
  })

  it('recognizes phrases that state a passage of time in words', () => {
    for (const text of ['过了几天，船开了。', '数日过去。', '又过了两周，他回来。', '过了一段日子。', '经过了三天。']) {
      expect(statesDayBoundaryText(text)).toBe(true)
    }
  })

  it('does not treat a same-day pause as a day boundary', () => {
    // 反面教训：前缀「过了两」会命中「过了两息」（两口气的停顿，当天内），
    // 把一段连续无日界硬生生断开、漏掉真问题。
    for (const text of ['全叔没吭声。过了两息，他把绳圈挂上桩。', '过了两步，他停下。', '过了一盏茶工夫。']) {
      expect(statesDayBoundaryText(text)).toBe(false)
    }
  })

  it('does not treat a time-of-day word as a day boundary', () => {
    // 天亮／昨夜只能标出当天内的时点，不表示「过了多久」——那本书 34 章就是只在这几个词之间循环。
    for (const text of ['天亮靠埠，缆绳一抛。', '昨夜多那一个，是我核舱看出来的。', '下午入库房。', '天光大亮。']) {
      expect(statesDayBoundaryText(text)).toBe(false)
    }
  })

  it('does not fire on ordinary compounds that merely contain 第二天', () => {
    expect(statesDayBoundaryText('他第二天性使然。')).toBe(false)
    expect(statesDayBoundaryText('第二次见面。')).toBe(false)
  })

  it('ignores empty content', () => {
    expect(statesDayBoundaryText('')).toBe(false)
    expect(statesDayBoundaryText('   ')).toBe(false)
  })
})

describe('findUndatedStreak (issue #84)', () => {
  const undatedBook = (length: number) =>
    Array.from({ length }, (_, index) => ch(index + 1, `第${index + 1}章：天亮，他蹲在桩边。`))

  it('reports one long streak when no chapter states a day boundary', () => {
    const streaks = findUndatedStreak(undatedBook(12))
    expect(streaks).toHaveLength(1)
    expect(streaks[0]!.chapters).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  it('breaks the streak at a chapter that states a day boundary', () => {
    // 前 1–5 章无日界、第 6 章写了日界 → 只有 1–5 这一段（不足 8 章，不报）。
    const chapters = undatedBook(12).map(item =>
      item.chapterNumber === 6 ? ch(6, '三日后，船靠了埠。') : item)
    expect(findUndatedStreak(chapters)).toEqual([])
  })

  it('reports the tail when a boundary appears early', () => {
    const chapters = undatedBook(12).map(item =>
      item.chapterNumber === 1 ? ch(1, '翌日清晨，他来了。') : item)
    const streaks = findUndatedStreak(chapters)
    expect(streaks).toHaveLength(1)
    expect(streaks[0]!.chapters[0]).toBe(2)
    expect(streaks[0]!.chapters.at(-1)).toBe(12)
  })

  it('does not bridge a gap in chapter numbers', () => {
    // 断号说明中间缺章，不算同一段连续推进（与 #66/#71 的相邻口径一致）。
    const withGap = undatedBook(12).filter(item => item.chapterNumber !== 7)
    expect(findUndatedStreak(withGap)).toEqual([])
  })

  it('requires the minimum chapter count before judging', () => {
    expect(findUndatedStreak(undatedBook(5))).toEqual([])
    expect(findUndatedStreak(undatedBook(5), { minChapters: 5, minStreak: 5 })).toHaveLength(1)
  })

  it('honours a custom streak threshold', () => {
    const chapters = undatedBook(12).map(item =>
      item.chapterNumber === 4 ? ch(4, '第二天一早。') : item)
    // 门槛降到 3：边界前 1–3 也够长，于是两段（1–3 与 5–12）都报。
    expect(findUndatedStreak(chapters, { minStreak: 3 }).map(s => `${s.chapters[0]}-${s.chapters.at(-1)}`))
      .toEqual(['1-3', '5-12'])
    // 默认门槛（8）：只有 5–12 那一段。
    const streaks = findUndatedStreak(chapters)
    expect(streaks).toHaveLength(1)
    expect(streaks[0]!.chapters[0]).toBe(5)
  })

  it('names the time-of-day words it cycled among, so the author can see them', () => {
    const book = Array.from({ length: 12 }, (_, index) => ch(index + 1,
      index % 3 === 0 ? '天亮，他蹲在桩边。' : index % 3 === 1 ? '昨夜多那一个。' : '下午入库房。'))
    const [streak] = findUndatedStreak(book)
    const phrases = streak!.timeOfDayWords.map(item => item.phrase)
    expect(phrases).toContain('天亮')
    expect(phrases).toContain('昨夜')
    expect(streak!.timeOfDayWords[0]!.chapters.length).toBeGreaterThan(0)
  })

  it('ignores blank chapters instead of counting them as undated', () => {
    const chapters = [...undatedBook(10), ch(11, '   '), ch(12, '')]
    const [streak] = findUndatedStreak(chapters)
    expect(streak!.chapters).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })
})

describe('findUndatedStreakFindings (issue #84)', () => {
  it('produces a warning the author can act on, with the range and the cycling words', () => {
    const book = Array.from({ length: 12 }, (_, index) => ch(index + 1,
      index % 2 === 0 ? '天亮，他蹲在桩边。' : '昨夜多那一个。'))
    const findings = findUndatedStreakFindings(book, 13)
    expect(findings).toHaveLength(1)
    const finding = findings[0]!
    expect(finding.severity).toBe('warning')
    // sourceChapter 是「即将写的那一章」，与 finalized-prose-audit 其余各项同口径。
    expect(finding.sourceChapter).toBe(13)
    expect(finding.issue.zhCN).toContain('时间推进')
    expect(finding.issue.zhCN).toContain('1–12')
    expect(finding.evidence).toContain('天亮')
    // 出路必须可执行：指出补日界 + 标注【时点】两件事，不是只说「别这样」。
    expect(finding.suggestion.zhCN).toContain('【时点')
    expect(finding.issue.enUS.length).toBeGreaterThan(20)
    expect(finding.suggestion.enUS.length).toBeGreaterThan(20)
  })

  it('keys the finding on the streak range so it clears once time is stated', () => {
    const book = Array.from({ length: 12 }, (_, index) => ch(index + 1, '天亮，他蹲在桩边。'))
    const [first] = findUndatedStreakFindings(book, 13)
    expect(first!.stableFactKey).toBe('chapter-time:undated:1:12')
    // 作者在第 6 章补上日界后，这一段不再成立 → 提示消失。
    const fixed = book.map(item => item.chapterNumber === 6 ? ch(6, '三日后，他来了。') : item)
    expect(findUndatedStreakFindings(fixed, 13)).toEqual([])
  })

  it('says explicitly when there is not even a time-of-day word', () => {
    const book = Array.from({ length: 9 }, (_, index) => ch(index + 1, '他蹲在桩边。'))
    const [finding] = findUndatedStreakFindings(book, 10)
    expect(finding!.evidence).toContain('没有跨日')
    expect(finding!.evidence).toContain('没有任何时段词')
  })
})

describe('timeAnchorOf: 蓝图时点标注（issue #84）', () => {
  it('reads the label from keyEvents, like 收束/装置', () => {
    expect(timeAnchorOf('周叙推门。【收束：对话收束】【时点：次日清晨】')).toBe('次日清晨')
    expect(timeAnchorOf('【时点：当夜（紧接上一章）】周叙推门。')).toBe('当夜（紧接上一章）')
    // 半角冒号也认。
    expect(timeAnchorOf('【时点: 三日后】')).toBe('三日后')
  })

  it('returns empty when the model wrote no anchor', () => {
    expect(timeAnchorOf('周叙推门进屋。')).toBe('')
    expect(timeAnchorOf('')).toBe('')
  })

  it('takes the last label when the model wrote two', () => {
    expect(timeAnchorOf('【时点：当夜】【时点：次日】')).toBe('次日')
  })
})