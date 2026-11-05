/**
 * 「多个字段合取抛同一个错误码」的**具名化**工具（issue #178）。
 *
 * ## 现场
 *
 * 全仓有 12 个 `*_MISMATCH` 错误码，形态一模一样：`a || b || c || …` 共抛一个码，
 * **不说是哪一项**。最典型的是同一族的 `GENERATION_RUN_IDENTITY_MISMATCH`
 * 在 **5 个模块**里各写一遍（`finalization-generation` / `graph-generation` /
 * `legacy-roster-generation-proof` / `main-generation-owner` ×2），
 * 而且检查的项目还不完全相同。
 *
 * 拿到这个码时，既不知道是哪个模块抛的，也不知道哪一项不等 —— 排查只能「逐项反推 + 消融实验」。
 * 这已经付过三次代价：#174（审稿 11 项）、`MIGRATION_VERIFICATION_FAILED` 一族、#62/#125 的同类。
 *
 * ## 用法
 *
 * ```ts
 * const failure = firstFailedCheck('GENERATION_RUN_IDENTITY_MISMATCH', [
 *   ['projectId', handle.projectId === this.projectId],
 *   ['rootActionId', handle.rootActionId === run.rootActionId],
 *   ['epoch', handle.epoch === run.binding.epoch],
 * ])
 * if (failure) throw new Error(failure)
 * ```
 *
 * ## 三条纪律
 *
 * 1. **前缀必须保留**：`GENERATION_X_MISMATCH:field` 的前半段仍是原码，
 *    任何 `message.includes('…MISMATCH')` 的既有分支照旧生效（本仓大量用字符串判定）。
 * 2. **顺序即短路语义**：第一个失败项与原 `a || b || c` 的求值顺序一致 —— 把合取改成检查表
 *    不会改变「先报哪一项」。
 * 3. **报出全部失败项**（`field1,field2`）：调试时常常需要知道「有几项不等」，
 *    而只报第一个会让人以为「只错了这一项」。列表里第一个永远是**原顺序的第一个**。
 */

export interface NamedCheck {
  /** 这一项的名字（会出现在错误码后缀里；限 `[A-Za-z0-9_]{1,40}`，避免把整段文案当码透出去）。 */
  name: string
  /** 这一项是否通过。 */
  passed: boolean
}

/** 检查项名字的允许形态（与 IPC 白名单的 `:field` 后缀同一口径）。 */
/**
 * 检查项名字的允许形态。
 *
 * ⚠️ 与 IPC 白名单（`generation-controller.ts` 的 `NAMED_ERROR_CODE`）**必须同口径**：
 * 那边允许每项 ≤31 字、最多 8 项。两边长度不一致时，32–40 字的合法名字会在边界被兜底改写
 * （#189 的教训：A 的产出穿不过 B 的白名单，而两边各自的测试都绿）。
 */
const CHECK_NAME = /^[A-Za-z0-9_]{1,31}$/u

/**
 * 返回具名错误码（`code:firstFailed[,secondFailed…]`），全部通过时返回 `null`。
 *
 * ⚠️ 传进来的 `name` 若不合法（含中文、过长），**降级为 `unnamed`** 而不是把脏字符串拼进错误码 ——
 * 那一层有 IPC 白名单正则，会把整个码判成「不是具名码」而落进兜底分支（#179 的教训）。
 */
export function firstFailedCheck(
  code: string,
  checks: ReadonlyArray<readonly [string, boolean]>,
): string | null {
  const failed = checks.filter(([, passed]) => !passed)
  if (failed.length === 0) return null
  const names = failed.map(([name]) => (CHECK_NAME.test(name) ? name : 'unnamed'))
  return `${code}:${names.join(',')}`
}

/** 便捷版：接受 `{ name, passed }` 形状（有些调用点已有这样的数组）。 */
export function firstFailedNamedCheck(
  code: string,
  checks: ReadonlyArray<NamedCheck>,
): string | null {
  return firstFailedCheck(code, checks.map(check => [check.name, check.passed] as const))
}