import { describe, expect, it } from 'vitest'

import type { ConsistencyFinding } from '../consistency-preflight'
import { mergeModelFindings } from '../merge-model-findings'

/**
 * issue #170：模型判据的结论并进预检时的三处缺陷。
 *
 * 现场（那本书第 80 章，1.5.177）：
 * - 点一条**无关旧账**的「我已知」→ 刚核出的 10 条模型结论静默清零（60 → 50）；
 * - 连点两次「核对文风」→ 同章同轴撞出 12 组重复 key（`prose-flavor:motif:68` ×2）；
 * - 已 ack 过的 key 重新核对后照样回来。
 *
 * 本文件钉住**合并/过滤**这一层（纯函数）。「ack 一条不要整体重算」在组件侧（`acknowledgeFinding`
 * / `saveArrangement` 改成只动那一条），由浏览器测试与类型层保证。
 */
const finding = (stableFactKey: string, evidence: string): ConsistencyFinding => ({
  stableFactKey,
  severity: 'warning',
  sourceChapter: 68,
  evidence,
  issue: { zhCN: '问题', enUS: 'Issue' },
  suggestion: { zhCN: '建议', enUS: 'Fix' },
})

describe('mergeModelFindings (issue #170)', () => {
  it('appends new keys and reports how many were added', () => {
    const result = mergeModelFindings([], [finding('a', '证据一'), finding('b', '证据二')], [])
    expect(result.findings).toHaveLength(2)
    expect(result.added).toBe(2)
    expect(result.droppedAcknowledged).toBe(0)
  })

  it('merges a repeated key into the same finding instead of duplicating it', () => {
    // 连点两次同一个按钮：两次各自合并过的结果再并到一起，key 又撞上。
    const first = mergeModelFindings([], [finding('prose-flavor:motif:68', '布角按进衣襟里侧')], [])
    const second = mergeModelFindings(first.findings, [finding('prose-flavor:motif:68', '布角从舵板上揭起来')], [])
    expect(second.findings).toHaveLength(1)
    expect(second.added).toBe(0)
    // 两次的证据都要能看见（作者核对时两边都要能定位）。
    expect(second.findings[0]!.evidence).toContain('布角按进衣襟里侧')
    expect(second.findings[0]!.evidence).toContain('布角从舵板上揭起来')
  })

  it('does not repeat evidence that is already present', () => {
    // 现场那两组的引文**逐字相同**（「人走了，绳留下。」）——不能把它拼两遍。
    const first = mergeModelFindings([], [finding('prose-flavor:motif:79', '第79章「人走了，绳留下。」')], [])
    const second = mergeModelFindings(first.findings, [finding('prose-flavor:motif:79', '第79章「人走了，绳留下。」')], [])
    expect(second.findings[0]!.evidence.match(/人走了，绳留下。/gu)).toHaveLength(1)
  })

  it('drops findings whose key is already acknowledged', () => {
    // ack 过滤原本只发生在 readConsistencyPreflight 内部；模型结论直 push 时没走那道过滤。
    const result = mergeModelFindings([], [finding('prose-flavor:motif:68', '证据')], [{ stableFactKey: 'prose-flavor:motif:68' }])
    expect(result.findings).toEqual([])
    expect(result.droppedAcknowledged).toBe(1)
    expect(result.added).toBe(0)
  })

  it('keeps pre-existing findings untouched (acknowledging one thing must not clear the rest)', () => {
    // 这是「点一条旧账 → 模型结论整批消失」那条现场的另一半：合并不能动已有列表。
    const existing = [finding('chapter-opening:scene-first', '开篇句同构'), finding('prop:revival:内襟', '道具复活')]
    const result = mergeModelFindings(existing, [finding('prose-flavor:motif:68', '新结论')], [])
    expect(result.findings).toHaveLength(3)
    expect(result.findings.slice(0, 2)).toEqual(existing)
  })

  it('counts acknowledged drops without touching the surviving ones', () => {
    const result = mergeModelFindings(
      [],
      [finding('a', 'x'), finding('b', 'y'), finding('c', 'z')],
      [{ stableFactKey: 'b' }],
    )
    expect(result.findings.map(item => item.stableFactKey)).toEqual(['a', 'c'])
    expect(result.added).toBe(2)
    expect(result.droppedAcknowledged).toBe(1)
  })

  it('produces no duplicate keys ever (the React list keys on stableFactKey)', () => {
    const incoming = [finding('k1', 'e1'), finding('k1', 'e2'), finding('k2', 'e3'), finding('k2', 'e3')]
    const result = mergeModelFindings([finding('k2', 'e0')], incoming, [])
    const keys = result.findings.map(item => item.stableFactKey)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual(['k2', 'k1'])
  })
})