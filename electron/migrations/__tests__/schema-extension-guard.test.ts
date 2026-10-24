import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { ensureBaselineBlueprintTables } from '../baseline-blueprint-schema'
import { getDesktopMigrationRegistry } from '../desktop-registry'
import { migrateSchema, probeSchema } from '../runner'
import { SCHEMA_EXTENSION_TABLES, SqliteSchemaAdapter, sqliteSchemaFingerprint } from '../sqlite-schema-adapter'
import { ensureStageReviewSchema } from '../../repositories/stage-review-schema'
import { ensureArcOutlineTables } from '../../repositories/arc-outline-schema'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

function canonical() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.transaction(() => initializeLegacyBaselineSchema(db))()
  ensureBaselineBlueprintTables(db)
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry())
  return db
}

describe('schema extension tables never change the project fingerprint', () => {
  it('creating the lazily-installed feature tables keeps the project openable', () => {
    const db = canonical()
    try {
      const before = sqliteSchemaFingerprint(db)
      ensureStageReviewSchema(db)
      ensureArcOutlineTables(db)
      const after = sqliteSchemaFingerprint(db)
      expect(after).toBe(before)
      expect(() => probeSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry())).not.toThrow()
    } finally { db.close() }
  })

  it('declares every lazily-created review table as an extension table', () => {
    expect(SCHEMA_EXTENSION_TABLES.has('stage_review_runs')).toBe(true)
    expect(SCHEMA_EXTENSION_TABLES.has('stage_review_findings')).toBe(true)
    expect(SCHEMA_EXTENSION_TABLES.has('arc_outlines')).toBe(true)
    expect(SCHEMA_EXTENSION_TABLES.has('outline_segment_bindings')).toBe(true)
  })
})
