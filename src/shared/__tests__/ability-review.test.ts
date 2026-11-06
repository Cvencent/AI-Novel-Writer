import { describe, expect, it } from 'vitest'

import { ABILITY_LIMIT_MAX_CHARS, abilityReviewFindings, buildAbilityReviewPrompt, limitSentencesOf, parseAbilityReview } from '../ability-review'

const LIMITS = ['离船上岸，墨干气散，能力立刻衰减到几乎为零。']
const CHAPTERS = [
  { chapterNumber: 36, content: '他上岸，把袖子里的水泼在青石上，墨又浮起来。' },
  { chapterNumber: 40, content: '他在船舱里核票，墨迹顺着水汽翻上来。' },
]
const request = { limits: LIMITS, chapters: CHAPTERS, language: 'zh-CN' as const }

/**
 * 能力限制被绕过 —— 改由模型判断（issue #163）。
 *
 * 旧 `ability-limit-bypass.ts` 里的正则全是**这本书**的场所与能力表现：
 * `账房|售票亭|柜台|铺子`、`墨(翻|浮)上来`。换本书（能力是「听见残响」、
 * 场地是「医院走廊」）全部静默——而静默在预检里与「没问题」不可区分。
 */
describe('limitSentencesOf', () => {
  it('picks the sentences that carry a limiting cue, without judging their content', () => {
    const worldbuilding = '主角是验票员。离船上岸，墨干气散，能力立刻衰减到几乎为零。船上人多。'
    const picked = limitSentencesOf(worldbuilding)
    expect(picked).toHaveLength(1)
    expect(picked[0]).toContain('衰减')
  })

  it('returns nothing when the worldbuilding declares no limit', () => {
    expect(limitSentencesOf('这是一条夜航船上的故事。')).toEqual([])
  })
})

describe('buildAbilityReviewPrompt', () => {
  it('hands the declared limits to the model instead of matching words itself', () => {
    const { user } = buildAbilityReviewPrompt(request)
    expect(user).toContain('离船上岸')
    expect(user).toContain('第36章')
    // 提示词里不许出现「按这些词找」这类判据。
    expect(user).not.toContain('账房')
  })

  it('forbids reporting silence as a violation', () => {
    expect(buildAbilityReviewPrompt(request).system).toContain('没写不等于绕过')
  })

  it('requires a verbatim quote and a limit from the given list', () => {
    const { system } = buildAbilityReviewPrompt(request)
    expect(system).toContain('逐字引用')
    expect(system).toContain('不要自己造限制')
  })
})

describe('parseAbilityReview', () => {
  const raw = (issues: unknown) => JSON.stringify({ issues })

  it('accepts a report whose quote is in that chapter and whose limit is one of the given ones', () => {
    expect(parseAbilityReview(raw([{
      chapterNumber: 36, quote: '他上岸，把袖子里的水泼在青石上，墨又浮起来。',
      violatedLimit: LIMITS[0], explanation: '上岸后仍成功。',
    }]), request)).toHaveLength(1)
  })

  it('drops a report that invents a limit the author never wrote', () => {
    expect(parseAbilityReview(raw([{
      chapterNumber: 36, quote: '他上岸，把袖子里的水泼在青石上，墨又浮起来。',
      violatedLimit: '不能在同一章用两次', explanation: 'x',
    }]), request)).toEqual([])
  })

  it('drops a report whose quote is not verbatim in that chapter', () => {
    expect(parseAbilityReview(raw([{
      chapterNumber: 36, quote: '他在岸上把墨浮起来。', violatedLimit: LIMITS[0], explanation: 'x',
    }]), request)).toEqual([])
  })

  it('rejects malformed output and accepts an empty answer', () => {
    expect(parseAbilityReview('不是 JSON', request)).toBeNull()
    expect(parseAbilityReview('{"issues":{}}', request)).toBeNull()
    expect(parseAbilityReview(raw([]), request)).toEqual([])
  })
})

describe('abilityReviewFindings', () => {
  it('keys on the chapter', () => {
    const [finding] = abilityReviewFindings([{
      chapterNumber: 36, quote: 'q', violatedLimit: 'l', explanation: 'e',
    }])
    expect(finding!.stableFactKey).toBe('ability:limit-bypassed:36')
  })
})

