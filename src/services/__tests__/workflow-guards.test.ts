import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { useLocaleStore } from '../../stores/locale-store'
import {
  guardArchitectureGeneration,
  guardChapterWriting,
  guardCharacterRegeneration,
  guardDirectoryGeneration,
} from '../workflow-guards'
import { ipc } from '../ipc-client'

vi.mock('../ipc-client', () => ({
  ipc: {
    invokeWithProjectSession: vi.fn(),
  },
}))

/** 按 channel 分派的 IPC 桩：mock 的签名与实际调用形状不同，这里统一收口一次断言。 */
function mockGuardIpc(handler: (channel: string, args: unknown[]) => Promise<unknown>) {
  vi.mocked(ipc.invokeWithProjectSession).mockImplementation(((...callArgs: unknown[]) =>
    handler(String(callArgs[1]), callArgs.slice(2))) as never)
}

const projectPath = 'C:/novels/guard-directory'
const projectSession: ProjectSessionContext = {
  projectId: 'guard-directory',
  leaseId: 'lease-guard-directory',
  projectPath,
}
const project = {
  id: projectSession.projectId,
  sessionLease: projectSession.leaseId,
  path: projectPath,
  name: 'Guard Directory',
  novelConfig: {},
}
let currentProject: typeof project | null = project

vi.mock('../../stores/project-store', () => ({
  useProjectStore: {
    getState: vi.fn(() => ({ currentProject })),
  },
}))

afterEach(() => {
  currentProject = project
  project.novelConfig = {}
  useLocaleStore.setState({ locale: 'zh-CN' })
})

describe('architecture workflow guard locale', () => {
  it('returns a missing-project guard in English', () => {
    currentProject = null
    useLocaleStore.setState({ locale: 'en-US' })

    const result = guardArchitectureGeneration(projectPath, projectSession)

    expect(result).toMatchObject({ ok: false, message: 'Open or create a project first.' })
  })

  it('returns a missing-config guard in English', () => {
    useLocaleStore.setState({ locale: 'en-US' })

    const result = guardArchitectureGeneration(projectPath, projectSession)

    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('Fill in the core outline or protagonist profile'),
    })
    expect(result.message).not.toMatch(/[\u4e00-\u9fff]/u)
  })
})

describe('directory workflow guard', () => {
  beforeEach(() => {
    vi.mocked(ipc.invokeWithProjectSession).mockReset()
    vi.mocked(ipc.invokeWithProjectSession).mockImplementation((async (
      _session: ProjectSessionContext,
      channel: string,
    ) => {
      if (channel === 'db:project-core-get') {
        return {
          premise: 'p'.repeat(60),
          charactersArch: '',
          worldbuilding: 'w'.repeat(60),
          synopsis: 's'.repeat(60),
        }
      }
      if (channel === 'db:character-get-all') return []
      throw new Error(`Unexpected channel: ${channel}`)
    }) as never)
  })

  it('hard-blocks an empty character roster before optional architecture warnings', async () => {
    await expect(guardDirectoryGeneration(projectPath, projectSession)).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('角色卡不存在'),
    })
    expect(vi.mocked(ipc.invokeWithProjectSession).mock.calls.map(([, channel]) => channel))
      .toEqual(['db:project-core-get', 'db:character-get-all'])
  })

  it.each([
    {
      label: 'story premise',
      core: null,
      expected: 'The story premise has not been generated',
    },
    {
      label: 'character roster',
      core: {
        premise: 'p'.repeat(60),
        charactersArch: '',
        worldbuilding: 'w'.repeat(60),
        synopsis: 's'.repeat(60),
      },
      expected: 'No character cards exist',
    },
  ])('returns a missing-$label guard in English', async ({ core, expected }) => {
    useLocaleStore.setState({ locale: 'en-US' })
    vi.mocked(ipc.invokeWithProjectSession).mockImplementation((async (
      _session: ProjectSessionContext,
      channel: string,
    ) => {
      if (channel === 'db:project-core-get') return core
      if (channel === 'db:character-get-all') return []
      throw new Error(`Unexpected channel: ${channel}`)
    }) as never)

    const result = await guardDirectoryGeneration(projectPath, projectSession)

    expect(result).toMatchObject({ ok: false, message: expect.stringContaining(expected) })
    expect(result.message).not.toMatch(/[\u4e00-\u9fff]/u)
  })
})

describe('chapter workflow guard locale', () => {
  it('returns the missing-blueprint guard in the frozen English locale', async () => {
    vi.mocked(ipc.invokeWithProjectSession).mockResolvedValueOnce([])
    useLocaleStore.setState({ locale: 'en-US' })

    await expect(guardChapterWriting(1, projectPath, projectSession)).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('No chapter blueprints have been generated'),
    })
  })
})

