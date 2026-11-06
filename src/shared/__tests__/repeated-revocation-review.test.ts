import { describe, expect, it } from 'vitest'

import {
  buildRepeatedRevocationPrompt,
  parseRepeatedRevocationReview,
  repeatedRevocationFindings,
} from '../repeated-revocation-review'

const LEDGER = [
  { chapterNumber: 12, costs: '售票口的位置从此不再属于她。' },
  { chapterNumber: 47, costs: '她又把售票口那格的丧失宣告了一遍。' },
]
const PROSE = [
  { chapterNumber: 34, content: '她照常在柜台边帮工，仿佛那格还等着她。' },
  { chapterNumber: 47, content: '「售票口那格，早就不属于她了。」账房说。' },
]
const request = { ledger: LEDGER, prose: PROSE, language: 'zh-CN' as const }

/**
 * issue #105 / #163 第九批：同一项不可逆丧失被宣告两次——**由模型判断**。
 *
 * 旧 `repeated-revocation.ts` 靠三张表（不可逆标志/本书位置名词/过手动作），
 * 换本书（茶馆/医院/官衙）全部静默；「这两处宣告的是不是同一项处境」要读懂句子。
 */
describe('buildRepeatedRevocationPrompt (issue #163 第九批)', () => {
  it('hands both the ledger and the prose to the model, asks for double declarations', () => {
    const { system, user } = buildRepeatedRevocationPrompt(request)
    expect(system).toContain('宣告两次')
    expect(system).toContain('逐字引用')
    expect(system).toContain('不要报')
    expect(user).toContain('账本第12章')
    expect(user).toContain('售票口的位置从此不再属于她')
    expect(user).toContain('正文第47章')
    // 词表痕迹禁绝。
    expect(system).not.toContain('柜台')
    expect(system).not.toContain('STATE_NOUNS')
  })

  it('forbids the look-alikes: on-page recovery, different loss, same wording', () => {
    const { system } = buildRepeatedRevocationPrompt(request)
    expect(system).toContain('恢复过、之后又失去')
    expect(system).toContain('两件不同损失')
    expect(system).toContain('措辞一致的复述')
  })

  it('has the same rule on the English side', () => {
    const { system } = buildRepeatedRevocationPrompt({ ...request, language: 'en-US' })
    expect(system).toContain('declared TWICE')
    expect(system).toContain('quote BOTH declarations verbatim')
  })
})

describe('parseRepeatedRevocationReview (issue #163 第九批)', () => {
  const raw = (issues: unknown) => JSON.stringify({ issues })
  const issue = {
    firstChapterNumber: 12,
    secondChapterNumber: 47,
    firstQuote: '售票口的位置从此不再属于她。',
    secondQuote: '「售票口那格，早就不属于她了。」账房说。',
    explanation: '同一格位的丧失被宣告两次',
  }

  it('keeps a report whose quotes locate in the ledger and the prose respectively', () => {
    expect(parseRepeatedRevocationReview(raw([issue]), request)).toEqual([issue])
  })

  it('drops a report whose ledger quote does not locate', () => {
    expect(parseRepeatedRevocationReview(
      raw([{ ...issue, firstQuote: '账本里没有这句话。' }]),
      request,
    )).toEqual([])
  })

  it('drops a report about chapters outside the request', () => {
    expect(parseRepeatedRevocationReview(raw([{ ...issue, secondChapterNumber: 999 }]), request)).toEqual([])
  })

  it('rejects malformed output instead of silently adopting nothing', () => {
    expect(parseRepeatedRevocationReview('{not json', request)).toBeNull()
    expect(parseRepeatedRevocationReview(JSON.stringify({ repeats: [] }), request)).toBeNull()
  })

  it('dedupes the same report twice', () => {
    expect(parseRepeatedRevocationReview(raw([issue, issue]), request)).toHaveLength(1)
  })
})

describe('repeatedRevocationFindings (issue #163 第九批)', () => {
  const issue = {
    firstChapterNumber: 12,
    secondChapterNumber: 47,
    firstQuote: '售票口的位置从此不再属于她。',
    secondQuote: '「售票口那格，早就不属于她了。」账房说。',
    explanation: '',
  }

  it('anchors the key on both chapters + the ledger quote (distinct losses stay distinct)', () => {
    const [finding] = repeatedRevocationFindings([issue])
    expect(finding!.stableFactKey).toContain('repeated-revocation:12:47:')
    const second = repeatedRevocationFindings([{ ...issue, firstQuote: '另一项损失的原句。' }])
    expect(second[0]!.stableFactKey).not.toBe(finding!.stableFactKey)
  })

  it('offers the two concrete repairs (delete / give it a reason)', () => {
    const [finding] = repeatedRevocationFindings([issue])
    expect(finding!.suggestion.zhCN).toContain('删掉第二次宣告')
    expect(finding!.suggestion.zhCN).toContain('存在的理由')
    expect(finding!.suggestion.enUS).toContain('reason to exist')
  })

  it('says nothing when no conflict was reported', () => {
    expect(repeatedRevocationFindings([])).toEqual([])
  })
})
