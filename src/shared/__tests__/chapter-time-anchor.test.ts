import { describe, expect, it } from 'vitest'

import {
  chapterBoundaryHits,
  dayGapOf,
  findUndatedStreak,
  findUndatedStreakFindings,
  findOrdinalRegressionFindings,
  findTimeAnchorSelfContradictions,
  findUnmetTimeAnchorFindings,
  openingDayBoundary,
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

/**
 * issue #146：#143 把「窗口多宽」和「期限怎么排除」用同一个数字表达了——
 * `DAY_BOUNDARY_OPENING_PARAGRAPHS = 2`。于是**写在第 3–4 段的真日界被漏掉**，
 * 报出反向假阳性（第 20 章蓝图【时点：第三日】、正文第 4 段「第三日了」却被判「没写」）。
 *
 * 修法是把两件事拆开：
 * - 窗口放宽到**场景初起**（人物在哪、正在做什么也算开头）；
 * - 「朝前看的期限」（「公司回话三日后到」）由**句法位置**单独排除，不靠窗口大小。
 */
describe('章首窗口与「朝前看」期限是两个独立判据（issue #146）', () => {
  const NL = String.fromCharCode(10)
  /** 与上面同一个形态：蓝图 keyEvents 里带【时点：…】标注。 */
  const prose = (chapterNumber: number, content: string, anchor: string) =>
    ({ chapterNumber, content, keyEvents: `他核完账。【时点：${anchor}】` })

  it('finds the boundary on the fourth paragraph, where the real chapter puts it', () => {
    // 第 20 章现场的段结构：台词 / 主角动作 / 交代案头 / 日界。
    const paragraphs = [
      '“搬缆的——验票舱缺人手，你过去。”',
      '马六在货栈门口喊了一声。周叙把肩上的缆绳搁下。',
      '案前换了人。新册摊着，边上摞着票根和印盒。',
      '第三日了。船开出去又回来两趟，他的名字不在新册任何一页。',
    ]
    expect(findUnmetTimeAnchorFindings([
      prose(20, paragraphs.join(NL), '新季开航后第三日'),
    ])).toEqual([])
    // 判据本身也要读得出它在第 4 段：证据与读数都来自那一句。
    // ⚠️「第三日」是**全书日序**（issue #147），读数是 ordinal 3，不是「隔 2 天」。
    expect(openingDayBoundary(paragraphs.join(NL))).toMatchObject({ ordinal: 3, days: null })
  })

  it('reads the boundary as the story’s day 3, matching the blueprint’s day 3', () => {
    // 蓝图写「第三日」→ 也是全书第 3 日；两侧一致所以不报 gap-mismatch。
    expect(findUnmetTimeAnchorFindings([prose(20, `${NL}${NL}${NL}第三日了。船开出去又回来两趟。`, '新季开航后第三日')]))
      .toEqual([])
  })

  it('still rejects a forward-looking deadline in the first paragraph', () => {
    // 「公司回话三日后到」是**将来的期限**，不是「上一章之后过了三天」。
    // 判据靠句法位置：「N 日后」前面还有主语/宾语时不算日界。
    expect(findUnmetTimeAnchorFindings([
      prose(63, '公司回话三日后到。船等不起。' + NL + '周叙把存根摊开。', '紧接第62章次日清晨'),
    ]).map(hit => hit.stableFactKey)).toEqual(['chapter-time:anchor-unmet:63'])
  })

  it('accepts the same durative form when it opens the sentence', () => {
    // 同一族写法，句首 ⇒ 是本章日界（「两日后，送检结案日。」）。
    expect(chapterBoundaryHits('两日后，送检结案日。')[0]).toMatchObject({ days: 2 })
    expect(chapterBoundaryHits('他三天后才回来。')).toEqual([])
    expect(chapterBoundaryHits('船要半个月后才能修好。')).toEqual([])
  })

  it('keeps the closing-quote case (dialogue opening a paragraph) as a boundary', () => {
    // 句首允许开引号/破折号：台词开头交代时间同样是交代。
    expect(chapterBoundaryHits('「两日后，送检结案日。」')[0]).toMatchObject({ days: 2 })
    expect(chapterBoundaryHits('——三日后，船才靠埠。')[0]).toMatchObject({ days: 3 })
  })

  it('does not depend on which phrase family it is: 次日 still counts anywhere', () => {
    // 「次日/翌日」本身就是对「已经过了多久」的陈述，带主语也是日界
    // （「他次日清早上的船」）。刻意**不对这一族**加句首限制，否则真日界会漏。
    expect(chapterBoundaryHits('他次日清早上的船。')[0]).toMatchObject({ days: 1 })
    expect(findUnmetTimeAnchorFindings([
      prose(9, '周叙把缆绳搁下。他次日清早上的船。', '次日清晨'),
    ])).toEqual([])
  })

  it('takes the earliest boundary inside the window, not a later deadline', () => {
    // 章首「封箱次日上午」（1 天）在前、后面「三日后…」在后 → 读 1 天（#143 保住了）。
    const text = '封箱次日上午，船首那盘缆绳还是三天前打的结。' + NL + NL
      + '柯明远进来。' + NL + NL + '三日后第三格里落谁的名，也只有他一个人清楚。'
    expect(openingDayBoundary(text)).toMatchObject({ days: 1 })
  })
})

/**
 * issue #147：「第三日」「第三天」是**全书日序**（绝对），不是「隔了 N−1 天」（相对）。
 *
 * 现场：ch65【第三日正午（公司回话日）】→ ch66【第三天午后（紧接上一章）】→
 * ch67【第三天傍晚（紧接上一章）】。后两章与前一章是**同一天的不同时段**，
 * 蓝图自己也用「（紧接上一章）」说明了这一点。而旧实现把「第 N 日」一律按 N−1 换算：
 *
 *   ch66 被判「隔 2 天」→ 蓝图声明跨日、正文没有日界 → 报 anchor-unmet:66
 *   ch65 通过则是**两侧同错抵消**（蓝图与正文都算成 2 天），属假通过。
 *
 * 修法：绝对日序与相对间隔**分开建模**（`chapterBoundaryHits().ordinal` 对 `days`），
 * 并由上一章的日序求差；两者相同时连「正文要写日界」这个要求都不该提出。
 */
describe('绝对日序与相对间隔是两个不同的量（issue #147）', () => {
  const NL = String.fromCharCode(10)
  const prose = (chapterNumber: number, content: string, anchor: string) =>
    ({ chapterNumber, content, keyEvents: `他核完账。【时点：${anchor}】` })

  it('does not treat 「第三日」 as “two days after the previous chapter”', () => {
    // 读数是日序 3，不是天数 2。
    expect(chapterBoundaryHits('第三日正午，废水道的船坞棚底下没有风。')[0])
      .toMatchObject({ ordinal: 3, days: null })
    // 相对写法照旧读天数。
    expect(chapterBoundaryHits('两日后，送检结案日。')[0]).toMatchObject({ days: 2, ordinal: null })
  })

  it('does not demand a day boundary when two chapters fall on the same story day', () => {
    // ch65 → ch66：同一天的「正午」与「午后」，正文自然不必写日界。
    const hits = findUnmetTimeAnchorFindings([
      prose(65, '第三日正午，废水道的船坞棚底下没有风。', '第三日正午（公司回话日）'),
      prose(66, '柯明远把登记册重新摊在木箱上。', '第三天午后（紧接上一章）'),
    ])
    expect(hits).toEqual([])
  })

  it('does not demand one for the third successive chapter on the same day either', () => {
    // ch65 正午 → ch66 午后 → ch67 傍晚，三章同一天。
    const hits = findUnmetTimeAnchorFindings([
      prose(65, '第三日正午，船坞棚底下没有风。', '第三日正午（公司回话日）'),
      prose(66, '柯明远把登记册重新摊在木箱上。', '第三天午后（紧接上一章）'),
      prose(67, '引桥的灯才亮。周叙堵在办公室门口。', '第三天傍晚（紧接上一章）'),
    ])
    expect(hits).toEqual([])
  })

  it('still reports a real jump when the story day actually advances', () => {
    // ch66→ch69：蓝图【次日（第四日）】= 全书第 4 日，与 ch66 的第 3 日不同，
    // 而正文没写日界 → 该报。（带上 ch65 是为了让日序链条读得出来——判据靠上一章的日序求差。）
    const hits = findUnmetTimeAnchorFindings([
      prose(65, '第三日正午，船坞棚底下没有风。', '第三日正午（公司回话日）'),
      prose(66, '柯明远把登记册重新摊在木箱上。', '第三天午后（紧接上一章）'),
      prose(69, '天没亮透，周叙下跳板时鞋底还挂着舱里的水汽。', '次日（第四日）清晨至午后'),
    ])
    expect(hits.map(hit => hit.stableFactKey)).toEqual(['chapter-time:anchor-unmet:69'])
  })

  it('reports rather than guesses when the previous story day is unknown', () => {
    // 采样从章中间起（上一章不在样本里）时读不出日序差 → 仍按「正文没写日界」报，
    // 不猜成同一天。宁可多报一次，也不要把真实的跨日静音掉。
    expect(findUnmetTimeAnchorFindings([
      prose(66, '柯明远把登记册重新摊在木箱上。', '第三天午后（紧接上一章）'),
    ]).map(hit => hit.stableFactKey)).toEqual(['chapter-time:anchor-unmet:66'])
  })

  it('compares like with like: day ordinals are not compared against day gaps', () => {
    // 蓝图「第三日」与正文「两日后」不是同一个量（日序 vs 间隔）——读不出可比的数就放过，
    // 不能报成「差 1 天」（那会把一个换算差异伪装成作者的错误）。
    expect(findUnmetTimeAnchorFindings([
      prose(9, '两日后，船靠了埠。', '第三日'),
    ])).toEqual([])
    // 同一种量才比：蓝图「第三日」vs 正文「第四日」→ 真的差一天，报。
    expect(findUnmetTimeAnchorFindings([
      prose(9, '第四日清早，船靠了埠。', '第三日'),
    ]).map(hit => hit.stableFactKey)).toEqual(['chapter-time:anchor-gap-mismatch:9'])
  })

  it('keeps the relative-axis check working: 次日 vs 两日后 still mismatches (#134)', () => {
    expect(findUnmetTimeAnchorFindings([
      prose(57, '两日后，送检结案日。日头刚翻过仓檐。', '次日（送检结案日）上午'),
    ]).map(hit => hit.stableFactKey)).toEqual(['chapter-time:anchor-gap-mismatch:57'])
  })

  it('does not require a boundary when the blueprint says it is the same day', () => {
    // 蓝图写「同日午后」「当夜（紧接上一章）」这类**相对**写法时，本来就没有日界可写。
    for (const anchor of ['同日午后', '当夜（紧接上一章）', '同日深夜', '紧接第57章，当日午后']) {
      expect(findUnmetTimeAnchorFindings([
        prose(9, '他把灯罩扣上。' + NL + '柯明远进来。', anchor),
      ]), anchor).toEqual([])
    }
  })

  it('is not fooled by 「紧接」when the anchor also names a different day', () => {
    // 「紧接第62章**次日**清晨」：既有「紧接」又有「次日」——换日了，正文仍该写日界。
    expect(findUnmetTimeAnchorFindings([
      prose(63, '天没亮透，码头外廊支起两张条凳。', '紧接第62章次日清晨'),
    ]).map(hit => hit.stableFactKey)).toEqual(['chapter-time:anchor-unmet:63'])
  })

  it('keeps the ordinal chain across chapters so same-day runs are judged on real days', () => {
    // 中间夹一天休息也不会把日序丢掉：ch65(第3日) → ch66(第3日) → ch70(第4日)。
    const hits = findUnmetTimeAnchorFindings([
      prose(65, '第三日正午，船坞棚底下没有风。', '第三日正午（公司回话日）'),
      prose(66, '他把册摊开。', '第三天午后（紧接上一章）'),
      prose(70, '第四日清早，他把册合上。', '第四日清晨'),
    ])
    // ch70 的蓝图是绝对日序（第 4 日），正文也是第 4 日 → 两侧同量同值 → 放行。
    expect(hits).toEqual([])
  })
})

/**
 * issue #147 建议 3：**蓝图侧**的前置校验。
 *
 * 「第三天午后（紧接上一章）」这一条【时点】自己就不能同时成立——括注说紧接上一章，
 * 日序却说到了第 3 日。这类要先在蓝图上报出来，别拿它去冤枉正文。
 */
describe('蓝图【时点】自相矛盾（issue #147 建议 3）', () => {
  const prose = (chapterNumber: number, anchor: string) =>
    ({ chapterNumber, content: '正文一行。', keyEvents: `他核完账。【时点：${anchor}】` })

  it('flags an absolute day that contradicts its own 「紧接上一章」', () => {
    // 上一章在第 2 日、本章标「第三天（紧接上一章）」——两个说法不能同时成立。
    // ⚠️ 实测 ch65「第三日正午」→ ch66「第三天午后（紧接上一章）」**不是**这一档：
    // 两者都是第 3 日，同一天，自洽（那是主判据的换算错，已另修）。
    const [hit] = findTimeAnchorSelfContradictions([
      prose(65, '第二日正午'),
      prose(66, '第三天午后（紧接上一章）'),
    ])
    expect(hit).toBeDefined()
    expect(hit!.stableFactKey).toBe('chapter-time:anchor-self-contradiction:66')
    expect(hit!.evidence).toContain('第 3 日')
  })

  it('stays silent when the day really does advance', () => {
    // 「次日清晨（紧接上一章）」：次日 = 新的一天，与「紧接」不冲突（只是相对写法）。
    expect(findTimeAnchorSelfContradictions([
      prose(44, '同日夜（紧接上一章，日落前后）'),
      prose(45, '次日清晨（两天期限的最后半天）'),
    ])).toEqual([])
  })

  it('stays silent when the same-day label is relative, which is the contract’s own wording', () => {
    for (const anchor of ['同日午后（紧接上一章）', '当夜（紧接上一章）', '紧接第57章，当日午后']) {
      expect(findTimeAnchorSelfContradictions([prose(9, '第三日正午'), prose(10, anchor)]), anchor).toEqual([])
    }
  })

  it('does not guess when the previous chapter has no day ordinal', () => {
    // 上一章没写【时点】或写的是相对词 → 读不出日序 → 放过（把判定留给主判据）。
    expect(findTimeAnchorSelfContradictions([prose(66, '第三天午后（紧接上一章）')])).toEqual([])
    expect(findTimeAnchorSelfContradictions([
      prose(65, '同日下午'),
      prose(66, '第三天午后（紧接上一章）'),
    ])).toEqual([])
  })
})

/**
 * issue #166：【时点】的「A 至 B」区间必须按**区间**读，不能只取首端。
 *
 * 现场（本书 75–78 章）：bp76「第七日深夜至第八日清晨（紧接第75章当夜）」、
 * bp77「第八日清晨至午后（紧接第76章）」。旧实现只取首端，于是 ch76 记 7、ch77 记 8，
 * 报出 `anchor-self-contradiction:77`——**让作者去改一张本来正确的蓝图**。
 */
describe('【时点】区间的两端各用各的 (issue #166)', () => {
  const prose = (chapterNumber: number, anchor: string) =>
    ({ chapterNumber, content: '正文一行。', keyEvents: `他核完账。【时点：${anchor}】` })

  it('does not flag the chapter that merely continues the previous chapter’s interval', () => {
    const hits = findTimeAnchorSelfContradictions([
      prose(75, '第七日傍晚至当夜'),
      prose(76, '第七日深夜至第八日清晨（紧接第75章当夜）'),
      prose(77, '第八日清晨至午后（紧接第76章）'),
      prose(78, '第八日午后至傍晚'),
    ])
    expect(hits).toEqual([])
  })

  it('still flags a real contradiction when the interval does not reach the next day', () => {
    // 上一章停在第七日，这一章「（紧接上一章）」却标第八日 → 真的矛盾。
    const hits = findTimeAnchorSelfContradictions([
      prose(75, '第七日傍晚至当夜'),
      prose(76, '第八日清晨（紧接第75章当夜）'),
    ])
    expect(hits.map(hit => hit.stableFactKey)).toEqual(['chapter-time:anchor-self-contradiction:76'])
  })

  it('advances the day ordinal with the interval’s END, not its start', () => {
    // ch76 [第七日深夜 → 第八日清晨]：下一章从第 8 日起算才对。
    // 若用首端推进，ch77「第八日清晨（紧接第76章）」会被误判成矛盾。
    const hits = findTimeAnchorSelfContradictions([
      prose(76, '第七日深夜至第八日清晨（紧接第75章当夜）'),
      prose(77, '第八日清晨至午后（紧接第76章）'),
    ])
    expect(hits).toEqual([])
  })

  it('compares the interval’s START against the previous chapter', () => {
    // ch77 从第八日清晨起，而 ch76 结束在第八日清晨 → 接得上。
    const hits = findTimeAnchorSelfContradictions([
      prose(76, '第七日深夜至第八日清晨'),
      prose(77, '第八日清晨（紧接第76章）'),
    ])
    expect(hits).toEqual([])
  })
})

/**
 * issue #196：「事件锚点 + 次日」被一律算成「上一章之后第 1 天」。
 *
 * 现场：第 85–88 章蓝图【时点】写「**开箱次日**的清晨 / 午后 / 入夜 / 深夜」——
 * 这是**同一天的四段**，可预检对四章各报一条「时间推进不明」，四条同义提醒占满一屏。
 * 建议还写着「在正文开头补一句日界」——照做就把同一天的四段拉成四天，
 * 后面所有「两日内 / 三日内」的期限跟着一起漂。
 *
 * 根因：`chapterBoundaryHits('开箱次日清晨')` 只认出「次日」两个字，返回 `days: 1`，
 * 前面的事件名「开箱」被整个丢掉 → 既不知道「开箱」是哪一天，
 * 也不知道上一章已经在「开箱次日」了。`SAME_DAY_ANCHOR` 那条兜底只在
 * `hits` **为空**时才生效，而「开箱次日」不空。
 */
describe('事件锚点 + 次日 不是每次都跨日 (issue #196)', () => {
  // 直接从 keyEvents 里取【时点】标注（与生产调用同一条路）。
  const anchor = (text: string) => `【时点：${text}】某事。`

  it('extracts the event name sitting right before the relative day word', () => {
    const hit = chapterBoundaryHits(anchor('开箱次日清晨（紧接第84章）'))[0]!
    expect(hit.eventAnchor).toBe('开箱')
    expect(hit.days).toBe(1)
  })

  it('has no event anchor for a plain relative phrasing', () => {
    expect(chapterBoundaryHits(anchor('次日清晨'))[0]!.eventAnchor).toBeNull()
  })

  it('does not take the tail of another time word as the event anchor', () => {
    // 「三日后的次日」里的前半段是时间词，不是事件名。
    expect(chapterBoundaryHits(anchor('三日后的次日'))[0]!.eventAnchor).toBeNull()
  })

  it('only the chapter that enters the event day crosses; the rest of the run is one day', () => {
    // 现场四章（含前面建立锚点的第 84 章）：只有 84 → 85 那次是**真跨日**，
    // 85/86/87/88 是同一天的四段。旧实现四章全报，四条提醒还把正文往四天上拉。
    const chapters = [
      { chapterNumber: 84, keyEvents: '【时点：开箱日午后（紧接第83章）】A。', content: '午后。' },
      { chapterNumber: 85, keyEvents: '【时点：开箱次日清晨（紧接第84章）】B。', content: '卯时刚过。正厅门槛。' },
      { chapterNumber: 86, keyEvents: '【时点：开箱次日午后（紧接第85章）】C。', content: '午后，廊下石板干了一半。' },
      { chapterNumber: 87, keyEvents: '【时点：开箱次日入夜（紧接第86章）】D。', content: '入夜，外廊的灯点到第三盏。' },
      { chapterNumber: 88, keyEvents: '【时点：开箱次日深夜（紧接第87章）】E。', content: '文书桌在收。' },
    ]
    expect(findUnmetTimeAnchorFindings(chapters).map(finding => finding.stableFactKey))
      .toEqual(['chapter-time:anchor-unmet:85'])
  })

  it('the chapter that really does cross into the event day is still reported', () => {
    // 第 84 → 85 是真跨日（开箱日 → 开箱次日），它该报。
    const chapters = [
      { chapterNumber: 84, keyEvents: '【时点：开箱日午后（紧接第83章）】A。', content: '午后。' },
      { chapterNumber: 85, keyEvents: '【时点：开箱次日清晨（紧接第84章）】B。', content: '卯时刚过。' },
    ]
    expect(findUnmetTimeAnchorFindings(chapters).map(finding => finding.stableFactKey))
      .toEqual(['chapter-time:anchor-unmet:85'])
  })

  it('a different event name is a different anchor (not silently same-day)', () => {
    const chapters = [
      { chapterNumber: 84, keyEvents: '【时点：开箱日午后（紧接第83章）】A。', content: '午后。' },
      { chapterNumber: 85, keyEvents: '【时点：开箱次日清晨（紧接第84章）】B。', content: '卯时。' },
      { chapterNumber: 86, keyEvents: '【时点：封箱次日午后（紧接第85章）】C。', content: '午后。' },
    ]
    // 两个不同事件名的「次日」不能互相当成同一天：85 是真跨日、86 也是。
    expect(findUnmetTimeAnchorFindings(chapters).map(finding => finding.stableFactKey))
      .toEqual(['chapter-time:anchor-unmet:85', 'chapter-time:anchor-unmet:86'])
  })
})

/**
 * issue #202：蓝图日序跳回。
 *
 * 现场：第 83 章「第十三日开箱日午前」→ 第 84–88 章全是相对写法（「开箱次日入夜」）
 * → 第 89 章（结案对账）写回「第三日上午」，正文第一句也照抄。
 *
 * 两个问题：
 *  1. 自证矛盾那条判据把**第 83 章**的日序当成「上一章」，于是文案说了一句假话
 *     （「上章标注的是全书第 13 日」，而第 88 章原文里没有「第十三」）；
 *  2. 全书日序回退**没有任何判据**——删掉括注「（紧接第88章次日）」后，一条都不报。
 */
describe('蓝图日序跳回 (issue #202)', () => {
  /** 现场那七张蓝图（第 83–89 章）。 */
  const live = [
    { chapterNumber: 83, keyEvents: '【时点：第十三日开箱日午前】A。', content: '午前。' },
    { chapterNumber: 84, keyEvents: '【时点：开箱日午后（紧接第83章）】B。', content: '午后。' },
    { chapterNumber: 85, keyEvents: '【时点：开箱次日清晨（紧接第84章）】C。', content: '卯时。' },
    { chapterNumber: 86, keyEvents: '【时点：开箱次日午后（紧接第85章）】D。', content: '午后。' },
    { chapterNumber: 87, keyEvents: '【时点：开箱次日入夜（紧接第86章）】E。', content: '入夜。' },
    { chapterNumber: 88, keyEvents: '【时点：开箱次日深夜（紧接第87章）】F。', content: '深夜。' },
    { chapterNumber: 89, keyEvents: '【时点：第三日上午（紧接第88章次日）】G。', content: '第三日上午，公所门板卸下来。' },
  ]

  it('does not pass off a five-chapters-old day as "the previous chapter"', () => {
    // 相对写法那几章把日序清空 → 第 89 章不再拿第 83 章的 13 去比，于是没有人说谎。
    const findings = findTimeAnchorSelfContradictions(live)
    expect(findings.map(finding => finding.stableFactKey)).toEqual([])
  })

  it('still reports a genuine adjacent contradiction (issue #147/#166 不许因此退化)', () => {
    const chapters = [
      // 上一章是第 2 日，本章写第 3 日却还说「紧接上一章」→ 真矛盾，必须照报。
      { chapterNumber: 65, keyEvents: '【时点：第二日正午】A。', content: '正午。' },
      { chapterNumber: 66, keyEvents: '【时点：第三天午后（紧接上一章）】B。', content: '午后。' },
    ]
    const findings = findTimeAnchorSelfContradictions(chapters)
    expect(findings.map(finding => finding.stableFactKey))
      .toEqual(['chapter-time:anchor-self-contradiction:66'])
  })

  it('names the chapter the day ordinal actually came from', () => {
    const chapters = [
      { chapterNumber: 80, keyEvents: '【时点：第十日】A。', content: 'A。' },
      // 81 没标时点（不是相对写法），日序仍是第 80 章那个 —— 文案要点名第 80 章。
      { chapterNumber: 81, keyEvents: '本章无时点。', content: 'B。' },
      { chapterNumber: 82, keyEvents: '【时点：第二日（紧接上一章）】C。', content: 'C。' },
    ]
    const finding = findTimeAnchorSelfContradictions(chapters)[0]!
    expect(finding.stableFactKey).toBe('chapter-time:anchor-self-contradiction:82')
    expect(finding.evidence).toContain('第 80 章')
    expect(finding.evidence).not.toContain('上章标注')
  })

  it('reports the whole-book day regression that neither existing criterion can see', () => {
    const findings = findOrdinalRegressionFindings(live)
    expect(findings.map(finding => finding.stableFactKey))
      .toEqual(['chapter-time:ordinal-regression:89'])
    const finding = findings[0]!
    // 证据必须能落到具体章：是第 83 章已经写到第 13 日。
    expect(finding.evidence).toContain('第 3 日')
    expect(finding.evidence).toContain('第 83 章')
    expect(finding.evidence).toContain('第 13 日')
    expect(finding.sourceChapter).toBe(89)
  })

  it('sees the regression even when the "紧接" parenthetical is deleted', () => {
    // 这正是 #202 的核心：删掉括注后自证矛盾那条 0 条，回退必须仍被看见。
    const withoutParenthetical = live.map(chapter => chapter.chapterNumber === 89
      ? { ...chapter, keyEvents: '【时点：第三日上午】G。' }
      : chapter)
    expect(findTimeAnchorSelfContradictions(withoutParenthetical)).toEqual([])
    expect(findOrdinalRegressionFindings(withoutParenthetical).map(finding => finding.stableFactKey))
      .toEqual(['chapter-time:ordinal-regression:89'])
  })

  it('stays quiet on a monotonically advancing timeline', () => {
    const chapters = [
      { chapterNumber: 1, keyEvents: '【时点：第一日】A。', content: 'A。' },
      { chapterNumber: 2, keyEvents: '【时点：第三日（紧接第二章）】B。', content: 'B。' },
      { chapterNumber: 3, keyEvents: '【时点：第三日深夜至第四日清晨】C。', content: 'C。' },
      { chapterNumber: 4, keyEvents: '【时点：次日清晨】D。', content: 'D。' },
      { chapterNumber: 5, keyEvents: '【时点：第七日】E。', content: 'E。' },
    ]
    expect(findOrdinalRegressionFindings(chapters)).toEqual([])
  })

  it('reads chapters in chapter order regardless of the caller’s array order', () => {
    const shuffled = [live[6]!, live[0]!, live[3]!, live[1]!, live[5]!, live[2]!, live[4]!]
    expect(findOrdinalRegressionFindings(shuffled).map(finding => finding.stableFactKey))
      .toEqual(['chapter-time:ordinal-regression:89'])
  })

  it('does not regress when only the interval head goes back inside one chapter', () => {
    // 区间 [第七日深夜, 第八日清晨] 写在同一张蓝图里 → 首端 7 比 reached 7 不小，不报。
    const chapters = [
      { chapterNumber: 1, keyEvents: '【时点：第七日】A。', content: 'A。' },
      { chapterNumber: 2, keyEvents: '【时点：第七日深夜至第八日清晨】B。', content: 'B。' },
    ]
    expect(findOrdinalRegressionFindings(chapters)).toEqual([])
  })
})
