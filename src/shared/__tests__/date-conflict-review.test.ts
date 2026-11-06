import { describe, expect, it } from 'vitest'

import {
  DATE_CONFLICT_MAX_MENTIONS,
  buildDateConflictPrompt,
  dateConflictFindings,
  dateMentionSentences,
  parseDateConflictReview,
} from '../date-conflict-review'

/**
 * issue #216：同一件事的日期在不同章里不一致，**全链路没有一处对账**。
 *
 * 现场（95 章那本）：周叙父亲那趟船出事的那一夜，第 3/7/12/13/14 章一律写「七月十七」，
 * 到第 95 章变成「九月十七」——
 * ```
 * ch14  林棠指着残字念「……七……十七。」周叙问「哪一年？」她说「你爹出事那趟。」
 * ch95  九，十七。父亲那条船，就是九月十七夜里没回来。
 * ```
 * 第 14 章已经用对白锁死「这个日期 = 父亲出事那趟」，所以第 95 章那个日子没有第二种读法。
 * 错值还进了三层：蓝图 key_events 先写「九，十七」→ 正文照抄 → `chapter_commits.facts_json`
 * 收成事实，后面每一章起草都继承它。
 *
 * 为什么规则做不了：**「这两处日期是不是同一件事」是内容判断**。同一件事可以叫
 * 「爹那趟船」「沉船那夜」「三年前那页旧账」，没有词表追得上；反过来同一个日子也
 * 可能属于互不相干的两件事，按数字硬比全是假阳性。
 */
const ch = (chapterNumber: number, content: string) => ({ chapterNumber, content })

describe('dateMentionSentences：只按**日期写法**取候选 (issue #216)', () => {
  it('picks sentences containing a Chinese-numeral or Arabic date', () => {
    const mentions = dateMentionSentences([
      ch(3, '到了七月十七那页，姓名栏有三个名字叠在一处。'),
      ch(7, '这名字他在旧账上见过，三年前七月十七那页。'),
      ch(95, '九，十七。父亲那条船，就是九月十七夜里没回来。'),
      ch(20, '外廊的灯点到第三盏，没有人说话。'),
    ])
    expect(mentions.map(item => item.mention)).toEqual(['七月十七', '七月十七', '九月十七'])
    // 章号要跟着走（引用校验靠它）。
    expect(mentions.map(item => item.chapterNumber)).toEqual([3, 7, 95])
  })

  it('recognises Arabic digits too, and does not require a 年', () => {
    expect(dateMentionSentences([ch(1, '船期定在 7 月 17 日开航。')]).map(item => item.mention))
      .toEqual(['7 月 17 日'])
  })

  it('splits on quote-aware sentence boundaries so a line of dialogue is not halved', () => {
    // 中文对白里句号常出现在引号内部（#181 的教训）：硬切会把台词切成两半。
    const mentions = dateMentionSentences([ch(14, '林棠说：「零三〇一，七月十七。」周叙没接话。')])
    expect(mentions).toHaveLength(1)
    expect(mentions[0]!.sentence).toContain('七月十七')
    expect(mentions[0]!.sentence).toContain('林棠')
  })

  it('bounds by mention count, not by chapter distance (issue #216 的现场跨了 92 章)', () => {
    /**
     * ⚠️ 第一版按「最近 40 章」收口，**直接把现场漏掉了**：那本 95 章的书，
     * 矛盾两处是第 3 章与第 95 章，40 章窗里只剩第 95 章 → 提示词里只有一个日期，
     * 模型无从对照（语料实测：全量 8 处候选，40 章窗只剩 1 处）。
     * 日期候选本来就稀疏，按章号切窗口是在切**距离**，而这条判据要的就是距离。
     */
    const chapters = Array.from({ length: 120 }, (_, index) => ch(index + 1, `第${index + 1}章写在七月十七那天。`))
    // 120 章、每章一处候选 → 在默认上限内，跨度 120 章的两处都还在提示词里。
    const mentions = dateMentionSentences(chapters)
    expect(mentions[0]!.chapterNumber).toBe(1)
    expect(mentions.at(-1)!.chapterNumber).toBe(120)
  })

  it('keeps the cap high enough for the reported case by a wide margin', () => {
    // 现场那本书 95 章正文里总共只 8 处日期候选 —— 判据要覆盖的是**章距**，
    // 而候选数是稀疏的，所以上限可以给得很大而不撑爆提示词。
    expect(DATE_CONFLICT_MAX_MENTIONS).toBeGreaterThanOrEqual(100)
  })

  it('keeps only the newest candidates once the cap is hit', () => {
    const chapters = Array.from({ length: 300 }, (_, index) => ch(index + 1, `第${index + 1}章写在七月十七那天。`))
    const capped = dateMentionSentences(chapters, 5)
    expect(capped).toHaveLength(5)
    expect(capped.at(-1)!.chapterNumber).toBe(300)
    expect(DATE_CONFLICT_MAX_MENTIONS).toBeGreaterThanOrEqual(50)
  })
})

