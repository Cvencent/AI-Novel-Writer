import { createHash } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import type { SchemaWriter } from './registry'

/**
 * Feature-owned extension tables that are created lazily after the canonical
 * schema has been installed. They are excluded from the format fingerprint:
 * adding a feature must never make an otherwise valid project look like an
 * unknown fork. Only these exact names are ignored; every canonical table,
 * index, trigger and view still contributes to the fingerprint.
 */
export const SCHEMA_EXTENSION_TABLES: ReadonlySet<string> = new Set([
  'arc_outlines',
  'outline_segment_bindings',
])

export function sqliteSchemaFingerprint(db: BetterSqlite3.Database): string {
  const rows = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as Array<{
    type: string
    name: string
    tbl_name: string
    sql: string | null
  }>
  const schema = rows.filter(row => !SCHEMA_EXTENSION_TABLES.has(row.tbl_name) && !SCHEMA_EXTENSION_TABLES.has(row.name))
  // Exact DDL, including constraints, indexes, triggers and views. Unknown forks
  // cannot be admitted merely because selected table/column names look familiar.
  return createHash('sha256').update(JSON.stringify(schema)).digest('hex')
}

export class SqliteSchemaAdapter implements SchemaWriter {
  constructor(readonly database: BetterSqlite3.Database) {}
  readUserVersion(): number { return this.database.pragma('user_version', { simple: true }) as number }
  readSchemaFingerprint(): string { return sqliteSchemaFingerprint(this.database) }
  integrityCheck(): boolean { return this.database.pragma('integrity_check', { simple: true }) === 'ok' }
  foreignKeyCheck(): boolean { return (this.database.pragma('foreign_key_check') as unknown[]).length === 0 }
  transaction<T>(operation: () => T): T { return this.database.transaction(operation)() }
  writeUserVersion(version: number): void {
    if (!Number.isSafeInteger(version) || version < 0) throw new Error('INVALID_SCHEMA_VERSION')
    this.database.pragma(`user_version = ${version}`)
  }
  executeMigrationSql(sql: string): void { this.database.exec(sql) }
}
