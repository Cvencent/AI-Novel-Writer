import { describe, expect, it } from 'vitest'

import { mergedBlueprintCast, notesCastNames, notesOnlyCast } from '../blueprint-notes-cast'
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

/**
 * issue #214：**两处来源可信度不同**，不能当成同一份。
 *
 * `blueprints.characters` 是蓝图契约的字段（要求填角色名）；`notes` 的「角色动态」表
 * 第一列是**自由文本表格**，模型想写什么写什么。`#204` 让两者等价之后，实测那本 30 章的书里
 * 「账房伙计」「账房」「管事」三个**职务词**都够上承重档，而且会带上「建卡」动作 ——
 * 按下去就往名册里塞一个永远不该有的条目。
 *
 * 修法只传**来源**（哪一列来的，是可断言的事实），不判「它是不是人名」（那是内容判断）。
 */
describe('notes 独有的条目不给「建卡」动作 (issue #214)', () => {
  const notes = `## 角色动态
| 角色 | 本章变化/状态 |
|------|-------------|
| 账房伙计 | 传话、送底册 |
| 马六 | 把票根拨到一边 |
`
  const chapters = [1, 2, 3, 4].map(chapterNumber => ({
    chapterNumber,
    characters: mergedBlueprintCast(['马六'], notes),
    notesOnlyCharacters: notesOnlyCast(['马六'], notes),
  }))

  it('classifies a job title and a real name from the same free-text table', () => {
    // 两个都照报（「名册里没有」是事实，作者该看见）。
    const findings = findUnregisteredBlueprintCast({ schedules: chapters, castNames: [] })
    // 这条只断言**两个都被报出来**（分类在下面那条里断言），所以按 code unit 排序比对。
    expect(findings.map(finding => finding.stableFactKey).sort())
      .toEqual(['blueprint-cast:unregistered:账房伙计', 'blueprint-cast:unregistered:马六'])
  })

  it('gives 「建卡」 only to the entry that also came from the cast field', () => {
    const findings = findUnregisteredBlueprintCast({ schedules: chapters, castNames: [] })
    const byKey = new Map(findings.map(finding => [finding.stableFactKey, finding]))
    // 马六在 characters 数组里出现过 → 保留一键建卡。
    expect(byKey.get('blueprint-cast:unregistered:马六')!.action).toEqual({ kind: 'create-character', name: '马六' })
    // 账房伙计只在 notes 表里 → 不给动作，作者自己判断是补卡还是把那一格改成职务。
    expect(byKey.get('blueprint-cast:unregistered:账房伙计')!.action).toBeUndefined()
    // 但它要**说清来源**：作者得知道「这条只出现在笔记表里」，判据判不了它是不是人。
    expect(byKey.get('blueprint-cast:unregistered:账房伙计')!.evidence).toContain('只出现在蓝图 notes')
    expect(byKey.get('blueprint-cast:unregistered:账房伙计')!.suggestion.zhCN).toContain('判据判不了')
  })

  it('breaks a tie in favour of the entry the cast field declares', () => {
    /**
     * 平手（同样重）时真人先出：两列来源可信度不同，这是可断言的差别。
     * ⚠️ 只做**平手判据**，不做「来源优先」——见下一条（#204 的那位正是 notes 独有的）。
     */
    // ⚠️ 输入顺序**故意把 notes 独有的放前面**：否则稳定排序会替规则兜底，
    // 这条测试就变成假绿（我第一版正是这样，红验证没红）。
    const tie = [1, 2, 3, 4].map(chapterNumber => ({
      chapterNumber,
      characters: ['账房伙计', '马六'],
      notesOnlyCharacters: ['账房伙计'],
    }))
    const findings = findUnregisteredBlueprintCast({ schedules: tie, castNames: [] })
    expect(findings.map(finding => finding.stableFactKey))
      .toEqual(['blueprint-cast:unregistered:马六', 'blueprint-cast:unregistered:账房伙计'])
  })

  it('still surfaces a heavy notes-only entry (issue #204 不许回退)', () => {
    /**
     * #204 看见的那位（演了 9 章、70 段台词）**恰恰是 notes 独有的**。
     * 所以规则只做「承重档内先声明后 notes」，**不能**做成「notes 一律靠后」——
     * 那会把它压到所有轻量条目之下，等于把 #204 白修。实测 93 章那本它仍在第 2 条。
     */
    const heavierNotes = [
      ...Array.from({ length: 9 }, (_, index) => ({
        chapterNumber: 82 + index, characters: ['灰褂'], notesOnlyCharacters: ['灰褂'],
      })),
      // 一个轻量的声明条目（2 章，不承重）不该压过它。
      ...Array.from({ length: 2 }, (_, index) => ({
        chapterNumber: 5 + index, characters: ['账房伙计', '管事'], notesOnlyCharacters: ['账房伙计', '管事'],
      })),
    ]
    const findings = findUnregisteredBlueprintCast({ schedules: heavierNotes, castNames: [] })
    expect(findings[0]!.stableFactKey).toBe('blueprint-cast:unregistered:灰褂')
    expect(findings[0]!.action).toBeUndefined()
  })

  it('keeps the three job titles out of the top-4 when four declared characters are heavier', () => {
    /**
     * 实测 30 章那本：`characters` 声明的四个承重条目章数更高（16/14/12/8），
     * notes 独有、够承重但不是人的「账房伙计 4 / 账房 4 / 管事 3」被挡在 4 条之外。
     */
    const schedules = [
      ...[16].flatMap(count => Array.from({ length: count }, (_, index) => ({
        chapterNumber: 16 + index, characters: ['马六'], notesOnlyCharacters: [],
      }))),
      ...[14].flatMap(count => Array.from({ length: count }, (_, index) => ({
        chapterNumber: 11 + index, characters: ['任九'], notesOnlyCharacters: [],
      }))),
      ...[12].flatMap(count => Array.from({ length: count }, (_, index) => ({
        chapterNumber: 18 + index, characters: ['鲁二'], notesOnlyCharacters: [],
      }))),
      ...[8].flatMap(count => Array.from({ length: count }, (_, index) => ({
        chapterNumber: 16 + index, characters: ['葛阿满'], notesOnlyCharacters: [],
      }))),
      ...[4].flatMap(count => Array.from({ length: count }, (_, index) => ({
        chapterNumber: 6 + index, characters: ['账房伙计'], notesOnlyCharacters: ['账房伙计'],
      }))),
    ]
    const findings = findUnregisteredBlueprintCast({ schedules, castNames: [] })
    expect(findings.map(finding => finding.stableFactKey)).toEqual([
      'blueprint-cast:unregistered:马六', 'blueprint-cast:unregistered:任九',
      'blueprint-cast:unregistered:鲁二', 'blueprint-cast:unregistered:葛阿满',
    ])
    expect(findings.every(finding => finding.action !== undefined)).toBe(true)
  })

  it('treats an entry as declared if it appears in ANY chapter’s cast field', () => {
    // 同一名字：第 1 章只写在 notes 里，第 2 章写进了 characters 数组 → 算「字段声明过」，给动作。
    const schedules = [
      { chapterNumber: 1, characters: ['账房伙计'], notesOnlyCharacters: ['账房伙计'] },
      { chapterNumber: 2, characters: ['账房伙计'], notesOnlyCharacters: [] },
    ]
    const findings = findUnregisteredBlueprintCast({ schedules, castNames: [] })
    expect(findings[0]!.action).toEqual({ kind: 'create-character', name: '账房伙计' })
  })
})

describe('notesOnlyCast (issue #214)', () => {
  it('returns only the entries the cast field does not declare', () => {
    const notes = `## 角色动态
| 角色 | 本章变化/状态 |
|------|-------------|
| 账房伙计 | 传话 |
| 马六 | 拨票根 |`
    expect(notesOnlyCast(['马六'], notes)).toEqual(['账房伙计'])
    expect(notesOnlyCast([], notes)).toEqual(['账房伙计', '马六'])
    expect(notesOnlyCast(['马六', '账房伙计'], notes)).toEqual([])
  })
})
