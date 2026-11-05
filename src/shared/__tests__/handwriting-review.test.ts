import { describe, expect, it } from 'vitest'

import {
  HANDWRITING_REVIEW_RECENT_CHAPTERS,
  buildHandwritingReviewPrompt,
  handwritingReviewFindings,
  parseHandwritingReview,
} from '../handwriting-review'

/**
 * issue #97 的现场 + issue #163 的迁移：笔迹特征自相矛盾。
 *
 * 现场原文：第 11 章「第一层墨浮起来——叶九的，**横折收得急**」，
 * 第 13 章「最上头是**叶九的手，稳、匀，起笔带锋**」——同一个叶九，两套互斥特征；
 * 而第 19 章「不是叶九的手」这条推理，用来排除他的正是第 11 章判给他的反面。
 *
 * ⚠️ 旧实现是四张书写质量词表（稳匀/急促/重笔/轻笔）+ 归属句正则，按用户 2026-11-05 的定规
 * （「不能去设计词表，也不能用任何的短语匹配」）整族改由模型判。本文件里**没有任何词表**：
 * 规则只负责喂样本、校验两处引文、把答案收窄。
 */
const chapters = [
  { chapterNumber: 11, content: '第一层墨浮起来——叶九的，横折收得急。' },
  { chapterNumber: 13, content: '最上头是叶九的手，稳、匀，起笔带锋。' },
  { chapterNumber: 17, content: '笔压和旧票夹里父亲留的纸条一模一样，起笔轻，收笔回锋。' },
]
const castNames = ['周叙', '温珩', '叶九', '柯明远', '全叔']

describe('buildHandwritingReviewPrompt (issue #97 / #163)', () => {
  it('carries the chapters and the cast names so the model can attribute by itself', () => {
    const { user, system } = buildHandwritingReviewPrompt({ chapters, castNames, language: 'zh-CN' })
    expect(user).toContain('横折收得急')
    expect(user).toContain('起笔带锋')
    expect(system).toContain('叶九')
    // 归属由模型判（旧实现靠句式正则抽人），所以名册要进提示词。
    expect(system).toContain('已知角色名')
  })

  it('asks only for mutually exclusive traits on the same writer', () => {
    const { system } = buildHandwritingReviewPrompt({ chapters, castNames, language: 'zh-CN' })
    expect(system).toContain('同一个书写者')
    expect(system).toContain('不能同时成立')
    // 绝不跨人比较——两个不同的人笔迹不同是正常的。
    expect(system).toContain('绝不跨人比较')
  })

  it('excludes changes the prose itself explains, and keeps the no-word-list rule', () => {
    const { system } = buildHandwritingReviewPrompt({ chapters, castNames, language: 'zh-CN' })
    expect(system).toContain('自己交代过')
    // 用户 2026-11-05 定规：按意思判断，不按固定词表。
    expect(system).toContain('按**意思**判断')
    expect(system).not.toMatch(/以下词|命中任一|封闭集合/u)
    // 旧实现的四张表名不能出现在判据里（它们只可能来自我们喂进去的样本）。
    expect(system).not.toContain('稳匀族')
    expect(system).not.toContain('重笔族')
  })

  it('requires both quotes so the author can locate the two sides', () => {
    const { system } = buildHandwritingReviewPrompt({ chapters, castNames, language: 'zh-CN' })
    expect(system).toContain('逐字引用两处')
    expect(system).toContain('引不出来就不要报')
  })

  it('bounds the window', () => {
    expect(HANDWRITING_REVIEW_RECENT_CHAPTERS).toBeLessThanOrEqual(50)
    const many = Array.from({ length: HANDWRITING_REVIEW_RECENT_CHAPTERS + 3 }, (_, index) => ({
      chapterNumber: index + 1, content: `第${index + 1}章正文。`,
    }))
    const { user } = buildHandwritingReviewPrompt({ chapters: many, castNames, language: 'zh-CN' })
    expect(user).toContain(`第${HANDWRITING_REVIEW_RECENT_CHAPTERS + 3}章`)
    expect(user).not.toContain('### 第1章')
  })
})

