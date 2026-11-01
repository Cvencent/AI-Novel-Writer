import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectStore } from '../../../../stores/project-store'
import { createAgentExecutionContext } from '../project-context'
import { createCharacterTool } from '../write-characters.tool'

const invoke = vi.fn()
vi.mock('../../../ipc-client', () => ({
  ipc: { invokeWithProjectSession: (...args: unknown[]) => invoke(...args) },
}))

// issue #40：AI 新建的「邵德昌」角色卡 appearance 为空，而他第 8、9 章都有戏。
// create_character 允许只给名字（路人合理），但承重角色缺外貌时必须在返回里说出来。
const project = {
  id: 'project-A', sessionLease: 'lease-A', name: 'A', path: 'C:\novels\A',
  novelConfig: {
    genre: '悬疑', subGenre: '', targetAudience: '男频', totalChapters: 20, wordsPerChapter: 900,
    plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '', worldSetting: '',
    goldenFinger: '', protagonistProfile: '', globalGuidance: '', writingLanguage: 'zh-CN',
  },
  characterStates: '', createdAt: '', updatedAt: '',
}

const rosterSnapshot = {
  status: 'ready', revision: 3, identityRevision: 2, schemaVersion: 1,
  entries: [{
    name: '周叙', role: 'protagonist', gender: '男', age: '28', appearance: '靛蓝短褂',
    personality: '', background: '', abilities: '', motivation: '', relationships: [],
    arc: '', notes: '', currentState: { updatedAtChapter: 0 },
  }],
}

beforeEach(() => {
  invoke.mockReset()
  useProjectStore.setState({ currentProject: project as never })
  // 真实签名是 invokeWithProjectSession(session, channel, ...args)。
  invoke.mockImplementation(async (_session: unknown, channel: string) => {
    if (channel === 'db:character-roster-read') return rosterSnapshot
    if (channel === 'db:character-roster-commit') return { success: true }
    return null
  })
})

afterEach(() => {
  useProjectStore.setState({ currentProject: null })
})

async function create(args: Record<string, unknown>) {
  const result = await createCharacterTool.execute(args as never, createAgentExecutionContext(null, 'zh-CN'))
  return String((result as { content?: string }).content ?? '')
}

describe('create_character 的外貌提示 (issue #40)', () => {
  it('给定外貌时按常规确认，不加提示', async () => {
    const content = await create({ name: '邵德昌', role: 'supporting', appearance: '花白须，玄色长衫。' })
    expect(content).toContain('已新增角色「邵德昌」')
    expect(content).not.toContain('还没有外貌')
  })

  it('承重角色没给外貌时明确说出「请补一句」，并说明后果', async () => {
    const content = await create({ name: '邵德昌', role: 'supporting' })
    expect(content).toContain('已新增角色「邵德昌」')
    expect(content).toContain('还没有外貌')
    expect(content).toContain('各章的长相会漂')
  })

  it('反派同样提示（反派是承重角色）', async () => {
    expect(await create({ name: '陆秉文', role: 'antagonist' })).toContain('还没有外貌')
  })

  it('一次性路人（minor）不提示，避免刷噪声', async () => {
    const content = await create({ name: '门房', role: 'minor' })
    expect(content).toContain('已新增角色「门房」')
    expect(content).not.toContain('还没有外貌')
  })
})
