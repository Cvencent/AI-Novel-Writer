import { describe, expect, it } from 'vitest'

import {
  buildPromisePolarityPrompt,
  parsePromisePolarityReview,
  promisePolarityFindings,
} from '../promise-polarity-review'

const CHAPTERS = [
  { chapterNumber: 60, content: '「答应我。座号不写进任何册。」周叙看着册页，第三格还空着。' },
  { chapterNumber: 63, content: '「你答应过写进册。」温珩把册子推过来。' },
  { chapterNumber: 64, content: '「你的座号，我不往册上写。」周叙说。' },
]
const request = { chapters: CHAPTERS, language: 'zh-CN' as const }

/**
 * issue #142 / #163 第七批：口头约定方向被复述反——**由模型判断**。
 *
 * 旧 `promise-polarity.ts` 靠承诺动词表 + 动作短语字符类，换本书
 * （立契/按手印/起誓）全部静默。新模块只做簿记（章号/引文定位），判断交模型。
 */
describe('buildPromisePolarityPrompt (issue #163 第七批)', () => {
  it('hands both chapters to the model and asks for opposite-direction restatements', () => {
    const { user } = buildPromisePolarityPrompt(request)
    expect(user).toContain('第60章')
    expect(user).toContain('座号不写进任何册')
    const { system } = buildPromisePolarityPrompt(request)
    expect(system).toContain('相反方向')
    expect(system).toContain('逐字引用')
    // 不含词表痕迹：旧实现的那张动词表不许出现在提示词里。
    expect(system).not.toContain('答应』,')
    expect(system).not.toContain('PROMISE_VERBS')
  })

  it('forbids the three look-alikes: exact fulfilment, different matter, same direction', () => {
    const { system } = buildPromisePolarityPrompt(request)
    expect(system).toContain('按原方向兑现')
    expect(system).toContain('另一件事')
    expect(system).toContain('方向一致')
  })

  it('has the same rule on the English side', () => {
    const { system } = buildPromisePolarityPrompt({ ...request, language: 'en-US' })
    expect(system).toContain('OPPOSITE direction')
    expect(system).toContain('quote BOTH sentences verbatim')
  })
})

describe('parsePromisePolarityReview (issue #163 第七批)', () => {
  const raw = (issues: unknown) => JSON.stringify({ issues })
  const issue = {
    firstChapterNumber: 60,
    secondChapterNumber: 63,
    firstQuote: '「答应我。座号不写进任何册。」',
    secondQuote: '「你答应过写进册。」',
    explanation: '同一个座号约定，先说不写、后说答应过写',
  }

  it('keeps a report whose quotes both locate verbatim', () => {
    expect(parsePromisePolarityReview(raw([issue]), request)).toEqual([issue])
  })

  it('drops a report whose quote the model paraphrased', () => {
    expect(parsePromisePolarityReview(
      raw([{ ...issue, secondQuote: '你答应过要把座号写进册子里。' }]),
      request,
    )).toEqual([])
  })

  it('drops reports about chapters outside the request', () => {
    expect(parsePromisePolarityReview(raw([{ ...issue, secondChapterNumber: 999 }]), request)).toEqual([])
  })

  it('rejects malformed output instead of silently adopting nothing', () => {
    expect(parsePromisePolarityReview('{not json', request)).toBeNull()
    expect(parsePromisePolarityReview(JSON.stringify({ contradictions: [] }), request)).toBeNull()
  })

  it('dedupes the same report twice', () => {
    expect(parsePromisePolarityReview(raw([issue, issue]), request)).toHaveLength(1)
  })
})

describe('promisePolarityFindings (issue #163 第七批)', () => {
  const issue = {
    firstChapterNumber: 60,
    secondChapterNumber: 63,
    firstQuote: '「答应我。座号不写进任何册。」',
    secondQuote: '「你答应过写进册。」',
    explanation: '',
  }

  it('anchors the key on both chapters + the original quote (distinct matters stay distinct)', () => {
    const [finding] = promisePolarityFindings([issue])
    expect(finding!.stableFactKey).toContain('promise:polarity:60:63:')
    const second = promisePolarityFindings([{ ...issue, firstQuote: '另一件事的约定原句。', secondQuote: '复述。', explanation: '' }])
    expect(second[0]!.stableFactKey).not.toBe(finding!.stableFactKey)
  })

  it('offers the two concrete repairs (align / visible misremembering)', () => {
    const [finding] = promisePolarityFindings([issue])
    expect(finding!.suggestion.zhCN).toContain('改回与首次约定一致')
    expect(finding!.suggestion.zhCN).toContain('可辨认的错误')
    expect(finding!.suggestion.enUS).toContain('visibly a mistake')
  })

  it('says nothing when no conflict was reported', () => {
    expect(promisePolarityFindings([])).toEqual([])
  })
})
