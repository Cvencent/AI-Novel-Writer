import { describe, expect, it } from 'vitest'

import {
  dayGapOf,
  findUndatedStreak,
  findUndatedStreakFindings,
  findUnmetTimeAnchorFindings,
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

  it('keys the finding on the streak start so it clears once time is stated', () => {
    const book = Array.from({ length: 12 }, (_, index) => ch(index + 1, '天亮，他蹲在桩边。'))
    const [first] = findUndatedStreakFindings(book, 13)
    // key 只带首章（issue #89）：带末章会让它每写一章就换一个，ack 永远对不上。
    expect(first!.stableFactKey).toBe('chapter-time:undated:1')
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
// issue #89：这条判据的 key 原来带**末章号**，而 #79 的「我已知，稍后处理」是按 key 精确匹配
// 过滤的 —— key 每写一章就换一个（末章号 +1），于是那条**正确**的提醒永远关不掉。
// 实测那本书 38 章零跨日交代，连写 37/38/39 三章三次原样重报，ack 落的是 `1:38`、
// 下一章算出 `1:39`。恰恰是「回改 30 多章日界不可能一章内做完」的这类提醒最需要这个出口。
describe('undated-streak key must not roll with the last chapter (issue #89)', () => {
  const undated = (length: number) =>
    Array.from({ length }, (_, index) => ({ chapterNumber: index + 1, content: `第${index + 1}章：天亮，他蹲在桩边。` }))

  it('keeps the same key as the book advances, so one acknowledgement silences it', () => {
    const at38 = findUndatedStreakFindings(undated(38), 39)[0]!
    const at39 = findUndatedStreakFindings(undated(39), 40)[0]!
    expect(at38.stableFactKey).toBe('chapter-time:undated:1')
    expect(at39.stableFactKey).toBe(at38.stableFactKey)
  })

  it('still keys on the first chapter of the streak, so a different streak is a different finding', () => {
    // 前半段补了日界 → 这一段从第 5 章起算，是**另一件事**，应得到另一个 key。
    const chapters = undated(20).map(item =>
      item.chapterNumber === 4 ? { chapterNumber: 4, content: '三日后，船靠了埠。' } : item)
    expect(findUndatedStreakFindings(chapters, 21)[0]!.stableFactKey).toBe('chapter-time:undated:5')
  })

  it('disappears once the time progression is actually written down', () => {
    const fixed = undated(12).map(item =>
      item.chapterNumber === 6 ? { chapterNumber: 6, content: '三日后，船靠了埠。' } : item)
    expect(findUndatedStreakFindings(fixed, 13)).toEqual([])
  })
})

/**
 * issue #132：蓝图声明了「次日／跨日」，正文一字未提。
 *
 * 实测那本书 24 章带【时点】标注、5 章声明跨日，**4 章正文没落实**
 * （ch45 次日清晨 / ch49 次日天亮前（跨日）/ ch52 次日午后 / ch55 次日上午），
 * 只有 ch57 落实（「两日后，送检结案日。」）。下面用同样的形态复刻。
 */
describe('findUnmetTimeAnchorFindings: 蓝图声明跨日而正文没写（issue #132）', () => {
  /** 蓝图 keyEvents 里【时点：…】标注的真实形态（timeAnchorOf 读的就是它）。 */
  const prose = (chapterNumber: number, content: string, anchor: string) =>
    ({ chapterNumber, content, keyEvents: `他核完账。
【时点：${anchor}】` })

  it('reports the four real forms the book actually produced', () => {
    const hits = findUnmetTimeAnchorFindings([
      prose(44, '回执摊在桌上，边角还带着潮气。', '同日夜（紧接上一章，日落前后）'),
      prose(45, '回执摊在桌上，边角还带着潮气。', '次日清晨（两天期限的最后半天）'),
      prose(48, '缝里卡着册子边角，露半指宽。', '同日深夜（紧接上一章）'),
      prose(49, '缝里卡着册子边角，露半指宽。', '次日天亮前至上午（紧接上一章，跨日）'),
      prose(51, '他把灯罩扣上。', '紧接上章当夜，船仍停废水道'),
      prose(52, '回执是午后才送到的。', '次日午后'),
      prose(55, '日头出到桅顶，栈桥上的水汽还没收。', '次日上午（送检单项回执先于三日全案回）'),
      // 这一章正文写了日界……但写的是「两日后」，而蓝图标的是「次日」（issue #134）。
      prose(57, '两日后，送检结案日。', '次日（送检结案日）上午'),
    ])
    // 45/49/52/55 是「没写日界」；57 是「写了但隔的天数不对」（另一条 key）。
    expect(hits.map(hit => hit.sourceChapter)).toEqual([45, 49, 52, 55, 57])
    expect(hits.slice(0, 4).every(hit => hit.stableFactKey.startsWith('chapter-time:anchor-unmet:'))).toBe(true)
    expect(hits[4]!.stableFactKey).toBe('chapter-time:anchor-gap-mismatch:57')
  })

  /**
   * issue #134：`statesDayBoundaryText` 是布尔——「次日」「两日后」「三日后」在它眼里
   * 是同一个 true。第 57 章蓝图标「次日」、正文写「两日后」，差整整一天，
   * 而 #132 当时判成「已落实」，不报。
   */
  it('reports when both sides state a boundary but the day counts disagree', () => {
    const [hit] = findUnmetTimeAnchorFindings([prose(57, '两日后，送检结案日。', '次日（送检结案日）上午')])
    expect(hit!.stableFactKey).toBe('chapter-time:anchor-gap-mismatch:57')
    expect(hit!.evidence).toContain('隔 1 天')
    expect(hit!.evidence).toContain('隔 2 天')
    // 换一组数值也成立（一周 vs 三日）。
    expect(findUnmetTimeAnchorFindings([prose(9, '一周后，船靠了埠。', '三日后')])[0]!.stableFactKey)
      .toBe('chapter-time:anchor-gap-mismatch:9')
    // 正文写了日界但读不出确定天数（「过了几天」）→ 放过，不猜。
    expect(findUnmetTimeAnchorFindings([prose(9, '过了几天，船靠了埠。', '次日')])).toEqual([])
  })

  it('quotes both sides so the author knows which sentence to fix', () => {
    const [hit] = findUnmetTimeAnchorFindings([prose(45, '回执摊在桌上，边角还带着潮气。', '次日清晨（两天期限的最后半天）')])
    expect(hit!.evidence).toContain('次日清晨')
    expect(hit!.evidence).toContain('回执摊在桌上')
    expect(hit!.issue.zhCN).toContain('次日清晨')
  })

  it('stays silent when the blueprint itself declares the same day', () => {
    for (const anchor of ['同日夜（紧接上一章，日落前后）', '同日午后', '紧接上章，当日上午至日落前', '同夜']) {
      expect(findUnmetTimeAnchorFindings([prose(9, '他推开舱门。', anchor)]), anchor).toEqual([])
    }
  })

  it('stays silent when the prose states the same day boundary the blueprint declares', () => {
    expect(findUnmetTimeAnchorFindings([prose(9, '次日天没亮，他就上了跳板。', '次日清晨')])).toEqual([])
    expect(findUnmetTimeAnchorFindings([prose(9, '三天后，船靠了埠。', '三日后')])).toEqual([])
    // 「隔天」= 「次日」= 1 天，同一天数不报。
    expect(findUnmetTimeAnchorFindings([prose(9, '隔天他就走了。', '次日清晨')])).toEqual([])
  })

  it('stays silent without a blueprint anchor, and on the first chapter', () => {
    expect(findUnmetTimeAnchorFindings([prose(9, '他推开舱门。', '')])).toEqual([])
    expect(findUnmetTimeAnchorFindings([{ chapterNumber: 9, content: '他推开舱门。' }])).toEqual([])
    // 第 1 章没有上一章可跨。
    expect(findUnmetTimeAnchorFindings([prose(1, '他推开舱门。', '次日清晨')])).toEqual([])
  })

  /**
   * issue #143：日界判据必须**只看章首**，且 `dayGapOf` 取**最先出现**的那个记号。
   *
   * 旧实现拿整章扫、并取**最后一个**匹配，于是章内任何朝前看的期限
   * （「公司回话三日后到」）都被读成本章日界——两个方向同时出错：
   * 第 63 章真漏报被吃掉、第 64 章首段明明写对却被章末顶掉。
   */
  it('does not let an in-chapter future deadline act as this chapter’s day boundary', () => {
    // 第 63 章现场：首段无日界，章末有「三日后到」→ 必须报「没写日界」。
    const ch63 = '天没亮透，码头外廊支起两张条凳。\n\n他把存根摊开。\n\n「公司回话三日后到。船等不起。」'
    const hits = findUnmetTimeAnchorFindings([prose(63, ch63, '紧接第62章次日清晨')])
    expect(hits.map(hit => hit.stableFactKey)).toEqual(['chapter-time:anchor-unmet:63'])
  })

  it('does not let an in-chapter deadline override a correct opening boundary', () => {
    // 第 64 章现场：首段「封箱次日上午」=1 天、与蓝图一致；章末「三日后…」不该顶掉它。
    const ch64 = '封箱次日上午，船首那盘缆绳还是三天前打的结。\n\n柯明远进来。\n\n三日后第三格里落谁的名，也只有他一个人清楚。'
    expect(findUnmetTimeAnchorFindings([prose(64, ch64, '封箱次日上午')])).toEqual([])
  })

  it('still reports a real mismatch between the opening boundary and the blueprint', () => {
    // 第 57 章现场（#134 的真阳性）：首段「两日后」vs 蓝图「次日」。
    const ch57 = '两日后，送检结案日。日头刚翻过仓檐。'
    const [hit] = findUnmetTimeAnchorFindings([prose(57, ch57, '次日（送检结案日）上午')])
    expect(hit!.stableFactKey).toBe('chapter-time:anchor-gap-mismatch:57')
  })

  it('allows the boundary inside the chapter when the blueprint itself spans the chapter', () => {
    // 第 59 章现场：蓝图「当晚开航至次日靠埠」——推进发生在**本章之内**，
    // 章首只写起点、跨日写在章中，这才是对的。
    const ch59 = '当晚开船。跳板收上来。\n\n周叙下舱核舱。\n\n靠埠是次日晌午。'
    expect(findUnmetTimeAnchorFindings([prose(59, ch59, '当晚开航至次日靠埠')])).toEqual([])
  })

  it('reads the earliest boundary marker, not the last one', () => {
    // 「三日后」在前、「次日」在后 → 本章日界是 3 天。
    expect(dayGapOf('三日后才是结案日。次日清早他就上了船。')).toBe(3)
    expect(dayGapOf('封箱次日上午。船首那盘缆绳还是三天前打的结。')).toBe(1)
  })

  it('keys on the problem chapter, which does not move as the book advances', () => {
    const at20 = findUnmetTimeAnchorFindings([prose(9, '他推开舱门。', '次日清晨')])[0]!
    const at30 = findUnmetTimeAnchorFindings([
      prose(9, '他推开舱门。', '次日清晨'),
      prose(29, '又一章。', '同日午后'),
    ])[0]!
    expect(at20.stableFactKey).toBe('chapter-time:anchor-unmet:9')
    expect(at30.stableFactKey).toBe(at20.stableFactKey)
  })

  it('is structural: any declared-then-unwritten pair is reported, not a fixed list', () => {
    // 换标注形态与正文，判据照样成立（「半个月后」与「隔日」）。
    expect(findUnmetTimeAnchorFindings([prose(12, '他把门关上。', '半个月后')])[0]!.sourceChapter).toBe(12)
    expect(findUnmetTimeAnchorFindings([prose(13, '他把门关上。', '隔日清晨')])[0]!.sourceChapter).toBe(13)
  })
})