describe('parseHandwritingReview (issue #97 / #163)', () => {
  const request = { chapters }

  const conflict = {
    owner: '叶九',
    chapterNumber: 11,
    quote: '叶九的，横折收得急',
    conflictingChapterNumber: 13,
    conflictingQuote: '叶九的手，稳、匀，起笔带锋',
    explanation: '同一支笔不能既急又稳',
  }

  it('keeps a conflict whose two quotes both locate verbatim', () => {
    expect(parseHandwritingReview(JSON.stringify({ conflicts: [conflict] }), request)).toEqual([conflict])
  })

  it('drops the report when either quote is not in the chapter it names', () => {
    // 把 ch11 的句子说成 ch17 的 → 作者按它去核会翻空。
    expect(parseHandwritingReview(JSON.stringify({ conflicts: [{ ...conflict, conflictingChapterNumber: 17 }] }), request)).toEqual([])
    expect(parseHandwritingReview(JSON.stringify({ conflicts: [{ ...conflict, quote: '叶九的笔很急' }] }), request)).toEqual([])
  })

  it('keeps a report with no explanation (explanation is a nicety, not a requirement)', () => {
    const parsed = parseHandwritingReview(JSON.stringify({ conflicts: [{ ...conflict, explanation: '' }] }), request)
    expect(parsed).toHaveLength(1)
  })

  it('drops reports with an empty owner and out-of-range chapters', () => {
    expect(parseHandwritingReview(JSON.stringify({ conflicts: [{ ...conflict, owner: '  ' }] }), request)).toEqual([])
    expect(parseHandwritingReview(JSON.stringify({ conflicts: [{ ...conflict, chapterNumber: 999 }] }), request)).toEqual([])
  })

  it('rejects malformed output instead of silently adopting nothing', () => {
    expect(parseHandwritingReview('{not json', request)).toBeNull()
    expect(parseHandwritingReview(JSON.stringify({ contradictions: [] }), request)).toBeNull()
  })

  it('dedupes the same report twice', () => {
    expect(parseHandwritingReview(JSON.stringify({ conflicts: [conflict, conflict] }), request)).toHaveLength(1)
  })
})

describe('handwritingReviewFindings (issue #97 / #163)', () => {
  const conflict = {
    owner: '叶九',
    chapterNumber: 11,
    quote: '叶九的，横折收得急',
    conflictingChapterNumber: 13,
    conflictingQuote: '叶九的手，稳、匀，起笔带锋',
    explanation: '同一支笔不能既急又稳',
  }

  it('names both sides and points at the earliest chapter', () => {
    const [finding] = handwritingReviewFindings([conflict])
    expect(finding!.stableFactKey).toBe('handwriting:conflict:叶九')
    expect(finding!.sourceChapter).toBe(11)
    expect(finding!.evidence).toContain('横折收得急')
    expect(finding!.evidence).toContain('起笔带锋')
  })

  it('merges several conflicts of one writer into one finding (ack must not swallow the rest)', () => {
    const second = { ...conflict, chapterNumber: 17, quote: '起笔轻，收笔回锋', conflictingChapterNumber: 13 }
    // ch17 那句属于「父亲」，但这里只测合并：同一 owner 的两处必须收成一条。
    const findings = handwritingReviewFindings([conflict, second])
    expect(findings).toHaveLength(1)
    expect(findings[0]!.evidence).toContain('横折收得急')
    expect(findings[0]!.evidence).toContain('起笔轻')
  })

  it('keeps the key anchored on the writer, never on a rolling chapter number', () => {
    const [finding] = handwritingReviewFindings([conflict])
    // #86/#89/#98/#108：key 带章号会随章滚动，作者点「我已知」永远关不掉。
    expect(finding!.stableFactKey).not.toMatch(/:\d+$/u)
    const later = handwritingReviewFindings([{ ...conflict, chapterNumber: 40, conflictingChapterNumber: 44 }])
    expect(later[0]!.stableFactKey).toBe(finding!.stableFactKey)
  })

  it('offers both exits and mentions making the change plot', () => {
    const [finding] = handwritingReviewFindings([conflict])
    expect(finding!.suggestion.zhCN).toContain('固定下来')
    expect(finding!.suggestion.zhCN).toContain('为什么会变')
    expect(finding!.issue.enUS).toContain('mutually exclusive')
  })

  it('says nothing when the model found no conflict', () => {
    expect(handwritingReviewFindings([])).toEqual([])
  })
})