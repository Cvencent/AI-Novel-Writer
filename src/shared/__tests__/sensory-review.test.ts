import { describe, expect, it } from 'vitest'

import {
  SENSORY_MIN_CHAPTERS,
  SENSORY_REVIEW_RECENT_CHAPTERS,
  SMELL_CHAPTER_SHARE_FLOOR,
  buildSensoryReviewPrompt,
  parseSensoryReview,
  summarizeSensoryVerdicts,
} from '../sensory-review'

const CHAPTERS = Array.from({ length: 20 }, (_, index) => ({
  chapterNumber: index + 1,
  content: `第${index + 1}章正文：他把缆绳搁下。`,
}))
const request = { chapters: CHAPTERS, language: 'zh-CN' as const }

/**
 * issue #151 的**规则修正**：感官通道覆盖改由模型判断。
 *
 * 旧实现用 `SMELL_WORDS = ['腥气','霉味',…]` 这类词表去数。用户 2026-11-05 明确否掉：
 * 「不能去设计词表，也不能用任何的短语匹配，内容类的全部让模型判断。」
 *
 * 反证就在我自己踩过的坑里：「一炷香」是计时器、「叮嘱」不是拟声、
 * 「锁舌咬得不紧」不是味觉、「何尝不想」不是尝——**每一条都是我事后补的补丁**，
 * 而中文里还有无数种我没想到的写法。
 */
describe('buildSensoryReviewPrompt (issue #151 规则修正)', () => {
  it('asks for a per-chapter verdict, not a word count', () => {
    const { system, user } = buildSensoryReviewPrompt(request)
    expect(user).toContain('第1章')
    expect(system).toContain('"smell"')
    expect(system).toContain('"taste"')
    expect(system).toContain('"sound"')
  })

  it('warns against the exact false positives a word list would make', () => {
    // 提示词必须把「字面含某个字 ≠ 写了这个通道」说清楚，否则模型会犯与词表同一个错。
    const { system } = buildSensoryReviewPrompt(request)
    expect(system).toContain('比喻不算')
    expect(system).toContain('字面上含某个字')
    expect(system).toContain('一炷香')
    expect(system).toContain('锁舌咬得不紧')
  })

  it('limits how many chapters are sent, keeping the most recent', () => {
    const many = Array.from({ length: SENSORY_REVIEW_RECENT_CHAPTERS + 3 }, (_, index) => ({
      chapterNumber: index + 1, content: `第${index + 1}章`,
    }))
    const { user } = buildSensoryReviewPrompt({ chapters: many, language: 'zh-CN' })
    expect(user).toContain(`第${SENSORY_REVIEW_RECENT_CHAPTERS + 3}章`)
    expect(user).not.toContain('第1章正文')
  })
})

describe('parseSensoryReview (issue #151 规则修正)', () => {
  const answer = (entries: unknown) => JSON.stringify({ chapters: entries })
  const verdict = (chapterNumber: number, smell: boolean) => ({ chapterNumber, smell, taste: false, sound: false })

  it('accepts verdicts for the chapters that were sent', () => {
    expect(parseSensoryReview(answer([verdict(1, true), verdict(2, false)]), request)).toEqual([
      { chapterNumber: 1, smell: true, taste: false, sound: false },
      { chapterNumber: 2, smell: false, taste: false, sound: false },
    ])
  })

  it('drops verdicts for chapters that were not sent', () => {
    // 模型数错章（或编了一章）→ 丢弃，不要把它算进占比。
    expect(parseSensoryReview(answer([verdict(99, true)]), request)).toEqual([])
  })

  it('drops an entry that does not answer all three channels', () => {
    // 缺字段就丢弃这一章，不替它猜 false（猜了会把占比算低）。
    expect(parseSensoryReview(answer([{ chapterNumber: 1, smell: true, taste: false }]), request)).toEqual([])
    expect(parseSensoryReview(answer([{ chapterNumber: 1, smell: 'yes', taste: false, sound: false }]), request)).toEqual([])
  })

  it('rejects malformed output instead of adopting nothing silently', () => {
    expect(parseSensoryReview('不是 JSON', request)).toBeNull()
    expect(parseSensoryReview('[]', request)).toBeNull()
    expect(parseSensoryReview('{"items":[]}', request)).toBeNull()
  })

  it('keeps one entry per chapter and tolerates a ```json fence', () => {
    const fenced = '```json\n' + answer([verdict(1, true), verdict(1, false)]) + '\n```'
    expect(parseSensoryReview(fenced, request)).toEqual([{ chapterNumber: 1, smell: true, taste: false, sound: false }])
  })
})

describe('summarizeSensoryVerdicts (issue #151 规则修正)', () => {
  const verdict = (chapterNumber: number, smell: boolean) => ({ chapterNumber, smell, taste: false, sound: false })

  it('is pure arithmetic — no content judgement lives here', () => {
    const summary = summarizeSensoryVerdicts([verdict(1, true), verdict(2, false), verdict(3, true)])
    expect(summary).toMatchObject({
      total: 3, smellChapters: [1, 3], silentChapters: [2], smellShare: 2 / 3,
    })
  })

  it('flags a stretch as sparse only below the floor and with enough chapters', () => {
    const mostlySilent = Array.from({ length: SENSORY_MIN_CHAPTERS }, (_, index) => verdict(index + 1, index === 0))
    expect(summarizeSensoryVerdicts(mostlySilent).sparse).toBe(true)
    // 样本不足时占比没有意义 → 不判。
    expect(summarizeSensoryVerdicts(mostlySilent.slice(0, SENSORY_MIN_CHAPTERS - 1)).sparse).toBe(false)
    // 达到地板就不报。
    const enough = Array.from({ length: 10 }, (_, index) => verdict(index + 1, index < 4))
    expect(summarizeSensoryVerdicts(enough).sparse).toBe(false)
  })

  it('documents the threshold so it is not silently re-tuned', () => {
    expect(SMELL_CHAPTER_SHARE_FLOOR).toBe(0.3)
  })
})
