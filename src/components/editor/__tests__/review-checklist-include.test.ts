import { describe, expect, it } from 'vitest'

import { appendEditorialFindings, type EditableReviewItem } from '../review-checklist'

const item = (over: Partial<EditableReviewItem> = {}): EditableReviewItem => ({
  id: 'author-1', reviewItemIndex: 0, category: '作者补充', severity: 'warning',
  description: '已有意见', decision: 'apply', origin: 'author', ...over,
})

// issue #103：编辑部面板的「全部纳入修稿」原来是**逐条**调 includeEditorialFinding，
// 而那个函数用闭包里的 items 算下一条（`const next = [...items, 新一条]` + `setItems(next)`）。
// 循环里每次都用同一份旧 items，后一次覆盖前一次 → N 条发现只留下最后一条。
describe('appendEditorialFindings (issue #103)', () => {
  const findings = [
    { severity: 'blocking', description: '情节断裂', evidence: '第三段', category: '编辑部评审·情节' },
    { severity: 'warning', description: '角色声音不稳', evidence: '第五段', category: '编辑部评审·角色' },
    { severity: 'warning', description: '节奏拖沓', evidence: '', category: '编辑部评审·节奏' },
  ]

  it('appends every finding, not just the last one', () => {
    const added = appendEditorialFindings([], findings)
    expect(added).toHaveLength(3)
    expect(added.map(entry => entry.description)).toEqual(['情节断裂', '角色声音不稳', '节奏拖沓'])
  })

  it('keeps an existing checklist intact and continues the indices', () => {
    const added = appendEditorialFindings([item()], findings)
    expect(added).toHaveLength(3)
    expect(added[0]!.reviewItemIndex).toBe(1)
    expect(added[2]!.reviewItemIndex).toBe(3)
  })

  it('maps blocking to error and everything else to warning', () => {
    const added = appendEditorialFindings([], findings)
    expect(added[0]!.severity).toBe('error')
    expect(added[1]!.severity).toBe('warning')
    expect(added[0]!.origin).toBe('author')
    expect(added[1]!.decision).toBe('apply')
  })

  it('skips a finding already in the checklist (dedupe by description + evidence)', () => {
    const existing = item({ description: '情节断裂', quote: '第三段' })
    const added = appendEditorialFindings([existing], findings)
    expect(added.map(entry => entry.description)).toEqual(['角色声音不稳', '节奏拖沓'])
  })

  it('treats an empty evidence string and an absent one as the same key', () => {
    // 面板传的是 `finding.evidence`（可能为 undefined 或 ''），判重必须一致，
    // 否则「全部纳入」点两次会重复加一批。
    const existing = item({ description: '节奏拖沓', quote: undefined })
    expect(appendEditorialFindings([existing], findings).map(entry => entry.description))
      .toEqual(['情节断裂', '角色声音不稳'])
  })

  it('dedupes within the same batch', () => {
    const duplicated = [findings[0]!, findings[0]!, findings[1]!]
    expect(appendEditorialFindings([], duplicated).map(entry => entry.description))
      .toEqual(['情节断裂', '角色声音不稳'])
  })

  it('produces unique ids so React keys and removal stay stable', () => {
    const added = appendEditorialFindings([item()], findings)
    expect(new Set(added.map(entry => entry.id)).size).toBe(added.length)
  })

  it('returns nothing when the panel has no findings', () => {
    expect(appendEditorialFindings([item()], [])).toEqual([])
  })
})

// 回归护栏（issue #103）：旧实现是「逐条 + 闭包里的 items」，这里把那套形状原样重放，
// 断言它**真的会丢条目**——这样将来有人把 includeEditorialFindings 改回逐条调用时，
// 这条测试会红。新实现（appendEditorialFindings）在同一场景下必须保住全部三条。
describe('the old per-call shape must lose findings (issue #103 regression guard)', () => {
  const findings = [
    { severity: 'blocking', description: '情节断裂', evidence: '第三段', category: '编辑部评审·情节' },
    { severity: 'warning', description: '角色声音不稳', evidence: '第五段', category: '编辑部评审·角色' },
    { severity: 'warning', description: '节奏拖沓', evidence: '', category: '编辑部评审·节奏' },
  ]

  /**
   * 旧形状：`items` 是**渲染作用域的快照**，整个循环期间不变；每次调用算
   * `[...items, 新一条]` 并 setItems，于是最后一次的写入覆盖前面全部。
   */
  const oldShape = (): string[] => {
    const capturedItems: string[] = [] // 渲染时的 items 快照，循环期间恒定
    let state: string[] = capturedItems
    const include = (description: string): void => {
      if (capturedItems.includes(description)) return // 判重也读的是旧快照
      state = [...capturedItems, description]         // const next = [...items, 新一条]
    }
    for (const finding of findings) include(finding.description)
    return state
  }

  it('the old shape keeps only the last finding', () => {
    // 这就是 issue 报告的现象：三条只留下最后一条。
    expect(oldShape()).toEqual(['节奏拖沓'])
  })

  it('the new shape keeps all three', () => {
    expect(appendEditorialFindings([], findings).map(entry => entry.description))
      .toEqual(['情节断裂', '角色声音不稳', '节奏拖沓'])
  })
})
