import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeWithProjectSession = vi.fn()
vi.mock('../ipc-client', () => ({
  ipc: { invokeWithProjectSession: (...args: unknown[]) => invokeWithProjectSession(...args) },
}))

import { createCharacterCardForPreflight } from '../preflight-character-card'

const session = { projectId: 'p', leaseId: 'l', projectPath: 'C:/novels/card' }

/**
 * issue #160：预检提醒上的「为「徐汐」建卡」要真的落库。
 *
 * 现场：那条提醒从第 64 章重报到第 70 章，文案写着「就在角色名单里建卡」，而弹层里
 * `建卡` 两个字一次都点不到。这里固定住按钮背后那一次写：
 *   - 只写**空卡**（姓名 + 定位 + 来源备注），不替作者编身份；
 *   - 走唯一写通道（`db:character-roster-commit`），带 expectedRevision 做 CAS；
 *   - 同名已存在时不重复建。
 */
describe('createCharacterCardForPreflight (issue #160)', () => {
  const entry = (name: string, role = 'supporting') => ({
    characterId: `id-${name}`, name, role,
    gender: '', age: '', appearance: '', personality: '', background: '',
    abilities: '', motivation: '', relationships: [], arc: '', notes: '',
  })
  const snapshot = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    revision: 7,
    identityRevision: 3,
    migrationState: 'ready',
    status: 'ready',
    entries: [entry('周叙', 'protagonist')],
    renderedMarkdown: '',
    projectionHash: 'h',
    factHash: 'f',
    nameOnlyFactHash: 'n',
    ...overrides,
  })

  beforeEach(() => {
    invokeWithProjectSession.mockReset()
  })

  it('建一张空卡并提交，带上来源备注和 CAS revision', async () => {
    invokeWithProjectSession.mockImplementation(async (_s: unknown, channel: string, payload?: { entries?: Array<{ name: string }> }) => {
      if (channel === 'db:character-roster-read') return snapshot()
      if (channel === 'db:character-roster-commit') {
        return {
          success: true,
          receipt: {
            snapshot: snapshot(),
            created: [{ selectionKey: payload!.entries![payload!.entries!.length - 1]!.name, characterId: 'c2' }],
          },
        }
      }
      return null
    })

    const outcome = await createCharacterCardForPreflight(session, { name: ' 徐汐 ', note: '由第 75 章的写前预检建卡。内容待补。' })
    expect(outcome).toMatchObject({ status: 'created', name: '徐汐' })

    const commit = invokeWithProjectSession.mock.calls.find(call => call[1] === 'db:character-roster-commit')!
    const request = commit[2] as {
      expectedRevision: number
      intent: string
      entries: Array<{ name: string, role: string, notes: string }>
    }
    // CAS：并发改过名单时会被主进程挡住，而不是静默覆盖。
    expect(request.expectedRevision).toBe(7)
    expect(request.intent).toBe('manual_edit')
    const created = request.entries.at(-1)!
    expect(created.name).toBe('徐汐')
    // 只落机械部分：定位 + 来源备注。身份/动机/外貌一律留空（判据不替她编）。
    expect(created.role).toBe('supporting')
    expect(created.notes).toContain('写前预检建卡')
    expect((created as Record<string, unknown>).background).toBe('')
    expect((created as Record<string, unknown>).motivation).toBe('')
    expect((created as Record<string, unknown>).appearance).toBe('')
  })

  it('同名已在名册时不重复建（也不发提交）', async () => {
    invokeWithProjectSession.mockImplementation(async (_s: unknown, channel: string) => (
      channel === 'db:character-roster-read' ? snapshot({ entries: [entry('周叙', 'protagonist'), entry('徐汐')] }) : null
    ))
    const outcome = await createCharacterCardForPreflight(session, { name: '徐汐', note: 'x' })
    expect(outcome).toEqual({ status: 'already-exists', name: '徐汐' })
    expect(invokeWithProjectSession.mock.calls.some(call => call[1] === 'db:character-roster-commit')).toBe(false)
  })

  it('主进程拒绝时如实报错，不假装成功', async () => {
    invokeWithProjectSession.mockImplementation(async (_s: unknown, channel: string) => {
      if (channel === 'db:character-roster-read') return snapshot()
      if (channel === 'db:character-roster-commit') return { success: false, error: 'revision 冲突' }
      return null
    })
    const outcome = await createCharacterCardForPreflight(session, { name: '徐汐', note: 'x' })
    expect(outcome).toEqual({ status: 'failed', error: 'revision 冲突' })
  })
})