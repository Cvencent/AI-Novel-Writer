import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ipc } from '../ipc-client'
import { readConsistencyPreflight } from '../consistency-preflight'
import type { ProjectSessionContext } from '../../shared/ipc-channels'

/**
 * issue #204：`notes` 的「角色动态」表必须进**服务层**的取数。
 *
 * 现场：一位配角演了 9 章、70 段台词，名字只写在蓝图 `notes` 的角色动态表里，
 * `characters` 数组一次都没有 → 「未登记角色」判据看不见他，写下一章的预检一个字不报。
 * 三个读出场名单的判据都只读数组（#58/#74 补的五个描述字段也漏了 notes）。
 *
 * 这条测试钉在**服务层的取数**上：喂同一份库数据（数组里没有他、notes 表里有他），
 * 断言 `readConsistencyPreflight` 能报出他。只测纯函数会漏掉「接线没接上」这一类——
 * 而 #204 的缺陷恰恰就在接线，不在判据本身。
 */
vi.mock('../ipc-client', () => ({ ipc: { invokeWithProjectSession: vi.fn() } }))

const session = { projectId: 'novel', leaseId: 'lease', projectPath: 'C:/novel' } as ProjectSessionContext
const NOTES = `## 角色动态
| 角色 | 本章变化/状态 |
|------|-------------|
| 灰褂 | 主持对笔，添「复写层随件送检」 |
| 周叙 | 交出存根联 |
`
const blueprint = (chapterNumber: number, characters: string[], notes: string) => ({
  chapterNumber, title: `第${chapterNumber}章`, role: '', purpose: '', keyEvents: '',
  characters, suspenseHook: '', costsAndTurns: '', foreshadowing: '', notes, userGuidance: '',
})
const prose = (chapterNumber: number, name: string) => ({
  chapterNumber,
  content: `${name}说：「第三个。」\n\n「封存。」${name}把格子推回去。`,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ipc.invokeWithProjectSession).mockImplementation((async (_session: ProjectSessionContext, channel: string) => {
    switch (channel) {
      case 'db:consistency-exemption-list': return []
      case 'db:consistency-ack-list': return []
      case 'db:character-roster-read': return { entries: [{ name: '周叙', role: 'protagonist' }] }
      // 库里的蓝图：characters 数组里没有「灰褂」，只有 notes 表里写着。
      case 'db:blueprint-get-all': return [80, 81, 82, 83, 84, 85, 86, 87, 88, 89]
        .map(chapterNumber => blueprint(chapterNumber, ['周叙'], NOTES))
      case 'db:narrative-thread-list': return []
      case 'db:draft-export-snapshot': return [80, 81, 82, 83, 84, 85, 86, 87, 88, 89]
        .map(chapterNumber => prose(chapterNumber, '灰褂'))
      case 'db:continuity-list-before': return []
      default: return []
    }
  }) as never)
})

describe('readConsistencyPreflight 的取数要覆盖 notes 角色动态表 (issue #204)', () => {
  it('reports a character that only the notes table lists', async () => {
    const { findings } = await readConsistencyPreflight(session, [blueprint(90, ['周叙'], '')])
    const keys = findings.map(finding => finding.stableFactKey)
    expect(keys).toContain('blueprint-cast:unregistered:灰褂')
    const finding = findings.find(item => item.stableFactKey === 'blueprint-cast:unregistered:灰褂')!
    // 承重档（≥3 章 或 ≥2 段台词）——这一位 10 章 / 20 段。
    expect(finding.issue.zhCN).toContain('持续出场')
    /**
     * ⚠️ **不给建卡动作**（issue #214，本条在 #204 之后被改过一次）：
     * 「灰褂」只出现在 notes 的自由文本表格里，而 notes 表第一列里还混着大量职务词
     * （实测 30 章那本有「账房伙计 4 章 / 账房 4 章 / 管事 3 章」都够承重档）。
     * 给按钮等于按一下就往名册里塞个假人。照报仍然照报（作者该看见），
     * 但要说明来源、由作者判断是补卡还是把那一格改成职务。
     */
    expect(finding.action).toBeUndefined()
    expect(finding.evidence).toContain('只出现在蓝图 notes')
    expect(finding.suggestion.zhCN).toContain('判据判不了')
  })

  it('does not report a character who is on the roster', async () => {
    const { findings } = await readConsistencyPreflight(session, [blueprint(90, ['周叙'], '')])
    expect(findings.map(finding => finding.stableFactKey)).not.toContain('blueprint-cast:unregistered:周叙')
  })
})