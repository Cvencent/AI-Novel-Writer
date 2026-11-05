import { describe, expect, it } from 'vitest'

import { abilityReviewFindings, buildAbilityReviewPrompt, limitSentencesOf, parseAbilityReview } from '../ability-review'

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
