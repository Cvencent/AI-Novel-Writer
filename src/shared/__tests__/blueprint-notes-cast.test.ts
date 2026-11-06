import { describe, expect, it } from 'vitest'

import { mergedBlueprintCast, notesCastNames } from '../blueprint-notes-cast'
import { findUnregisteredBlueprintCast } from '../consistency-preflight'

/**
 * issue #204：只在蓝图 `notes` 的「角色动态」表里出现的角色，原来整条线隐形。
 *
 * 现场：一位配角演了 9 章、58 段台词（比在册的林棠多 14 段），名字只写在 notes 表里，
 * `characters` 数组一次都没有 → 「未登记角色」判据看不见他，预检一个字不报；
 * 而 `notes` 恰恰是**唯一逐角色列名字**的字段。
 *
 * 三个会用到出场名单的判据都只读 `characters` 数组（#58/#74 补的五个描述字段也漏了 notes）。
 */
const NOTES = `## 剧情节点
- [触发] 灰褂把名册摊上桌面。

## 角色动态
| 角色 | 本章变化/状态 |
|------|-------------|
| 灰褂（稽核组） | 在送检附件登记单添「复写层随件送检」 |
| 周叙 | 交出存根联 |
| 灰褂 | 重复出现不应重复计数 |

## 新增设定
- ...`

describe('notesCastNames (issue #204)', () => {
  it('reads the first column of the 角色动态 table and drops parentheticals', () => {
    expect(notesCastNames(NOTES)).toEqual(['灰褂', '周叙'])
  })

  it('ignores the header row and the separator row', () => {
    // 表头是 schema 字面（「角色」），不是人；分隔行 |---| 也不是。
    const names = notesCastNames(NOTES)
    expect(names).not.toContain('角色')
    expect(names.some(name => /^[-:]+$/u.test(name))).toBe(false)
  })

  it('stops at the next section so later tables cannot leak in', () => {
    const notes = `## 角色动态
| 角色 | 变化 |
|------|------|
| 灰褂 | 主持对笔 |

## 伏笔与钩子
| 角色 | 线索 |
|------|------|
| 不该出现的名字 | 埋 |
`
    expect(notesCastNames(notes)).toEqual(['灰褂'])
  })

  it('returns nothing when the section is missing or malformed (never guesses)', () => {
    // notes 由模型生成、形状可能漂；拿不到就当没有，别让解析失败变成假提醒。
    expect(notesCastNames('')).toEqual([])
    expect(notesCastNames(null)).toEqual([])
    expect(notesCastNames('## 剧情节点\n- [触发] 某事。')).toEqual([])
    expect(notesCastNames('## 角色动态\n没有表格')).toEqual([])
  })

  it('skips the header row by position, not by recognising its words', () => {
    // 表头是本节表格的**第 1 行**——按位置跳过。
    // ⚠️ 不去认「角色」「角色名」这些字：那是内容词表（用户 2026-11-05 的定规），
    // 而且本仓的 literal-table 守卫会把词表拦下来（我第一版正是这么被拦的）。
    expect(notesCastNames(`## 角色动态
| 角色 | 本章变化/状态 |
|------|-------------|
| 灰褂 | 主持对笔 |`)).toEqual(['灰褂'])
  })

  it('keeps the template placeholder when the model echoes it verbatim for a real row', () => {
    // 模板里的示例行 `| 角色名 | 具体变化描述 |` 要是真被模型照抄下来，它就是一条真数据，
    // 解析器不做内容判断——交给下游的「未登记角色」判据按名册裁决（名册里没有它就会被报出来）。
    expect(notesCastNames(`## 角色动态
| 角色 | 本章变化/状态 |
|------|-------------|
| 角色名 | 具体变化描述 |`)).toEqual(['角色名'])
  })
})

describe('mergedBlueprintCast (issue #204)', () => {
  it('unions the array with the notes table, keeping array order first and de-duplicating', () => {
    expect(mergedBlueprintCast(['周叙', '柯明远'], NOTES)).toEqual(['周叙', '柯明远', '灰褂'])
  })

  it('still returns the array when notes is empty (no behaviour change for old blueprints)', () => {
    expect(mergedBlueprintCast(['周叙'], '')).toEqual(['周叙'])
    expect(mergedBlueprintCast(undefined, NOTES)).toEqual(['灰褂', '周叙'])
  })
})

