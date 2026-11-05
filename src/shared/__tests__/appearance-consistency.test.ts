import { describe, expect, it } from 'vitest'

import {
  APPEARANCE_REVIEW_RECENT_CHAPTERS,
  buildAppearanceReviewPrompt,
  parseAppearanceReview,
  parseAppearanceUsage,
} from '../appearance-consistency'

const CARD = {
  name: '叶九',
  appearance: '灰布长衫，袖口嵌着墨垢，右小指缺半节，随身带铜墨盒与竹尺。',
  notes: '右手小指的旧伤是沉船那夜留下的。',
}
const CHAPTERS = [
  { chapterNumber: 5, content: '叶九站在桌对面，右手垂下，缺半节的小指缩在掌心里。' },
  { chapterNumber: 51, content: '笑停在脸上。叶九的左手从袖里出来，缺半节的小指往后一收。' },
]
const request = { chapters: CHAPTERS, cards: [CARD], language: 'zh-CN' as const }

/**
 * issue #153：角色卡的外观描述与正文对账。
 *
 * ⚠️ **本模块里没有任何词表**。第一版写过
 * `BODY_MARKERS = /缺|断|疤|伤|残/` + `BODY_PARTS = ['小指','虎口',…]`，
 * 被用户 2026-11-05 明确否掉：「不要有任何写死的这种内容的逻辑，内容全让模型去处理」。
 * 现在这里只做三件能断言的事：**喂什么、要什么形状、校验答案能不能核对**。
 */
describe('buildAppearanceReviewPrompt (issue #153)', () => {
  it('carries the cards and the chapters, with names the model can echo back', () => {
    const { system, user } = buildAppearanceReviewPrompt(request)
    expect(user).toContain('叶九')
    expect(user).toContain('右小指缺半节')
    expect(user).toContain('第51章')
    expect(user).toContain('左手从袖里出来')
    expect(system).toContain('characterName')
  })

  it('asks for contradictions only, and forbids reporting silence as a defect', () => {
    const { system } = buildAppearanceReviewPrompt(request)
    // 「这一章没写到卡上的细节」不等于写错——这一条必须写进提示词，
    // 否则模型会把「没提」报成「相悖」（issue #153 第一部分正是这一类，无法判定）。
    expect(system).toContain('不要**报')
    expect(system).toContain('没写不等于写错')
  })

  it('requires a verbatim quote so the author can locate it', () => {
    expect(buildAppearanceReviewPrompt(request).system).toContain('逐字引用')
  })

  it('limits how many chapters are sent, keeping the most recent ones', () => {
    const many = Array.from({ length: APPEARANCE_REVIEW_RECENT_CHAPTERS + 5 }, (_, index) => ({
      chapterNumber: index + 1, content: `第${index + 1}章正文`,
    }))
    const { user } = buildAppearanceReviewPrompt({ chapters: many, cards: [CARD], language: 'zh-CN' })
    expect(user).toContain(`第${APPEARANCE_REVIEW_RECENT_CHAPTERS + 5}章`)
    expect(user).not.toContain('第1章正文')
  })

  it('skips cards with no descriptive text at all', () => {
    const { user } = buildAppearanceReviewPrompt({
      chapters: CHAPTERS, cards: [{ name: '空卡', appearance: '', notes: '' }], language: 'zh-CN',
    })
    expect(user).not.toContain('空卡')
  })
})

describe('parseAppearanceReview (issue #153)', () => {
  const answer = (entries: unknown) => JSON.stringify({ contradictions: entries })

  it('accepts a contradiction whose quote is really in that chapter', () => {
    const hits = parseAppearanceReview(answer([{
      characterName: '叶九', chapterNumber: 51,
      quote: '叶九的左手从袖里出来，缺半节的小指往后一收。',
      explanation: '卡上说右小指，正文写成了左手。',
    }]), request)
    expect(hits).toEqual([{
      characterName: '叶九', chapterNumber: 51,
      quote: '叶九的左手从袖里出来，缺半节的小指往后一收。',
      explanation: '卡上说右小指，正文写成了左手。',
    }])
  })

  it('drops an entry whose quote is not verbatim in that chapter', () => {
    // 引文必须能定位，否则作者无法核对——这一维规则能判，就必须判。
    expect(parseAppearanceReview(answer([{
      characterName: '叶九', chapterNumber: 51, quote: '叶九左手缺了小指。', explanation: 'x',
    }]), request)).toEqual([])
    // 引文在**别的**章里也不算（章号必须对）。
    expect(parseAppearanceReview(answer([{
      characterName: '叶九', chapterNumber: 5,
      quote: '叶九的左手从袖里出来，缺半节的小指往后一收。', explanation: 'x',
    }]), request)).toEqual([])
  })

  it('drops entries naming a character that was not in the cards', () => {
    expect(parseAppearanceReview(answer([{
      characterName: '徐汐', chapterNumber: 51, quote: '笑停在脸上。', explanation: 'x',
    }]), request)).toEqual([])
  })

  it('drops entries pointing at a chapter outside the sampled window', () => {
    expect(parseAppearanceReview(answer([{
      characterName: '叶九', chapterNumber: 2, quote: '叶九站在桌对面', explanation: 'x',
    }]), request)).toEqual([])
  })

  it('rejects malformed output instead of adopting nothing silently', () => {
    // 坏 JSON / 形状不对 → null（由调用方当成一次失败报出来）。
    expect(parseAppearanceReview('不是 JSON', request)).toBeNull()
    expect(parseAppearanceReview('[]', request)).toBeNull()
    expect(parseAppearanceReview('{"items":[]}', request)).toBeNull()
  })

  it('treats an empty answer as a legitimate “nothing contradicts”', () => {
    expect(parseAppearanceReview(answer([]), request)).toEqual([])
  })

  it('tolerates a ```json fence and dedupes identical reports', () => {
    const one = { characterName: '叶九', chapterNumber: 51, quote: '笑停在脸上。', explanation: 'x' }
    const fenced = '```json\n' + answer([one, one]) + '\n```'
    expect(parseAppearanceReview(fenced, request)).toHaveLength(1)
  })
})

