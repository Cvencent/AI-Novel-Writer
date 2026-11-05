import type { ConsistencyFinding } from './consistency-preflight'

/**
 * 把**模型判据**刚产出的提醒并进当前列表（issue #170）。
 *
 * ## 现场（1.5.177，那本书第 80 章写前预检）
 *
 * 模型判据（「核对文风」这类按钮）的结论是渲染层拿到后直接 push 进 preflight 的，
 * 于是出现四种互相打架的行为：
 *
 * 1. **点一条无关旧账的「我已知」→ 模型结论整批清空**（60 → 50，0 条，界面上没有提示）：
 *    因为那个动作走 `start()` 重算并**整体替换** preflight，而 `readConsistencyPreflight`
 *    从来不知道刚跑过哪几个模型判据 → 重算结果天然不含它们。
 * 2. **连点两次同一颗按钮 → 同章同轴撞出重复 key**（两次各 16 条，12 组撞同一个
 *    `prose-flavor:motif:68`）：第二次是**追加**，没有按 key 合并 → React 列表重复 key、
 *    ack 一条会静默掉另一条。
 * 3. **已 ack 的 key 重新核对后照样回来**：ack 过滤只发生在 `readConsistencyPreflight` 内部，
 *    模型结论直 push 时没走那道过滤。
 * 4. **结论没有存放处**：关掉弹层就没了，下次核对照样重新花 1.5–2.2 万 tok。
 *
 * ## 本模块负责 1/2/3 里**能断言**的那部分
 *
 * 只做一件纯函数的事：**合并 + 过滤**。它不碰 React、不碰 IPC，所以能被单测钉住。
 * 「结论活过弹层」（第 4 点）需要一处按 `项目+章号+轴` 的缓存，属新机制，本轮不做。
 *
 * ⚠️ 合并口径与 `styleIssueFindings` / `contentReviewFindings` 内部一致：**同 key 不新增一条**，
 * 而是把这次的证据并进 `evidence`。这样「一条提醒 = 一个判断」，ack 它就是把那个判断整个认了。
 */
export interface MergeModelFindingsResult {
  findings: ConsistencyFinding[]
  /** 新增了几条（0 表示全是已存在的 key）。 */
  added: number
  /** 因为此前已挂起而未列出的条数。 */
  droppedAcknowledged: number
}

export function mergeModelFindings(
  current: readonly ConsistencyFinding[],
  incoming: readonly ConsistencyFinding[],
  acknowledgements: ReadonlyArray<{ stableFactKey: string }>,
): MergeModelFindingsResult {
  const acknowledged = new Set(acknowledgements.map(item => item.stableFactKey))
  const merged = [...current]
  const indexByKey = new Map(merged.map((finding, index) => [finding.stableFactKey, index]))
  let added = 0
  let droppedAcknowledged = 0
  for (const finding of incoming) {
    if (acknowledged.has(finding.stableFactKey)) {
      droppedAcknowledged += 1
      continue
    }
    const at = indexByKey.get(finding.stableFactKey)
    if (at === undefined) {
      indexByKey.set(finding.stableFactKey, merged.length)
      merged.push(finding)
      added += 1
      continue
    }
    // 同 key 已存在：把这次的证据并进去，不新增一条。
    const existing = merged[at]!
    if (!existing.evidence.includes(finding.evidence)) {
      merged[at] = { ...existing, evidence: `${existing.evidence}；${finding.evidence}` }
    }
  }
  return { findings: merged, added, droppedAcknowledged }
}