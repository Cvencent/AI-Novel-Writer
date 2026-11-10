import { describe, expect, it } from 'vitest'

import { finalizationReviewBlocked, unhandledReviewFindings, type FinalizationReviewItem } from '../review-finalization'

const item = (decision: FinalizationReviewItem['decision'], findingStatus?: FinalizationReviewItem['findingStatus']): FinalizationReviewItem => ({
  decision,
  findingStatus,
})

describe('review finalization gate', () => {
  it.each(['unverified', 'unknown', 'resolved', 'author-waived', undefined] as const)(
    'does not block a confirmed %s finding',
    findingStatus => expect(finalizationReviewBlocked([item('apply', findingStatus)], true)).toBe(false),
  )

  it('blocks a confirmed applied finding that remains unresolved', () => {
    expect(finalizationReviewBlocked([item('apply', 'unresolved')], true)).toBe(true)
  })

  it('does not block unresolved findings the author did not apply or has not confirmed', () => {
    expect(finalizationReviewBlocked([item('ignore', 'unresolved')], true)).toBe(false)
    expect(finalizationReviewBlocked([item('apply', 'unresolved')], false)).toBe(false)
  })
})

/**
 * issue #230：审稿已经看见、但作者没处理就定稿——那个事实不能静默流失。
 *
 * 现场是审稿报告整个没被确认（E2E 生成后直接定稿），cycle 里的发现从没进过确认清单；
 * `finalizationReviewBlocked` 只拦「已确认 apply 且 unresolved」，于是这一条静默流走。
 * `unhandledReviewFindings` 是**提示**不是阻塞：定稿确认框里给一句「审稿有 N 条发现还没处理」，
 * 作者有权坚持定稿。
 */
describe('unhandled review findings shown at the finalize dialog (issue #230)', () => {
  it('counts nothing when the review was never confirmed (nothing was decided yet)', () => {
    // 报告未确认 = 清单尚未生效；提示发生在确认页，不在这里（阻塞口径同样不动）。
    expect(unhandledReviewFindings([item('apply', 'unresolved')], false)).toBe(0)
  })

  it('counts applied findings still sitting in a pre-resolution status', () => {
    expect(unhandledReviewFindings([item('apply', 'unresolved')], true)).toBe(1)
    expect(unhandledReviewFindings([item('apply', 'unverified')], true)).toBe(1)
    expect(unhandledReviewFindings([item('apply', 'unknown')], true)).toBe(1)
    expect(unhandledReviewFindings([item('apply', undefined)], true)).toBe(1)
  })

  it('does not count findings the author settled (resolved, waived, ignored)', () => {
    expect(unhandledReviewFindings([item('apply', 'resolved')], true)).toBe(0)
    expect(unhandledReviewFindings([item('apply', 'author-waived')], true)).toBe(0)
    expect(unhandledReviewFindings([item('ignore', 'unresolved')], true)).toBe(0)
    expect(unhandledReviewFindings([item('waive', 'unresolved')], true)).toBe(0)
  })

  it('counts only the unhandled ones in a mixed list', () => {
    const items = [item('apply', 'resolved'), item('apply', 'unresolved'), item('ignore', 'unverified')]
    expect(unhandledReviewFindings(items, true)).toBe(1)
  })

  it('never blocks on its own: an unhandled finding does not flip the gate', () => {
    // 提示与阻塞是两个口径：unresolved + apply 已由 finalizationReviewBlocked 负责（true），
    // 但 unverified + apply 只提示、不阻塞。
    expect(finalizationReviewBlocked([item('apply', 'unverified')], true)).toBe(false)
    expect(unhandledReviewFindings([item('apply', 'unverified')], true)).toBe(1)
  })
})

/**
 * issue #245 现场（`源起` 第 1 章）：作者点了审稿（2 条 AI 发现）→ 五角色评审（10 条）
 * → 勾了全部 12 条 → 按 12 条一起修稿 → 合并成功 → 点定稿，得到「这 12 条都未确认」。
 *
 * 那 10 条是 `appendEditorialFindings` 纳入的**作者侧条目**：结构上（`review-checklist.ts:215`）
 * 只有 `{ id, reviewItemIndex, category, severity, description, quote, decision, origin }`，
 * **没有 findingId**。而 `findingStatus` 是按 findingId 反查 cycle 得来的
 * （`findingStatus: finding?.status`），所以它恒为 `undefined` → 无论作者修几遍、
 * 合并多少次，都永远被算作「未处理」。
 *
 * 判据只认已落库的事实：修稿合并已提交（cycle 的 `revisionStatus === 'merge-committed'`）
 * = 作者勾选的内容确实进了正文，据此把作者侧条目算作已处理。
 */
describe('author-side checklist rows stop counting once the revision merged (issue #245)', () => {
  const authorRow = (decision: FinalizationReviewItem['decision'] = 'apply'): FinalizationReviewItem => ({
    decision, origin: 'author', findingStatus: undefined,
  })

  it('counts author rows before the merge (their text is not in the draft yet)', () => {
    expect(unhandledReviewFindings([authorRow()], true, false)).toBe(1)
  })

  it('stops counting them after the merge committed', () => {
    expect(unhandledReviewFindings([authorRow()], true, true)).toBe(0)
  })

  it('keeps counting AI findings after the merge unless the recheck resolved them', () => {
    // 合并只证明「作者勾的内容进了正文」；AI 发现是否真被改掉要由复核判定，
    // 复核没给出结论（unknown）时照旧提示——否则 #230 那条静默流失就回来了。
    const aiUnknown: FinalizationReviewItem = { decision: 'apply', origin: 'ai', findingStatus: 'unknown' }
    expect(unhandledReviewFindings([aiUnknown], true, true)).toBe(1)
    const aiResolved: FinalizationReviewItem = { decision: 'apply', origin: 'ai', findingStatus: 'resolved' }
    expect(unhandledReviewFindings([aiResolved], true, true)).toBe(0)
  })

  it('reproduces the reported 12 → 2 after merge (10 author rows + 2 unknown AI findings)', () => {
    const items: FinalizationReviewItem[] = [
      ...Array.from({ length: 10 }, () => authorRow()),
      { decision: 'apply', origin: 'ai', findingStatus: 'unknown' },
      { decision: 'apply', origin: 'ai', findingStatus: 'unknown' },
    ]
    // 合并前：12（正是作者看到的那句「12 条都未确认」）
    expect(unhandledReviewFindings(items, true, false)).toBe(12)
    // 合并后：只剩 2 条 AI 发现待核实（它们确实没被复核上）
    expect(unhandledReviewFindings(items, true, true)).toBe(2)
  })

  it('still ignores rows the author marked ignore/waive', () => {
    expect(unhandledReviewFindings([authorRow('ignore'), authorRow('waive')], true, false)).toBe(0)
  })
})
