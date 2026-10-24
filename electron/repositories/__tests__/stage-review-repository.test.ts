import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { StageReviewRepository } from '../stage-review-repository'
import { ensureStageReviewSchema } from '../stage-review-schema'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

function db() { const d = new Database(':memory:'); ensureStageReviewSchema(d); return d }

describe('StageReviewRepository', () => {
  it('saves an arc review run with findings and reads them back', () => {
    const d = db()
    const saved = StageReviewRepository.save({ operationId: 'op-1', runId: 'run-1', target: 'arc', selected: [1, 2], sourceHash: 'h1', findings: [
      { targetIndex: 1, category: 'plot_logic', severity: 'error', problemText: '因果断裂。', expectedText: '补上动机。' },
      { targetIndex: 2, category: 'duplication', severity: 'warning', problemText: '与第1段重复。', expectedText: '改成新方向。' },
    ] }, d)
    expect(saved.findings).toHaveLength(2)
    const listed = StageReviewRepository.listByRun('run-1', d)
    expect(listed.map(f => f.targetIndex)).toEqual([1, 2])
    expect(listed[0]!.expectedText).toBe('补上动机。')
    expect(listed.every(f => f.status === 'open')).toBe(true)
    d.close()
  })

  it('keeps arc, outline and blueprint reviews independent', () => {
    const d = db()
    StageReviewRepository.save({ operationId: 'a', runId: 'ra', target: 'arc', selected: [1], sourceHash: 'h', findings: [] }, d)
    StageReviewRepository.save({ operationId: 'o', runId: 'ro', target: 'outline', selected: [3], sourceHash: 'h', findings: [] }, d)
    StageReviewRepository.save({ operationId: 'b', runId: 'rb', target: 'blueprint', selected: [7], sourceHash: 'h', findings: [] }, d)
    expect(StageReviewRepository.latestRun('arc', d)!.runId).toBe('ra')
    expect(StageReviewRepository.latestRun('outline', d)!.runId).toBe('ro')
    expect(StageReviewRepository.latestRun('blueprint', d)!.runId).toBe('rb')
    d.close()
  })

  it('marks one finding resolved or ignored', () => {
    const d = db()
    const saved = StageReviewRepository.save({ operationId: 'op-2', runId: 'run-2', target: 'outline', selected: [1], sourceHash: 'h2', findings: [
      { targetIndex: 1, category: 'pacing', severity: 'warning', problemText: '节奏太赶。', expectedText: '拉长两章。' },
    ] }, d)
    const id = saved.findings[0]!.findingId
    expect(StageReviewRepository.resolve('run-2', id, 'accepted', d)).toBe(true)
    expect(StageReviewRepository.listByRun('run-2', d)[0]!.status).toBe('accepted')
    expect(StageReviewRepository.resolve('run-2', 'missing', 'ignored', d)).toBe(false)
    d.close()
  })

  it('accepts all open findings at once', () => {
    const d = db()
    StageReviewRepository.save({ operationId: 'op-3', runId: 'run-3', target: 'blueprint', selected: [1, 2], sourceHash: 'h3', findings: [
      { targetIndex: 1, category: 'pacing', severity: 'warning', problemText: 'a', expectedText: 'A' },
      { targetIndex: 2, category: 'pacing', severity: 'warning', problemText: 'b', expectedText: 'B' },
    ] }, d)
    expect(StageReviewRepository.acceptAll('run-3', d)).toBe(2)
    expect(StageReviewRepository.listByRun('run-3', d).every(f => f.status === 'accepted')).toBe(true)
    d.close()
  })

  it('is idempotent by operation id', () => {
    const d = db()
    const first = StageReviewRepository.save({ operationId: 'op-4', runId: 'run-4', target: 'arc', selected: [1], sourceHash: 'h4', findings: [
      { targetIndex: 1, category: 'pacing', severity: 'warning', problemText: 'a', expectedText: 'A' },
    ] }, d)
    const again = StageReviewRepository.save({ operationId: 'op-4', runId: 'run-9', target: 'arc', selected: [1], sourceHash: 'h9', findings: [] }, d)
    expect(again.runId).toBe(first.runId)
    expect(again.findings).toHaveLength(1)
    d.close()
  })

  it('removes a review run the author has dismissed', () => {
    const d = db()
    StageReviewRepository.save({ operationId: 'op-5', runId: 'run-5', target: 'outline', selected: [1], sourceHash: 'h5', findings: [
      { targetIndex: 1, category: 'pacing', severity: 'warning', problemText: 'a', expectedText: 'A' },
    ] }, d)
    expect(StageReviewRepository.removeRun('run-5', d)).toBe(true)
    expect(StageReviewRepository.listByRun('run-5', d)).toHaveLength(0)
    expect(StageReviewRepository.latestRun('outline', d)).toBeNull()
    d.close()
  })
})
