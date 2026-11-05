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
    // ⚠️ 不钉死「没有丢」这三个字（它就是 #169 的现场措辞）：断言**语义**——
    // 「那一步没白等」+「去哪里接着做」。措辞会变，功能不能变。
    expect(message.body).toMatch(/没有丢|一秒都没丢|没白等/u)
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
/**
 * issue #169：给作者看的崩溃文案**不许带 Markdown 标记**。
 *
 * 现场：中文四档的 `body` 里都写着 `**没有丢**`，而它被塞进 Electron **原生对话框**的 `detail`
 * ——原生渲染是纯文本，作者在窗口刚崩的那一刻看到的是「**没有丢**」。
 *
 * ⚠️ 旧断言是 `expect(message.body).toContain('没有丢')`：`'**没有丢**'.includes('没有丢')`
 * 为真 —— 测试是绿的，**它不可能发现星号**。所以这里改成逐档、逐语言扫标记。
 */
describe('作者可见的崩溃文案不含标记 (issue #169)', () => {
  const whys = ['out-of-memory', 'launch-failed', 'integrity-failure', 'recovery-exhausted'] as const
  const langs = ['zh-CN', 'en-US'] as const

  it('never contains asterisks in any tier or language', () => {
    for (const why of whys) {
      for (const lang of langs) {
        const message = renderCrashMessage({ action: 'notify', why }, lang)
        expect(message.title, `${why}/${lang} title`).not.toContain('*')
        expect(message.body, `${why}/${lang} body`).not.toContain('*')
      }
    }
  })

  it('never contains other markdown furniture that a native dialog would show literally', () => {
    for (const why of whys) {
      for (const lang of langs) {
        const message = renderCrashMessage({ action: 'notify', why }, lang)
        // 原生框不认 Markdown：反引号、下划线强调、井号标题都不该出现在文案里。
        expect(message.body, `${why}/${lang}`).not.toMatch(/[`_]{2}|^#{1,6}\s/mu)
      }
    }
  })

  it('still says the thing that matters (the text itself was not gutted)', () => {
    // 剥离只去标记，不许把安抚那句话删掉——这条与上面两条互相约束。
    const zh = renderCrashMessage({ action: 'notify', why: 'out-of-memory' }, 'zh-CN')
    expect(zh.body).toMatch(/没有丢|一秒都没丢|没白等/u)
    expect(zh.body).toContain('运行侧页')
    const en = renderCrashMessage({ action: 'notify', why: 'out-of-memory' }, 'en-US')
    expect(en.body).toContain('not lost')
  })
})
