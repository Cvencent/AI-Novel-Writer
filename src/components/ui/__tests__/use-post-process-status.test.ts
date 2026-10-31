import { describe, expect, it } from 'vitest'

import { getStepPresentation, isRunInterrupted } from '../use-post-process-status'

const FRESH = '2026-11-01T08:00:00.000Z'

describe('isRunInterrupted (issue #8)', () => {
  it('a never-advanced run older than the grace window is interrupted', () => {
    expect(isRunInterrupted({ createdAt: FRESH, updatedAt: FRESH, allCriticalPassed: false },
      Date.parse(FRESH) + 3 * 60_000)).toBe(true)
  })

  it('a young run is still considered in progress', () => {
    expect(isRunInterrupted({ createdAt: FRESH, updatedAt: FRESH, allCriticalPassed: false },
      Date.parse(FRESH) + 10_000)).toBe(false)
  })

  it('a run whose ledger advanced is not judged by wall-clock staleness', () => {
    expect(isRunInterrupted({ createdAt: FRESH, updatedAt: '2026-11-01T08:01:00.000Z', allCriticalPassed: false },
      Date.parse(FRESH) + 60 * 60_000)).toBe(false)
  })

  it('a completed run is never interrupted', () => {
    expect(isRunInterrupted({ createdAt: FRESH, updatedAt: FRESH, allCriticalPassed: true },
      Date.parse(FRESH) + 60 * 60_000)).toBe(false)
  })
})

describe('getStepPresentation with run interruption', () => {
  const neverAttempted = { label: '章节剧情要点', critical: true, ok: false, attemptCount: 0, lastAttemptAt: '' }

  it('keeps pending for a young run', () => {
    expect(getStepPresentation(neverAttempted, false)).toBe('pending')
  })

  it('marks failed for an interrupted run so the retry entry appears', () => {
    expect(getStepPresentation(neverAttempted, true)).toBe('failed')
  })

  it('durable failure evidence still wins on its own', () => {
    expect(getStepPresentation({ ...neverAttempted, attemptCount: 2, error: 'boom' }, false)).toBe('failed')
    expect(getStepPresentation({ ...neverAttempted, ok: true }, true)).toBe('success')
  })
})
