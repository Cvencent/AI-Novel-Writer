import { describe, expect, it } from 'vitest'

import type { FinalizedContinuityFact } from '../finalized-continuity'
import { applyFactRecategorization, recategorizeFinalizedFacts } from '../finalized-continuity-facts'

/**
 * issue #173：#148 修好的是**判据**，但分类是**落库那一刻**算一次并写死的 —— 存量不自愈。
 *
 * 真书实测（`summary_snapshots` 全量 561 条事实）：**148 条分类与当前判据不符**，
 * 其中 `plot→open-thread` **109 条**（正是 `[埋]`/`[钩]` 那批伏笔）。
 * `open-thread` 在 `CATEGORY_PRIORITY` 里排最高档（占起草前 12 条名额），
 * 被标成 `plot` 就等于那批伏笔永远抢不到名额。
 */
describe('recategorizeFinalizedFacts (issue #173)', () => {
  const fact = (statement: string, category: any): FinalizedContinuityFact => ({
    category, entities: [], statement, sourceChapter: 3, evidence: '原句',
  })

  it('re-classifies an old [埋] fact from plot to open-thread', () => {
    const plan = recategorizeFinalizedFacts([fact('[埋] 周叙记住绳结的绕法', 'plot')])
    expect(plan.changes).toHaveLength(1)
    expect(plan.changes[0]!.nextCategory).toBe('open-thread')
    expect(plan.counts).toEqual({ 'plot→open-thread': 1 })
  })

  it('is idempotent: already-correct facts produce zero changes', () => {
    const already = [fact('[埋] 周叙记住绳结的绕法', 'open-thread')]
    expect(recategorizeFinalizedFacts(already).changes).toEqual([])
  })

  it('changes ONLY the category: statement, evidence and sourceChapter are untouched', () => {
    const original = fact('[埋] 周叙记住绳结的绕法', 'plot')
    const next = applyFactRecategorization([original], recategorizeFinalizedFacts([original]))
    expect(next[0]!.category).toBe('open-thread')
    // 另外三个字段必须逐字保留 —— 动了会撞 #159 那类哈希问题。
    expect(next[0]!.statement).toBe(original.statement)
    expect(next[0]!.evidence).toBe(original.evidence)
    expect(next[0]!.sourceChapter).toBe(original.sourceChapter)
  })

  it('counts every from→to pair so the author can see what will change', () => {
    const plan = recategorizeFinalizedFacts([
      fact('[埋] 甲', 'plot'),
      fact('[钩] 乙', 'plot'),
      fact('周叙受伤未愈', 'plot'),
      fact('周叙受伤未愈', 'plot'),
    ])
    expect(plan.counts['plot→open-thread']).toBe(2)
    // 同一章里重复的 statement 各自算一次（去重是另一步的责任）。
    expect(plan.counts['plot→character-state']).toBe(2)
  })

  it('ignores a fact with an empty statement (nothing to classify)', () => {
    expect(recategorizeFinalizedFacts([fact('   ', 'plot')]).changes).toEqual([])
  })
})