/**
 * issue #171：喂给模型的限制清单**按文件顺序截前 8 句**，把这本书唯一的硬限制挤了出去。
 *
 * 现场：3480 字世界观里含限制语素的候选句 38 句；「夜航船舱内常年潮润，正是天然触发场；
 * 离船上岸，墨干气散，能力立刻衰减到几乎为零」排在**第 11 位**，从没进过提示词。
 * 喂进去的 8 句里还有 3 句是 Markdown 标题/加粗残句（不是限制），
 * 模型于是拿另一条「靠岸干燥后湿痕干死」当唯一依据，把 10 处「先写了洇湿」的溯读全判成绕过。
 */
describe('limitSentencesOf 取数口径 (issue #171)', () => {
  // 复刻现场结构：前 10 句是机制铺垫，真正的触发条件排在第 11 位之后。
  const filler = Array.from({ length: 10 }, (_, index) => `第${index + 1}条铺垫，记录不能写死，必须重蘸重记。`)
  const trigger = '夜航船舱内常年潮润，正是天然触发场；离船上岸，墨干气散，能力立刻衰减到几乎为零。'
  const worldbuilding = [...filler, trigger, '规矩叫湿票不入底，只有船上那一联能证明你上过船。'].join('\n')

  it('does not truncate by position: a limit past the 8th candidate still reaches the model', () => {
    const picked = limitSentencesOf(worldbuilding)
    // 旧实现在这里返回 8 句且不含触发条件；这正是本报的根因。
    expect(picked.some(sentence => sentence.includes('离船上岸'))).toBe(true)
    expect(picked.length).toBeGreaterThan(8)
  })

  it('bounds by characters instead of sentence count', () => {
    const huge = `${'一句很长很长的铺垫句子，含不能二字。'.repeat(400)}离船上岸，墨干气散，衰减。`
    const picked = limitSentencesOf(huge)
    const chars = picked.reduce((total, sentence) => total + sentence.length, 0)
    expect(chars).toBeLessThanOrEqual(ABILITY_LIMIT_MAX_CHARS)
  })

  it('drops Markdown structural fragments that are not limits at all', () => {
    const worldbuildingWithHeadings = [
      '### 2. 规则漏洞："湿票不入底"',
      '**名字**：',
      '---',
      trigger,
    ].join('\n')
    const picked = limitSentencesOf(worldbuildingWithHeadings)
    expect(picked.some(sentence => /^#{1,6}\s/u.test(sentence))).toBe(false)
    expect(picked.some(sentence => /^-{3,}$/u.test(sentence))).toBe(false)
    // 真正的限制仍然在里面。
    expect(picked.some(sentence => sentence.includes('离船上岸'))).toBe(true)
  })

  it('still returns nothing when the worldbuilding declares no limit', () => {
    expect(limitSentencesOf('这是一条夜航船上的故事。船上人多，码头上也热闹。')).toEqual([])
  })
})

/**
 * issue #171 建议 ④：限制多数是**条件式**的，提示词必须让模型先读条件再判。
 *
 * 现场 10 条误报的共同形态：限制是「**靠岸干燥之后**，湿痕一起干死，读不出来」，
 * 而 10 处正文全部**先写了纸面被水汽洇湿**（条件不成立），溯读成功并不绕过限制。
 * 这条约束写在提示词里（模型判），不写规则——「条件成不成立」要读懂句子。
 */
describe('buildAbilityReviewPrompt 条件式限制 (issue #171)', () => {
  it('tells the model to read the condition inside the limit first', () => {
    const { system } = buildAbilityReviewPrompt(request)
    expect(system).toContain('条件')
    expect(system).toContain('前置条件不成立时，能力成功不算绕过')
  })

  it('keeps the existing guards (silence is not a violation, quote must locate)', () => {
    const { system } = buildAbilityReviewPrompt(request)
    expect(system).toContain('没写不等于绕过')
    expect(system).toContain('逐字引用')
  })

  it('has the same rule on the English side', () => {
    const { system } = buildAbilityReviewPrompt({ ...request, language: 'en-US' })
    expect(system).toContain('CONDITIONAL')
    expect(system).toContain('NOT a violation')
  })
})

/**
 * issue #163 第六批：`ability-budget.ts` 的两张词表下线
 * （`EXHAUSTED_DECLARATION` = 用尽声明、`SUCCESSFUL_USE` = 本书的能力表现）。
 *
 * 同一个按钮上补第二类问题，由模型回答：
 * **同一章内**先声明用尽，随后在没有恢复条件的情况下又成功用了一次。
 */
describe('第二类：先说用尽、随后又成功 (issue #163)', () => {
  const CHAPTERS_KIND2 = [
    { chapterNumber: 44, content: '这一班的水汽已经用完，本次再也不能读。他把手按在票面上，字浮了出来。' },
    { chapterNumber: 45, content: '他把手按在票面上，字浮了出来。这次水汽够。' },
  ]
  const request2 = { limits: LIMITS, chapters: CHAPTERS_KIND2, language: 'zh-CN' as const }
  const raw = (issues: unknown) => JSON.stringify({ issues })
  const EXHAUSTED = '这一班的水汽已经用完，本次再也不能读。'
  const REUSED = '字浮了出来。'

  it('asks the second question in the prompt, without any word list', () => {
    const { system } = buildAbilityReviewPrompt(request2)
    expect(system).toContain('exhausted-then-reused')
    expect(system).toContain('同一章内')
    expect(system).toContain('declaration')
    // 判定「什么叫用尽、什么算又用了一次」不许落成语义词表。
    expect(system).not.toContain('用尽声明表')
    expect(system).not.toContain('溯读')
  })

  it('still runs the second kind when the worldbuilding declares no limit', () => {
    const { system, user } = buildAbilityReviewPrompt({ ...request2, limits: [] })
    expect(system).toContain('限制清单为空时只查第二类')
    expect(user).toContain('没有取到限制句')
    expect(user).toContain('第44章')
  })

  it('has the second question on the English side too', () => {
    const { system } = buildAbilityReviewPrompt({ ...request2, language: 'en-US' })
    expect(system).toContain('SECOND kind')
    expect(system).toContain('exhausted-then-reused')
  })

  it('accepts the second kind only when BOTH quotes locate in the same chapter', () => {
    const issues = parseAbilityReview(raw([{
      kind: 'exhausted-then-reused',
      chapterNumber: 44,
      declaration: EXHAUSTED,
      quote: REUSED,
      explanation: '中间没有写恢复条件。',
    }]), request2)
    expect(issues).toHaveLength(1)
    expect(issues![0]!.kind).toBe('exhausted-then-reused')
    expect(issues![0]!.declaration).toBe(EXHAUSTED)
  })

  it('drops it when the exhaustion claim cannot be located verbatim (author could not find it)', () => {
    const issues = parseAbilityReview(raw([{
      kind: 'exhausted-then-reused',
      chapterNumber: 44,
      declaration: '这句话本章并没有写。',
      quote: REUSED,
      explanation: '',
    }]), request2)
    expect(issues).toEqual([])
  })

  it('drops it when the two quotes come from different chapters', () => {
    // quote 出自 45 章、declaration 出自 44 章 → 不可能是「同一章内部」的矛盾。
    const issues = parseAbilityReview(raw([{
      kind: 'exhausted-then-reused',
      chapterNumber: 45,
      declaration: EXHAUSTED,
      quote: REUSED,
      explanation: '',
    }]), request2)
    expect(issues).toEqual([])
  })

  it('drops an unknown kind instead of guessing (wrong kind gives the author the wrong fix)', () => {
    const issues = parseAbilityReview(raw([{
      kind: 'some-new-kind',
      chapterNumber: 44,
      quote: REUSED,
      violatedLimit: LIMITS[0],
      explanation: '',
    }]), request2)
    expect(issues).toEqual([])
  })

  it('does not require a limit for the second kind (a limit is not part of that claim)', () => {
    const issues = parseAbilityReview(raw([{
      kind: 'exhausted-then-reused',
      chapterNumber: 44,
      declaration: EXHAUSTED,
      quote: REUSED,
      explanation: '',
    }]), { ...request2, limits: [] })
    expect(issues).toHaveLength(1)
  })

  it('keys the second kind on chapter + the claim, so two claims in one chapter stay separate', () => {
    const [first, second] = abilityReviewFindings([
      { kind: 'exhausted-then-reused', chapterNumber: 44, quote: REUSED, violatedLimit: '', declaration: EXHAUSTED, explanation: '' },
      { kind: 'exhausted-then-reused', chapterNumber: 44, quote: REUSED, violatedLimit: '', declaration: '另一项资源也见底了。', explanation: '' },
    ])
    expect(first!.stableFactKey).toContain('ability:exhausted-then-reused:44:')
    expect(first!.stableFactKey).not.toBe(second!.stableFactKey)
    expect(first!.evidence).toContain(EXHAUSTED)
    expect(first!.suggestion.zhCN).toContain('恢复条件')
  })
})