describe('buildDateConflictPrompt：把「是不是同一件事」交给模型', () => {
  const request = {
    chapters: [ch(3, '到了七月十七那页，姓名栏有三个名字叠在一处。'), ch(95, '父亲那条船，就是九月十七夜里没回来。')],
    language: 'zh-CN' as const,
  }

  it('says plainly that matching words is not the criterion', () => {
    const { system } = buildDateConflictPrompt(request)
    expect(system).toContain('按**意思**判断')
    expect(system).toContain('同一件事可以叫')
  })

  it('warns against both false-positive shapes the issue names', () => {
    const { system } = buildDateConflictPrompt(request)
    // 同一天两处 = 一致，不该报；不同事件同一天 = 巧合，不该报。
    expect(system).toContain('不要报**同一天的两处')
    expect(system).toContain('不同事件恰好同一天')
  })

  it('requires both quotes to be verbatim and asks which value the book supports', () => {
    const { system, user } = buildDateConflictPrompt(request)
    expect(system).toContain('逐字引用')
    expect(system).toContain('全书支持哪一处')
    // 用户消息里要带上章号与原句，模型才有得引。
    expect(user).toContain('第3章')
    expect(user).toContain('七月十七')
    expect(user).toContain('第95章')
  })

  it('switches language without changing the JSON contract', () => {
    const en = buildDateConflictPrompt({ ...request, language: 'en-US' })
    expect(en.system).toContain('same event')
    expect(en.system).toContain('{"issues":')
  })
})

describe('parseDateConflictReview：四条硬校验', () => {
  const request = {
    chapters: [ch(3, '到了七月十七那页。'), ch(95, '父亲那条船，就是九月十七夜里没回来。')],
  }
  const valid = JSON.stringify({ issues: [{
    earlierChapter: 3, laterChapter: 95, earlierMention: '七月十七', laterMention: '九月十七',
    event: '父亲那趟船出事的那一夜', explanation: '前五章都写七月十七',
  }] })

  it('accepts a report whose two quotes are both verbatim in their own chapters', () => {
    expect(parseDateConflictReview(valid, request)).toHaveLength(1)
  })

  it('drops a quote that is not verbatim — the two chapters are checked separately', () => {
    // 引文在**另一章**里存在也不算：必须各自落在自己声明的章。
    const swapped = JSON.stringify({ issues: [{
      earlierChapter: 95, laterChapter: 3, earlierMention: '九月十七', laterMention: '七月十七', event: 'x',
    }] })
    // 章号顺序反了（later 不大于 earlier）→ 整条丢弃。
    expect(parseDateConflictReview(swapped, request)).toEqual([])
    const wrongChapter = JSON.stringify({ issues: [{
      earlierChapter: 3, laterChapter: 95, earlierMention: '九月十七', laterMention: '九月十七', event: 'x',
    }] })
    expect(parseDateConflictReview(wrongChapter, request)).toEqual([])
  })

  it('drops entries with no event description, or out-of-range chapters', () => {
    expect(parseDateConflictReview(JSON.stringify({ issues: [{
      earlierChapter: 3, laterChapter: 95, earlierMention: '七月十七', laterMention: '九月十七', event: '',
    }] }), request)).toEqual([])
    expect(parseDateConflictReview(JSON.stringify({ issues: [{
      earlierChapter: 3, laterChapter: 4242, earlierMention: '七月十七', laterMention: '九月十七', event: 'x',
    }] }), request)).toEqual([])
  })

  it('returns null (not an empty list) when the answer is not JSON at all', () => {
    // null 与 [] 必须分开：前者是「模型没按合同答」，后者是「查过了没问题」（#203 的教训）。
    expect(parseDateConflictReview('我认为没问题。', request)).toBeNull()
    expect(parseDateConflictReview('{"issues":[]}', request)).toEqual([])
  })

  it('tolerates a fenced JSON block', () => {
    expect(parseDateConflictReview('```json\n' + valid + '\n```', request)).toHaveLength(1)
  })
})

describe('dateConflictFindings：key 稳定、文案指向要改的那一处', () => {
  const issue = {
    earlierChapter: 3, laterChapter: 95, earlierMention: '七月十七', laterMention: '九月十七',
    event: '父亲那趟船出事的那一夜', explanation: '前五章都写七月十七',
  }

  it('anchors the key on the later chapter and its date wording (both are facts)', () => {
    const [finding] = dateConflictFindings([issue])
    expect(finding!.stableFactKey).toBe('date:conflict:95:九月十七')
    expect(finding!.sourceChapter).toBe(95)
  })

  it('names both chapters and both values in the evidence', () => {
    const [finding] = dateConflictFindings([issue])
    expect(finding!.evidence).toContain('第3章')
    expect(finding!.evidence).toContain('七月十七')
    expect(finding!.evidence).toContain('第95章')
    expect(finding!.evidence).toContain('九月十七')
  })

  it('tells the author to fix the ledger too, not just the prose', () => {
    // 现场那个错值已经进了 chapter_commits.facts_json：只改正文，下一章起草还会读到错值。
    const [finding] = dateConflictFindings([issue])
    expect(finding!.suggestion.zhCN).toContain('事实账本')
  })

  it('does not hardcode a gender pronoun (issue #217)', () => {
    const [finding] = dateConflictFindings([issue])
    const copy = `${finding!.issue.zhCN}${finding!.evidence}${finding!.suggestion.zhCN}`.replace(/其他/gu, '')
    expect(copy).not.toMatch(/[他她]/u)
  })
})
