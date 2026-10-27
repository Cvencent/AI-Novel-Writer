import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../desktop-registry'
import { migrateSchema, verifySchema } from '../runner'
import { SqliteSchemaAdapter } from '../sqlite-schema-adapter'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

function preM08Project() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.transaction(() => initializeLegacyBaselineSchema(db))()
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8)
  expect(db.pragma('user_version', { simple: true })).toBe(8)
  db.prepare('INSERT INTO contents(body) VALUES(?)').run('作者正文不能被迁移改写')
  return db
}

const tables = [
  'blueprint_scene_plans',
  'draft_quality_reviews',
  'chapter_commits',
  'character_voice_profiles',
]

describe('M08 writing intelligence schema', () => {
  it('upgrades a v8 project additively and preserves author prose', () => {
    const db = preM08Project()
    try {
      const before = db.prepare('SELECT body FROM contents').pluck().get()
      const result = migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry())
      expect(result.completedSteps).toEqual(['M08'])
      expect(result.version).toBe(CURRENT_DESKTOP_SCHEMA_VERSION)
      for (const table of tables) {
        expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)).toBeTruthy()
      }
      expect(db.prepare('SELECT body FROM contents').pluck().get()).toBe(before)
      expect(migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry()).completedSteps).toEqual([])
      expect(verifySchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION).version)
        .toBe(CURRENT_DESKTOP_SCHEMA_VERSION)
    } finally { db.close() }
  })

  it('rejects malformed JSON in the new structured tables', () => {
    const db = preM08Project()
    try {
      migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry())
      expect(() => db.prepare(`INSERT INTO blueprint_scene_plans(chapter_number,scenes_json)
        VALUES(1,?)`).run('{not-json')).toThrow()
      expect(() => db.prepare(`INSERT INTO draft_quality_reviews(
        draft_id,chapter_number,content_hash,panel_json,weighted_score,blocking_count
      ) VALUES(1,1,?,?,50,0)`).run('a'.repeat(64), '[]')).toThrow()
    } finally { db.close() }
  })
})
