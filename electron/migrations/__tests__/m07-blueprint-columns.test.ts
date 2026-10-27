import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { addBlueprintExtendedColumns, ensureBaselineBlueprintTables, ensureExtendedBlueprintSchema } from '../baseline-blueprint-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../desktop-registry'
import { migrateSchema, verifySchema } from '../runner'
import { SqliteSchemaAdapter, sqliteSchemaFingerprint } from '../sqlite-schema-adapter'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

/** Reproduce exactly what 1.5.28 wrote: the lane through v7 WITHOUT the WP2 columns. */
function preM07Project() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.transaction(() => initializeLegacyBaselineSchema(db))()
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 7)
  expect(db.pragma('user_version', { simple: true })).toBe(7)
  const cols = (db.prepare('PRAGMA table_info(blueprints)').all() as { name: string }[]).map(c => c.name)
  expect(cols).not.toContain('costs_and_turns')
  db.prepare('INSERT INTO contents(body) VALUES(?)').run('作者正文不能被改动')
  return db
}

describe('M07 blueprint extended columns', () => {
  it('keeps the pre-M07 v7 schema recognizable', () => {
    const db = preM07Project()
    try {
      const registry = getDesktopMigrationRegistry()
      const fingerprint = sqliteSchemaFingerprint(db)
      expect(registry.recognizedSchemas.some(item => item.version === 7 && item.fingerprint === fingerprint)).toBe(true)
      expect(verifySchema(new SqliteSchemaAdapter(db), registry, 7).version).toBe(7)
    } finally { db.close() }
  })

  it('upgrades a pre-M07 v7 project to the current version without touching author content', () => {
    const db = preM07Project()
    try {
      const before = db.prepare('SELECT body FROM contents').pluck().get()
      const result = migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry())
      expect(result.completedSteps).toEqual(['M07', 'M08'])
      expect(result.version).toBe(CURRENT_DESKTOP_SCHEMA_VERSION)
      const cols = (db.prepare('PRAGMA table_info(blueprints)').all() as { name: string }[]).map(c => c.name)
      expect(cols).toContain('costs_and_turns')
      expect(cols).toContain('foreshadowing')
      expect(db.prepare('SELECT body FROM contents').pluck().get()).toBe(before)
      expect(migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry()).completedSteps).toEqual([])
    } finally { db.close() }
  })

  it('is idempotent and never fails when the columns already exist', () => {
    const db = new Database(':memory:')
    try {
      db.exec("CREATE TABLE blueprints (chapter_number INTEGER PRIMARY KEY, costs_and_turns TEXT NOT NULL DEFAULT '', foreshadowing TEXT NOT NULL DEFAULT '')")
      addBlueprintExtendedColumns(db)
      addBlueprintExtendedColumns(db)
      const cols = (db.prepare('PRAGMA table_info(blueprints)').all() as { name: string }[]).map(c => c.name)
      expect(cols.filter(c => c === 'costs_and_turns')).toHaveLength(1)
      expect(cols.filter(c => c === 'foreshadowing')).toHaveLength(1)
    } finally { db.close() }
  })

  it('keeps the frozen M00 baseline free of the WP2 columns', () => {
    const db = new Database(':memory:')
    try {
      db.exec("CREATE TABLE blueprints (chapter_number INTEGER PRIMARY KEY)")
      ensureBaselineBlueprintTables(db)
      const cols = (db.prepare('PRAGMA table_info(blueprints)').all() as { name: string }[]).map(c => c.name)
      expect(cols).not.toContain('costs_and_turns')
      ensureExtendedBlueprintSchema(db)
      const after = (db.prepare('PRAGMA table_info(blueprints)').all() as { name: string }[]).map(c => c.name)
      expect(after).toContain('costs_and_turns')
    } finally { db.close() }
  })
})
