import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { getStepPresentation, isRunInterrupted, isStepStranded } from '../use-post-process-status'

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

// issue #34：关键步骤全过 → all_critical_passed=1 → isRunInterrupted 直接返回 false，
// 于是「关键步骤跑完、非关键步骤一步没跑」的步骤永远停在「处理中」，也没有重试入口。
// 样本（第 12/13/15 章）：character_cards / chapter_commit 的 attempt_count=0、error='' ，
// 面板显示「定稿后处理 3 / 5 完成」+「角色状态更新 处理中」，而进程早已不在。
describe('isStepStranded (issue #34)', () => {
  const advancedRun = { createdAt: FRESH, updatedAt: '2026-11-01T08:40:15.000Z' }
  const neverRan = { label: '角色状态更新', critical: false, ok: false, attemptCount: 0, lastAttemptAt: '' }

  it('a step that never ran, in a run whose ledger has gone quiet, is stranded', () => {
    expect(isStepStranded(neverRan, advancedRun, Date.parse(advancedRun.updatedAt) + 3 * 60_000)).toBe(true)
  })

  it('a young run is not stranded — the step may still be about to run', () => {
    expect(isStepStranded(neverRan, advancedRun, Date.parse(advancedRun.updatedAt) + 10_000)).toBe(false)
  })

  it('a step with any durable attempt evidence is not judged by the clock', () => {
    const now = Date.parse(advancedRun.updatedAt) + 60 * 60_000
    expect(isStepStranded({ ...neverRan, attemptCount: 1 }, advancedRun, now)).toBe(false)
    expect(isStepStranded({ ...neverRan, error: 'boom' }, advancedRun, now)).toBe(false)
    expect(isStepStranded({ ...neverRan, lastAttemptAt: FRESH }, advancedRun, now)).toBe(false)
    expect(isStepStranded({ ...neverRan, ok: true }, advancedRun, now)).toBe(false)
  })

  it('落进 failed 后重试入口才会出现，且不误伤「首章后处理正在跑」', () => {
    const now = Date.parse(advancedRun.updatedAt) + 3 * 60_000
    // 关键步骤全过（runInterrupted=false）时，stranded 仍必须把它标成 failed
    expect(isRunInterrupted({ ...advancedRun, allCriticalPassed: true }, now)).toBe(false)
    expect(getStepPresentation(neverRan, false, isStepStranded(neverRan, advancedRun, now))).toBe('failed')
    // 刚创建、正在跑的那次运行：保持 pending
    expect(getStepPresentation(neverRan, false, isStepStranded(neverRan, advancedRun,
      Date.parse(advancedRun.updatedAt) + 5_000))).toBe('pending')
  })
})

// 面板文案：issue #34 的现象是界面写「处理中」，作者只会一直等；而 stranded 的步骤
// 必须给出「不会再有人跑它」的说法，并且运行面上要出现「重试失败步骤」入口。
describe('PostProcessSteps 面板文案 (issue #34)', () => {
  const source = readFileSync(new URL('../../stage/chapter/PostProcessSteps.tsx', import.meta.url), 'utf8')

  it('stranded 步骤不再显示「处理中」，而是说明这一步没有执行', () => {
    expect(source).toContain('上次运行到此结束，这一步没有执行')
    expect(source).toContain('stranded')
  })

  it('运行面给出补齐入口提示（否则作者只会等）', () => {
    expect(source).toContain('stage-ch-post-note')
    expect(source).toContain('后续章节读到的是旧的角色状态与事实账本')
    expect(source).toContain('重试失败步骤')
  })
})