describe('character regeneration guard locale', () => {
  it('returns both character-regeneration failures in English', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    currentProject = null
    await expect(guardCharacterRegeneration()).resolves.toMatchObject({
      ok: false,
      message: 'Open or create a project first.',
    })

    currentProject = project
    vi.mocked(ipc.invokeWithProjectSession).mockResolvedValueOnce([{ chapterNumber: 1 }])
    const blocked = await guardCharacterRegeneration(projectSession)

    expect(blocked).toMatchObject({
      ok: false,
      message: expect.stringContaining('Character cards cannot be regenerated while chapter blueprints exist'),
    })
    expect(blocked.message).not.toMatch(/[\u4e00-\u9fff]/u)
  })
})

  it('accepts a blueprint batch when only this batch is covered by the outline (WP3)', async () => {
    vi.mocked(ipc.invokeWithProjectSession).mockImplementation((async (_session: unknown, channel: string) => {
      if (channel === 'db:project-core-get') return {
        premise: 'p'.repeat(60), charactersArch: 'c'.repeat(60),
        worldbuilding: 'w'.repeat(60),
        synopsis: ['## 第1章：标题1', '', '正文一。', '', '## 第2章：标题2', '', '正文二。'].join(String.fromCharCode(10)),
      }
      if (channel === 'db:character-get-all') return [{ name: '主角' }]
      throw new Error('Unexpected channel: ' + channel)
    }) as never)
    await expect(guardDirectoryGeneration(projectPath, projectSession, undefined, { from: 1, to: 2 })).resolves.toMatchObject({ ok: true })
  })

  it('still warns when the requested batch is not covered (WP3)', async () => {
    vi.mocked(ipc.invokeWithProjectSession).mockImplementation((async (_session: unknown, channel: string) => {
      if (channel === 'db:project-core-get') return {
        premise: 'p'.repeat(60), charactersArch: 'c'.repeat(60),
        worldbuilding: 'w'.repeat(60),
        synopsis: ['## 第1章：标题1', '', '正文一。'].join(String.fromCharCode(10)),
      }
      if (channel === 'db:character-get-all') return [{ name: '主角' }]
      throw new Error('Unexpected channel: ' + channel)
    }) as never)
    const result = await guardDirectoryGeneration(projectPath, projectSession, undefined, { from: 1, to: 5 })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('细纲')
  })


// issue #55：守卫阻断「写下一章」时必须说明**该修哪一章**，否则弹层做不出出口按钮，
// 作者只能照脚注反复点同一个必然被拒绝的按钮。
describe('chapter workflow guard repair target (issue #55)', () => {
  it('前一章定稿后处理未完成时给出 repair-finalize 与那一章的章号', async () => {
    mockGuardIpc(async channel => {
      if (channel === 'db:blueprint-get-all') return [{ chapterNumber: 12 }]
      if (channel === 'db:character-get-all') return [{ name: '周叙' }]
      if (channel === 'db:draft-get-finalized') return { id: 11 }
      if (channel === 'db:post-process-get-latest-run') {
        return { id: 'run-1', sourceLabel: '第12章定稿', createdAt: '', updatedAt: '', allCriticalPassed: false }
      }
      if (channel === 'db:post-process-get-steps') {
        return [{ stepKey: 'chapter_notes', label: '章节剧情要点', critical: true, ok: false, errorMsg: '' }]
      }
      return null
    })

    await expect(guardChapterWriting(13, projectPath, projectSession)).resolves.toMatchObject({
      ok: false,
      action: 'repair-finalize',
      chapterNumber: 12,
    })
  })

  it('前一章尚未定稿时同样给出该修哪一章', async () => {
    mockGuardIpc(async channel => {
      if (channel === 'db:blueprint-get-all') return [{ chapterNumber: 12 }]
      if (channel === 'db:character-get-all') return [{ name: '周叙' }]
      if (channel === 'db:draft-get-finalized') return null
      return null
    })

    await expect(guardChapterWriting(13, projectPath, projectSession)).resolves.toMatchObject({
      ok: false,
      action: 'repair-finalize',
      chapterNumber: 12,
    })
  })

  it('正常放行时不带 action（不能把出口按钮误挂上去）', async () => {
    mockGuardIpc(async channel => {
      if (channel === 'db:blueprint-get-all') return [{ chapterNumber: 12 }]
      if (channel === 'db:character-get-all') return [{ name: '周叙' }]
      if (channel === 'db:draft-get-finalized') return { id: 11 }
      if (channel === 'db:post-process-get-latest-run') {
        return { id: 'run-1', sourceLabel: '第12章定稿', createdAt: '', updatedAt: '', allCriticalPassed: true }
      }
      if (channel === 'db:post-process-get-steps') return []
      return null
    })

    await expect(guardChapterWriting(13, projectPath, projectSession)).resolves.toEqual({ ok: true })
  })
})
