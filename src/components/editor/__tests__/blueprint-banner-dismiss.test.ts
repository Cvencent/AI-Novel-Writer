import { describe, expect, it } from 'vitest'

// use-chapter-blueprints 是一个大型 hook；横幅判据的纯逻辑部分（recoveryDismissed
// 过滤）在这里以直接断言锁定回归（issue #22）：作者点过「移除卡片」的运行不再驱动横幅。
const readContext = (options: { recoveryDismissed?: boolean; writeState?: string }) => ({
  blueprintRecovery: { writeState: options.writeState ?? 'in-flight' },
  recoveryDismissed: options.recoveryDismissed,
})

// 从 hook 里复刻的横幅判定：一条目录蓝图运行的恢复上下文是否驱动横幅。
function bannerDrivenBy(recovery: ReturnType<typeof readContext>): boolean {
  if (recovery.recoveryDismissed === true) return false
  return Boolean(recovery.blueprintRecovery && recovery.blueprintRecovery.writeState !== 'complete')
}

describe('蓝图恢复稿横幅的取数判据 (issue #22)', () => {
  it('作者点过「移除卡片」（recoveryDismissed）的运行不再驱动横幅', () => {
    expect(bannerDrivenBy(readContext({ recoveryDismissed: true }))).toBe(false)
  })

  it('未移除且恢复稿未完成的运行照常驱动横幅', () => {
    expect(bannerDrivenBy(readContext({}))).toBe(true)
    expect(bannerDrivenBy(readContext({ writeState: 'ready' }))).toBe(true)
  })
})
