import { describe, expect, it } from 'vitest'

import {
  PROSE_CONFLICT_MAX_EARLIER_CHARS,
  buildProseConflictPrompt,
  parseProseConflictReview,
  proseConflictFindings,
} from '../prose-conflict-review'

/**
 * issue #157：蓝图把某件事写成「一向如此」，而已定稿正文明写「没发生」。
 *
 * 现场：第 25 章蓝图 `foreshadowing` 写「码头老位置**每日一停**」，
 * 第 24 章定稿写「回程经过码头老位置。**脚底下没慢，也没停。**」
 *
 * 这一族原来两侧都没人看：时点判据（#132）只比分日，伏笔判据（#68）只判送达，
 * 断言反转（#52）只认「是X/不是X」。而 issue 建议的「频率词封闭集合 + 否定词匹配」
 * 正是用户 2026-11-05 明令禁止的写法——所以这里**没有词表**，规则只负责摆样本与校验引文。
 */
const earlier = [
  { chapterNumber: 23, content: '回程他慢了半步。慢完还是往前走开了。' },
  { chapterNumber: 24, content: '回程经过码头老位置。脚底下没慢，也没停。走出十几步，手探进内衬，把木戳摸出来看了一眼，又揣回去。' },
]

const claims = [{ chapterNumber: 25, claims: '这格不稳；码头老位置每日一停却想不起缘由；木戳磨平、干印泥并排收进案角抽屉。' }]

describe('buildProseConflictPrompt (issue #157)', () => {
  it('puts the blueprint claims and the finalized prose side by side', () => {
    const { system, user } = buildProseConflictPrompt({ claims, earlierChapters: earlier, language: 'zh-CN' })
    expect(user).toContain('每日一停')
    expect(user).toContain('脚底下没慢，也没停')
    expect(user).toContain('第24章')
    // 模型必须知道「蓝图说这一章将发生什么」不算对过去的追认。
    expect(system).toContain('这一章将要发生什么')
  })

  it('requires verbatim quotes on both sides and forbids guessing', () => {
    const { system } = buildProseConflictPrompt({ claims, earlierChapters: earlier, language: 'zh-CN' })
    expect(system).toContain('逐字引用')
    expect(system).toContain('不确定就不要报')
    // 反面：正文里没提过，不是冲突。
    expect(system).toContain('根本没提过')
  })

  it('does not build any frequency-word list: the model decides what counts as a habit claim', () => {
    const { system } = buildProseConflictPrompt({ claims, earlierChapters: earlier, language: 'zh-CN' })
    // 用户 2026-11-05 定规：内容判断不许写词表/短语匹配。
    // 提示词里出现的是「按意思判断」，不是「命中以下词之一」。
    expect(system).not.toMatch(/每天\|每日\|一向\|照旧/u)
    expect(system).not.toMatch(/封闭集合|以下词语|命中任一/u)
  })

  it('feeds the newest chapters first and declares truncation', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      chapterNumber: index + 1,
      content: `第${index + 1}章正文。`.repeat(400),
    }))
    const { user } = buildProseConflictPrompt({ claims, earlierChapters: many, language: 'zh-CN', maxEarlierChars: 20_000 })
    // 由近及远：最近那章必须在内，最早那章可以不在。
    expect(user).toContain('### 第40章')
    expect(user).not.toContain('### 第1章')
    // 截断要写明，否则作者以为整本都查过（#155 的教训）。
    expect(user).toContain('更早的内容未提供')
  })

  it('defaults to a bounded budget instead of the whole book', () => {
    expect(PROSE_CONFLICT_MAX_EARLIER_CHARS).toBeLessThan(200_000)
  })
})

