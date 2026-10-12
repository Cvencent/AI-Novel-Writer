import { describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('../ipc-client', () => ({ ipc: { invokeWithProjectSession: invoke } }))

import { checkArchStatus } from '../architecture-service'

const session = { projectId: '灯塔', projectPath: 'C:/novels/lighthouse', leaseId: '本次打开' }
const LONG = '内容。'.repeat(30)

function respond(synopsis: string) {
  invoke.mockImplementation(async (_session: unknown, channel: string) => channel === 'db:project-core-get'
    ? { premise: LONG, worldbuilding: LONG, synopsis }
    : { status: 'ready' })
}

describe('流程脊的架构完成数', () => {
  it('分批只写到一半或被打断的大纲不算完成，写完的算', async () => {
    respond(`# 情节大纲\n\n${LONG}\n\n> 本大纲已覆盖至第 16 章（全书 24 章），其余章节将在后续批次继续生成。`)
    expect(await checkArchStatus(session)).toEqual({ premise: true, characters: true, worldbuilding: true, synopsis: false })
    respond(`# Plot Outline\n\n${LONG}\n\n> This outline covers chapters 1-16 of 24; the remaining chapters will be generated in later batches.`)
    expect((await checkArchStatus(session)).synopsis).toBe(false)
    respond(`# 情节大纲\n\n${LONG}`)
    expect((await checkArchStatus(session)).synopsis).toBe(true)
  })
})