/**
 * issue #153 第一部分：角色卡上**有**的显眼标志，正文一次都没用到。
 *
 * 现场量化：7 张卡上 25 个显眼标志，衣着/随身物被写 379 次，身体特征只有 30 次（12.6 倍）；
 * 全叔出场 40 余章「背驼手粗」0 次、邵广海的金戒指 0 次、周叙「眼窝很深」0 次。
 *
 * ⚠️ 这一轴是**提示**不是缺陷（这一章可能真的不需要写它），所以：
 * - 默认**不开**（`checkUsage`），否则每点一次「核对角色外观」都会刷出一堆「本章没写他的戒指」；
 * - 与「相悖」**分开解析**：未使用那一段形状不对，不能把已经判定好的相悖结论一起丢掉。
 */
describe('appearance usage axis (issue #153 第一部分)', () => {
  const usageRequest = { chapters: CHAPTERS, cards: [CARD], language: 'zh-CN' as const, checkUsage: true }

  it('is off by default: the plain request still asks only for contradictions', () => {
    const { system } = buildAppearanceReviewPrompt(request)
    expect(system).not.toContain('unusedMarks')
    expect(system).toContain('{"contradictions"')
  })

  it('asks for coverage too when enabled, with an explicit JSON shape', () => {
    const { system } = buildAppearanceReviewPrompt(usageRequest)
    expect(system).toContain('unusedMarks')
    expect(system).toContain('确实出场')
    // 只有出场的角色才在范围内——否则每个配角都会被报一遍。
    expect(system).toContain('没出场的人不在范围内')
    // 换措辞写同一特征算用上了（按意思判断，不按字面）。
    expect(system).toContain('按**意思**判断')
  })

  it('keeps the contradiction instructions intact in the same prompt', () => {
    const { system } = buildAppearanceReviewPrompt(usageRequest)
    // 两轴同时问，但「没写不等于写错」这条不能因为加了覆盖统计就消失。
    expect(system).toContain('没写不等于写错')
    expect(system).toContain('逐字引用')
  })

  const answer = (usage: unknown) => JSON.stringify({ contradictions: [], unusedMarks: usage })

  it('accepts a mark that is verbatim on the card, keeping only sampled chapter numbers', () => {
    const parsed = parseAppearanceUsage(
      answer([{ characterName: '叶九', mark: '右小指缺半节', chapters: [5, 51, 999], explanation: '只写了衣着' }]),
      usageRequest,
    )
    expect(parsed).toEqual([{
      characterName: '叶九',
      mark: '右小指缺半节',
      chapters: [5, 51],
      explanation: '只写了衣着',
    }])
  })

  it('drops a mark the model paraphrased (the author would search the card and find nothing)', () => {
    // 「右手小指缺失」不在卡上原文里 → 必须丢弃。
    expect(parseAppearanceUsage(
      answer([{ characterName: '叶九', mark: '右手小指缺失', chapters: [5], explanation: 'x' }]),
      usageRequest,
    )).toEqual([])
  })

  it('also accepts a mark taken from the notes field (that is part of the card too)', () => {
    const parsed = parseAppearanceUsage(
      answer([{ characterName: '叶九', mark: '右手小指的旧伤', chapters: [51], explanation: 'x' }]),
      usageRequest,
    )
    expect(parsed).toHaveLength(1)
  })

  it('drops entries for characters that are not on any card', () => {
    expect(parseAppearanceUsage(
      answer([{ characterName: '徐汐', mark: '右小指缺半节', chapters: [5], explanation: 'x' }]),
      usageRequest,
    )).toEqual([])
  })

  it('drops an entry whose chapters are all outside the sampled window', () => {
    // 指的全是没核过的章 → 这条判断没有依据。
    expect(parseAppearanceUsage(
      answer([{ characterName: '叶九', mark: '右小指缺半节', chapters: [301], explanation: 'x' }]),
      usageRequest,
    )).toEqual([])
  })

  it('returns null for malformed output instead of silently adopting nothing', () => {
    expect(parseAppearanceUsage('{not json', usageRequest)).toBeNull()
    expect(parseAppearanceUsage(JSON.stringify({ contradictions: [] }), usageRequest)).toBeNull()
  })

  it('dedupes the same mark reported twice', () => {
    const entry = { characterName: '叶九', mark: '右小指缺半节', chapters: [5], explanation: 'x' }
    expect(parseAppearanceUsage(answer([entry, entry]), usageRequest)).toHaveLength(1)
  })
})
