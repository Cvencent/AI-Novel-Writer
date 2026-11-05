import { describe, expect, it } from 'vitest'

import {
  RENDER_CRASH_RECOVERY_LIMIT,
  decideRenderCrash,
  renderCrashMessage,
} from '../render-crash-policy'

/**
 * issue #152：审稿并定稿时渲染进程崩溃（`Page crashed` + `GPU exit_code=143`），
 * 两轮跨版本、跨安装同形态。崩溃后**生成仍在主进程继续**，但界面没了、也没有任何提示，
 * 作者只能重开，重开后又不知道「刚才那 400 秒跑到哪了」。
 *
 * 这一层的判定必须是纯函数：主进程里真正 reload/弹框的那几行无法在单测里跑，
 * 而「什么时候自动恢复、什么时候该告诉作者」恰恰是最容易写错的部分。
 */
describe('decideRenderCrash (issue #152)', () => {
  const base = { exitCode: 133, appQuitting: false, recoveryCount: 0 }

  it('reloads once for a transient renderer crash', () => {
    expect(decideRenderCrash({ ...base, reason: 'crashed' })).toEqual({ action: 'reload', why: 'transient' })
    expect(decideRenderCrash({ ...base, reason: 'abnormal-exit' })).toEqual({ action: 'reload', why: 'transient' })
  })

  it('does nothing while the app is quitting (a dialog would block the exit)', () => {
    expect(decideRenderCrash({ ...base, reason: 'crashed', appQuitting: true }))
      .toEqual({ action: 'ignore', why: 'quitting' })
    // 退出优先级高于 reason：连 oom 也不弹框。
    expect(decideRenderCrash({ ...base, reason: 'oom', appQuitting: true }))
      .toEqual({ action: 'ignore', why: 'quitting' })
  })

  it('ignores clean exits and killed processes (window destroyed on purpose)', () => {
    expect(decideRenderCrash({ ...base, reason: 'clean-exit' })).toEqual({ action: 'ignore', why: 'clean-exit' })
    expect(decideRenderCrash({ ...base, reason: 'killed' })).toEqual({ action: 'ignore', why: 'killed' })
  })

  it('never auto-reloads on out-of-memory (that would crash again immediately)', () => {
    expect(decideRenderCrash({ ...base, reason: 'oom' }))
      .toEqual({ action: 'notify', why: 'out-of-memory' })
  })

  it('notifies on launch-failed and integrity-failure instead of reloading a broken build', () => {
    expect(decideRenderCrash({ ...base, reason: 'launch-failed' }))
      .toEqual({ action: 'notify', why: 'launch-failed' })
    expect(decideRenderCrash({ ...base, reason: 'integrity-failure' }))
      .toEqual({ action: 'notify', why: 'integrity-failure' })
  })

  it('stops auto-recovering after the limit (a loop is worse than an explanation)', () => {
    expect(RENDER_CRASH_RECOVERY_LIMIT).toBe(1)
    expect(decideRenderCrash({ ...base, reason: 'crashed', recoveryCount: RENDER_CRASH_RECOVERY_LIMIT }))
      .toEqual({ action: 'notify', why: 'recovery-exhausted' })
  })

  it('does not reload for a reason it does not recognise (fail closed to a message)', () => {
    // 新版本 Electron 可能引入新的 reason；不认识就不要盲目 reload。
    expect(decideRenderCrash({ ...base, reason: 'some-new-reason' }))
      .toEqual({ action: 'notify', why: 'launch-failed' })
  })
})

describe('renderCrashMessage (issue #152)', () => {
  const decision = { action: 'notify' as const, why: 'recovery-exhausted' as const }

  it('tells the author the run was not lost and where to continue', () => {
    const message = renderCrashMessage(decision, 'zh-CN')
    expect(message.title).toContain('窗口')
    // 这两句是作者在崩溃现场最需要知道的：生成在后台没丢、去哪里接着处理。
    expect(message.body).toContain('没有丢')
    expect(message.body).toContain('运行侧页')
  })

  it('names the actual cause instead of a generic failure', () => {
    expect(renderCrashMessage({ action: 'notify', why: 'out-of-memory' }, 'zh-CN').body).toContain('内存不足')
    expect(renderCrashMessage({ action: 'notify', why: 'integrity-failure' }, 'zh-CN').body).toContain('完整性')
  })

  it('has an English version for en-US installs', () => {
    const message = renderCrashMessage(decision, 'en-US')
    expect(message.title).toContain('window')
    expect(message.body).toContain('not lost')
    expect(message.body).toContain('run panel')
  })

  it('produces nothing for decisions that never show a dialog', () => {
    expect(renderCrashMessage({ action: 'reload', why: 'transient' }, 'zh-CN')).toEqual({ title: '', body: '' })
    expect(renderCrashMessage({ action: 'ignore', why: 'quitting' }, 'en-US')).toEqual({ title: '', body: '' })
  })
})