describe('parseProseConflictReview (issue #157)', () => {
  const request = { claims, earlierChapters: earlier }

  it('keeps a report whose both quotes locate verbatim', () => {
    const raw = JSON.stringify({
      issues: [{
        chapterNumber: 25,
        claimQuote: '码头老位置每日一停却想不起缘由',
        proseChapterNumber: 24,
        proseQuote: '脚底下没慢，也没停',
        explanation: '蓝图把「停一下」写成长期习惯，前文刚写没停',
      }],
    })
    expect(parseProseConflictReview(raw, request)).toEqual([{
      chapterNumber: 25,
      claimQuote: '码头老位置每日一停却想不起缘由',
      proseChapterNumber: 24,
      proseQuote: '脚底下没慢，也没停',
      explanation: '蓝图把「停一下」写成长期习惯，前文刚写没停',
    }])
  })

  it('drops the report when the blueprint quote cannot be found (model paraphrased)', () => {
    const raw = JSON.stringify({
      issues: [{
        chapterNumber: 25,
        claimQuote: '他每天都停一下',
        proseChapterNumber: 24,
        proseQuote: '脚底下没慢，也没停',
        explanation: 'x',
      }],
    })
    expect(parseProseConflictReview(raw, request)).toEqual([])
  })

  it('drops the report when the prose quote belongs to a different chapter', () => {
    const raw = JSON.stringify({
      issues: [{
        chapterNumber: 25,
        claimQuote: '码头老位置每日一停却想不起缘由',
        proseChapterNumber: 23,
        proseQuote: '脚底下没慢，也没停',
        explanation: 'x',
      }],
    })
    expect(parseProseConflictReview(raw, request)).toEqual([])
  })

  it('drops reports for chapters outside the request and bad JSON', () => {
    expect(parseProseConflictReview('not json', request)).toBeNull()
    const outside = JSON.stringify({
      issues: [{
        chapterNumber: 99,
        claimQuote: '码头老位置每日一停却想不起缘由',
        proseChapterNumber: 24,
        proseQuote: '脚底下没慢，也没停',
        explanation: 'x',
      }],
    })
    expect(parseProseConflictReview(outside, request)).toEqual([])
  })

  it('dedupes the same conflict reported twice', () => {
    const one = {
      chapterNumber: 25,
      claimQuote: '码头老位置每日一停却想不起缘由',
      proseChapterNumber: 24,
      proseQuote: '脚底下没慢，也没停',
      explanation: 'x',
    }
    expect(parseProseConflictReview(JSON.stringify({ issues: [one, one] }), request)).toHaveLength(1)
  })
})

describe('proseConflictFindings (issue #157)', () => {
  const issue = {
    chapterNumber: 25,
    claimQuote: '码头老位置每日一停却想不起缘由',
    proseChapterNumber: 24,
    proseQuote: '脚底下没慢，也没停',
    explanation: '蓝图把一次停写成长期习惯',
  }

  it('writes one finding naming both sides, with a key that cannot drift', () => {
    const [finding] = proseConflictFindings([issue])
    expect(finding!.stableFactKey).toBe('blueprint:habit-vs-prose:25')
    // sourceChapter 指向**正文那一章**（作者要去核的地方）。
    expect(finding!.sourceChapter).toBe(24)
    expect(finding!.evidence).toContain('每日一停')
    expect(finding!.evidence).toContain('脚底下没慢，也没停')
    // 两条出路都要给：按前文写，或写出转折。
    expect(finding!.suggestion.zhCN).toContain('按前文写')
    expect(finding!.suggestion.zhCN).toContain('转折')
  })

  it('merges several conflicts in one chapter into a single finding (ack must not swallow the rest)', () => {
    const second = { ...issue, claimQuote: '木戳磨平', proseQuote: '手探进内衬', proseChapterNumber: 24 }
    const findings = proseConflictFindings([issue, second])
    expect(findings).toHaveLength(1)
    // 合并后仍然逐条列出来源，作者能核对。
    expect(findings[0]!.evidence).toContain('每日一停')
    expect(findings[0]!.evidence).toContain('木戳磨平')
  })

  it('gives the English side too (界面会按 locale 取)', () => {
    const [finding] = proseConflictFindings([issue])
    expect(finding!.issue.enUS).toContain('retroactive')
    expect(finding!.suggestion.enUS).toContain('all along')
  })
})