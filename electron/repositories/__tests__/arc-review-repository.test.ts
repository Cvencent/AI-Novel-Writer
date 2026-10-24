import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { ArcReviewRepository } from '../arc-review-repository'
import { ensureArcReviewSchema } from '../arc-review-schema'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

function db() { const d = new Database(':memory:'); ensureArcReviewSchema(d); return d }

describe('ArcReviewRepository', () => {
  it('saves a run with findings and reads them back', () => {
    const d = db()
    const saved = ArcReviewRepository.save({ operationId: 'op-1', runId: 'run-1', selected: [1, 2], sourceHash: 'h1', findings: [
      { arcIndex: 1, category: 'plot_logic', severity: 'error', problemText: '因果断裂。', expectedText: '补上动机。' },
      { arcIndex: 2, category: 'duplication', severity: 'warning', problemText: '与第1段重复。', expectedText: '改成新方向。' },
    ] }, d)
    expect(saved.findings).toHaveLength(2)
    const listed = ArcReviewRepository.listByRun('run-1', d)
    expect(listed.map(f => f.arcIndex)).toEqual([1, 2])
    expect(listed[0]!.expectedText).toBe('补上动机。')
    expect(listed.every(f => f.status === 'open')).toBe(true)
    d.close()
  })
  it('marks one finding resolved or ignored', () => {
    const d = db()
    const saved = ArcReviewRepository.save({ operationId: 'op-2', runId: 'run-2', selected: [1], sourceHash: 'h2', findings: [
      { arcIndex: 1, category: 'pacing', severity: 'warning', problemText: '节奏太赶。', expectedText: '拉长两章。' },
    ] }, d)
    const id = saved.findings[0]!.findingId
    expect(ArcReviewRepository.resolve('run-2', id, 'accepted', d)).toBe(true)
    expect(ArcReviewRepository.listByRun('run-2', d)[0]!.status).toBe('accepted')
    expect(ArcReviewRepository.resolve('run-2', 'missing', 'ignored', d)).toBe(false)
    d.close()
  })
  it('accepts all open findings at once', () => {
    const d = db()
    ArcReviewRepository.save({ operationId: 'op-3', runId: 'run-3', selected: [1, 2], sourceHash: 'h3', findings: [
      { arcIndex: 1, category: 'pacing', severity: 'warning', problemText: 'a', expectedText: 'A' },
      { arcIndex: 2, category: 'pacing', severity: 'warning', problemText: 'b', expectedText: 'B' },
    ] }, d)
    expect(ArcReviewRepository.acceptAll('run-3', d)).toBe(2)
    expect(ArcReviewRepository.listByRun('run-3', d).every(f => f.status === 'accepted')).toBe(true)
    d.close()
  })
  it('is idempotent by operation id', () => {
    const d = db()
    const first = ArcReviewRepository.save({ operationId: 'op-4', runId: 'run-4', selected: [1], sourceHash: 'h4', findings: [
      { arcIndex: 1, category: 'pacing', severity: 'warning', problemText: 'a', expectedText: 'A' },
    ] }, d)
    const again = ArcReviewRepository.save({ operationId: 'op-4', runId: 'run-9', selected: [1], sourceHash: 'h9', findings: [] }, d)
    expect(again.runId).toBe(first.runId)
    expect(again.findings).toHaveLength(1)
    d.close()
  })
})
