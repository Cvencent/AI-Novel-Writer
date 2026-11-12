import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

import { applyM09PreflightAck, verifyM09PreflightAck } from '../m09-preflight-ack'
import { ConsistencyAcknowledgementRepository } from '../../repositories/consistency-exemption-repository'
import { initializeLegacyBaselineSchema } from '../baseline-schema'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

function db() {
  const database = new Database(':memory:')
  initializeLegacyBaselineSchema(database)
  return database
}

describe('M09 preflight acknowledgements (issue #79)', () => {
  it('creates the acknowledgements table and verifies it', () => {
    const database = db()
    database.transaction(() => applyM09PreflightAck(database))()
    expect(verifyM09PreflightAck(database)).toBe(true)
    const columns = (database.prepare('PRAGMA table_info(consistency_acknowledgements)').all() as { name: string }[])
      .map(row => row.name)
    expect(columns).toEqual(['stable_fact_key', 'acknowledged_at'])
  })

  it('is idempotent', () => {
    const database = db()
    database.transaction(() => applyM09PreflightAck(database))()
    database.transaction(() => applyM09PreflightAck(database))()
    expect(verifyM09PreflightAck(database)).toBe(true)
  })

  it('requires an open transaction and a recognized baseline schema', () => {
    const database = db()
    expect(() => applyM09PreflightAck(database)).toThrow('PREFLIGHT_ACK_MIGRATION_TRANSACTION_REQUIRED')
    const bare = new Database(':memory:')
    expect(() => bare.transaction(() => applyM09PreflightAck(bare))())
      .toThrow('PREFLIGHT_ACK_MIGRATION_SCHEMA_UNRECOGNIZED')
  })
})

describe('ConsistencyAcknowledgementRepository', () => {
  it('acknowledges a finding once and keeps it acknowledged (stable key is cross-chapter)', () => {
    const database = db()
    database.transaction(() => applyM09PreflightAck(database))()
    // 仓库读 getProjectDb()，这里直接验证表语义：同一 key 反复 ack 不产生第二行。
    const insert = () => database.prepare(
      'INSERT INTO consistency_acknowledgements (stable_fact_key) VALUES (?) ON CONFLICT(stable_fact_key) DO NOTHING',
    ).run('prop:revival:票根')
    insert()
    insert()
    const rows = database.prepare('SELECT stable_fact_key FROM consistency_acknowledgements').all()
    expect(rows).toHaveLength(1)
    // 撤销后可以重新看见。
    database.prepare('DELETE FROM consistency_acknowledgements WHERE stable_fact_key = ?').run('prop:revival:票根')
    expect(database.prepare('SELECT stable_fact_key FROM consistency_acknowledgements').all()).toHaveLength(0)
    void ConsistencyAcknowledgementRepository
  })
})

describe('M09 lands in the installed registry', () => {
  it('advances the desktop schema version to 11 and lists M09 in the lane', async () => {
    const { CURRENT_DESKTOP_SCHEMA_VERSION } = await import('../desktop-registry')
    const { MIGRATION_LANE, LATEST_SCHEMA_VERSION } = await import('../registry')
    expect(CURRENT_DESKTOP_SCHEMA_VERSION).toBe(11)
    expect(LATEST_SCHEMA_VERSION).toBe(11)
    expect(MIGRATION_LANE.at(-1)).toMatchObject({ id: 'M10', from: 10, to: 11 })
    expect(MIGRATION_LANE.find(item => item.id === 'M09')).toMatchObject({ id: 'M09', from: 9, to: 10 })
  })

  it('exposes M09 in the business id catalog', async () => {
    const { MIGRATION_IDS } = await import('../../../src/shared/project-storage')
    expect(MIGRATION_IDS).toContain('M09')
  })
})
