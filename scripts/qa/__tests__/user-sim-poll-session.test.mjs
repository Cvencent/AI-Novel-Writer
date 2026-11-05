/**
 * 结构守卫：`pollUntilOrStall` 的每个调用点都必须把 `session` 传进去（issue #205）。
 *
 * 为什么需要它：上一版把 `session` 放在 options 对象里（`{ session }`），六个调用点里
 * **五个传了、一个漏了**——漏的那处（粗纲铺满全书）于是 `hasActiveGeneration` 永远
 * `return true`，停滞判定在那一步**完全失效**：真挂死就白等到整步超时（25 分钟量级）。
 *
 * 这一族缺陷本仓已经出过三次，都是「接口上手工对齐，必然漂」：
 *   - `#205`：这里漏传 `session`；
 *   - `#200`：`readRecovery` 漏传 `parentRootActionId`（workflow 层又算了一个 parent）；
 *   - `#189`：`firstFailedCheck` 的产出穿不过 IPC 白名单。
 *
 * 修法做了两层：① 签名把 `session` 提成**必填位置参数**（漏传在调用处一行可见）；
 * ② 这条测试扫全部调用点，防止将来新增第 7 处时又忘。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'user-sim.mjs'), 'utf8')

/** 取出每个 `pollUntilOrStall(...)` 调用点的前 120 字符（够看清前两个实参）。 */
function callHeads(text) {
  const heads = []
  const marker = 'pollUntilOrStall('
  let index = text.indexOf(marker)
  while (index >= 0) {
    heads.push(text.slice(index + marker.length, index + marker.length + 120))
    index = text.indexOf(marker, index + marker.length)
  }
  return heads
}

describe('pollUntilOrStall 调用点必须传 session (issue #205)', () => {
  const heads = callHeads(source)
  /** 去掉函数声明本身（`async function pollUntilOrStall(page, session, predicate, options = {})`）。 */
  const calls = heads.filter(head => !head.startsWith('page, session, predicate'))

  it('finds every call site (guards against the scan silently matching nothing)', () => {
    // 现在有 6 处：前提世界观 / 粗纲 / 细纲 / 蓝图 / 草稿 / 定稿。
    // 数字会随驱动演进变化——这条只防「正则写坏了导致 0 处也算过」。
    expect(calls.length).toBeGreaterThanOrEqual(5)
  })

  it('passes session as the second positional argument at every call site', () => {
    for (const head of calls) {
      expect(head.startsWith('page, session, '), `调用点没有传 session：pollUntilOrStall(${head.slice(0, 60)}…)`).toBe(true)
    }
  })

  it('no longer accepts session inside the options object (it is required, not optional)', () => {
    // 位置参数化之后，options 里再出现 session 只会误导下一个人以为它还有默认值。
    for (const head of calls) {
      expect(head, `options 里残留 session：${head.slice(0, 60)}…`).not.toContain('session:')
    }
  })

  it('fails loudly instead of silently degrading when session is missing', () => {
    // 宁可当场炸掉，也不要退化成「永远认为有运行在跑」而白等一整步超时。
    expect(source).toContain('停滞判定无法工作')
  })
})