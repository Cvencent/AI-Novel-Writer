import { getProjectDb } from '../database'
import type { ConsistencyAcknowledgement, ConsistencyExemption } from '../../src/shared/consistency-preflight'

function requireText(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 500) throw new Error(`${label}无效`)
  return normalized
}

export class ConsistencyExemptionRepository {
  static list(db = getProjectDb()): ConsistencyExemption[] {
    if (!db) return []
    const rows = db.prepare(`
      SELECT stable_fact_key AS stableFactKey, reason, revoked
      FROM consistency_exemptions ORDER BY stable_fact_key
    `).all() as Array<{ stableFactKey: string; reason: string; revoked: number }>
    return rows.map(row => ({ ...row, revoked: row.revoked === 1 }))
  }

  static save(stableFactKey: string, reason: string): void {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    db.prepare(`
      INSERT INTO consistency_exemptions (stable_fact_key, reason, revoked)
      VALUES (?, ?, 0)
      ON CONFLICT(stable_fact_key) DO UPDATE SET reason = excluded.reason, revoked = 0
    `).run(requireText(stableFactKey, '稳定事实键'), requireText(reason, '豁免原因'))
  }

  static revoke(stableFactKey: string): void {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    db.prepare('UPDATE consistency_exemptions SET revoked = 1 WHERE stable_fact_key = ?')
      .run(requireText(stableFactKey, '稳定事实键'))
  }
}

/**
 * 预检提醒的「我已知，稍后处理」状态（issue #79）。
 *
 * 与豁免分开：豁免表示「刻意为之」，ack 表示「知道是真问题、回头再改」。
 * 作者此前只有前者可用，于是要么每章点「带提醒继续写」，要么把缺点记成好事。
 */
export class ConsistencyAcknowledgementRepository {
  static list(db = getProjectDb()): ConsistencyAcknowledgement[] {
    if (!db) return []
    return db.prepare(`
      SELECT stable_fact_key AS stableFactKey, acknowledged_at AS acknowledgedAt
      FROM consistency_acknowledgements ORDER BY acknowledged_at, stable_fact_key
    `).all() as ConsistencyAcknowledgement[]
  }

  static acknowledge(stableFactKey: string): void {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    // ack 一次即永久静音：stable_fact_key 跨章稳定，后续章重算出来仍是同一个 key。
    db.prepare(`
      INSERT INTO consistency_acknowledgements (stable_fact_key) VALUES (?)
      ON CONFLICT(stable_fact_key) DO NOTHING
    `).run(requireText(stableFactKey, '稳定事实键'))
  }

  /** 撤销 ack（作者回头要重新看见这条）。 */
  static unacknowledge(stableFactKey: string): void {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开')
    db.prepare('DELETE FROM consistency_acknowledgements WHERE stable_fact_key = ?')
      .run(requireText(stableFactKey, '稳定事实键'))
  }
}