/**
 * 正对照（issue 的消融）：把 notes 表里的名字并进出场名单，判据立刻能报出那个人。
 */
describe('findUnregisteredBlueprintCast 能看到只在 notes 里出现的角色 (issue #204)', () => {
  const notes = `## 角色动态
| 角色 | 本章变化/状态 |
|------|-------------|
| 灰褂 | 主持对笔 |
| 周叙 | 交出存根联 |
`
  const prose = Array.from({ length: 8 }, (_, index) => ({
    chapterNumber: 82 + index,
    content: `灰褂说：「第三个。」\n\n「封存。」灰褂把格子推回去。`,
  }))

  it('reports a heavy unregistered character that only the notes table mentions', () => {
    const merged = [82, 83, 84, 85, 86, 87, 88, 89].map(chapterNumber => ({
      chapterNumber, characters: mergedBlueprintCast(['周叙'], notes),
    }))
    const findings = findUnregisteredBlueprintCast({ schedules: merged, castNames: ['周叙'], prose })
    expect(findings.map(finding => finding.stableFactKey)).toEqual(['blueprint-cast:unregistered:灰褂'])
    // 承重档（≥3 章 或 ≥2 段台词）：这一位 8 章 / 16 段。
    expect(findings[0]!.issue.zhCN).toContain('持续出场')
  })

  it('reports nothing when only the characters array is read (the old behaviour)', () => {
    // 这正是 issue 的正对照：同样的数据，只喂数组 → 一条都不报。
    const arrayOnly = [82, 83, 84, 85, 86, 87, 88, 89].map(chapterNumber => ({
      chapterNumber, characters: ['周叙'],
    }))
    expect(findUnregisteredBlueprintCast({ schedules: arrayOnly, castNames: ['周叙'], prose })).toEqual([])
  })
})
/**
 * 合并 notes 之后，`slice(0, 4)` 的排序要保证**最重的那个人不会被挤掉**。
 *
 * 原来同档（承重）内保持插入顺序 = 名字首次出现的章号顺序。实测这本书里
 * 演了 9 章 70 段台词的那位第 82 章才首次出现，被三个 6 章的路人和一个 2 章的路人
 * 挡在 4 条之外 —— 而那正是本条要看见的人。
 */
describe('承重的按分量排序，晚出现的重角色不会被挤掉 (issue #204)', () => {
  it('puts the heaviest unregistered character ahead of lighter heavy ones', () => {
    const schedules = [
      // 晚出现的重角色：第 82–90 章，9 章。
      ...Array.from({ length: 9 }, (_, index) => ({
        chapterNumber: 82 + index,
        characters: mergedBlueprintCast(['周叙'], `## 角色动态
| 角色 | 本章变化/状态 |
|------|-------------|
| 灰褂 | 主持对笔 |`),
      })),
      // 更早出现的轻角色：各 2 章、无台词。
      ...Array.from({ length: 2 }, (_, index) => ({ chapterNumber: 5 + index, characters: ['老太太', '周叙'] })),
      ...Array.from({ length: 2 }, (_, index) => ({ chapterNumber: 30 + index, characters: ['梁有福', '周叙'] })),
      ...Array.from({ length: 2 }, (_, index) => ({ chapterNumber: 40 + index, characters: ['管物人', '周叙'] })),
      ...Array.from({ length: 2 }, (_, index) => ({ chapterNumber: 50 + index, characters: ['押件员', '周叙'] })),
    ]
    const prose = Array.from({ length: 9 }, (_, index) => ({
      chapterNumber: 82 + index,
      content: '灰褂说：「第三个。」\n\n「封存。」灰褂把推回去。',
    }))
    const findings = findUnregisteredBlueprintCast({ schedules, castNames: ['周叙'], prose })
    // 4 条上限不变；晚出现但承重的那一位必须在前四条里。
    expect(findings).toHaveLength(4)
    expect(findings.map(finding => finding.stableFactKey)).toContain('blueprint-cast:unregistered:灰褂')
  })
})
