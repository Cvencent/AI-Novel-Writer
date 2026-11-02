import type BetterSqlite3 from 'better-sqlite3'

/**
 * 预检提醒的「我已知，稍后处理」状态（issue #79）。
 *
 * 与 `consistency_exemptions` **分开存储**是刻意的。那张表的语义是「这是我刻意这么写的」，
 * 而作者面对历史旧账时想表达的是「我知道这是真缺点、我要回头改，只是先不想再看它」。
 * 混用会让「已保存安排」这份台账把缺点记成好事，也让作者根本没有第三种口径可用。
 *
 * `stable_fact_key` 本身是**跨章稳定**的（这正是它名字的含义）：同一件事在后续章节
 * 被重算出来时仍是同一个 key，所以 ack 一次即永久静音——不会像 #79 描述的那样
 * 每章重报一遍。
 */
export const M09_PREFLIGHT_ACK_SQL = `
CREATE TABLE IF NOT EXISTS consistency_acknowledgements (
  stable_fact_key TEXT PRIMARY KEY,
  acknowledged_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`

export function applyM09PreflightAck(db: BetterSqlite3.Database): void {
  if (!db.inTransaction) throw new Error('PREFLIGHT_ACK_MIGRATION_TRANSACTION_REQUIRED')
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='consistency_exemptions'").get()) {
    throw new Error('PREFLIGHT_ACK_MIGRATION_SCHEMA_UNRECOGNIZED')
  }
  db.exec(M09_PREFLIGHT_ACK_SQL)
}

export function verifyM09PreflightAck(db: BetterSqlite3.Database): boolean {
  try {
    const actual = (db.prepare('PRAGMA table_info(consistency_acknowledgements)').all() as Array<{ name: string }>)
      .map(row => row.name)
    return ['stable_fact_key', 'acknowledged_at'].every(column => actual.includes(column))
  } catch { return false }
}