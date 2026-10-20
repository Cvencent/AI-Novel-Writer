import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { sqliteSchemaFingerprint } from '../sqlite-schema-adapter'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

describe('schema fingerprint and lazy feature tables', () => {
  it('ignores the arc-outline extension tables so older projects stay openable', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE project_core (id TEXT PRIMARY KEY, synopsis TEXT NOT NULL);`)
    const canonical = sqliteSchemaFingerprint(db)

    db.exec(`
      CREATE TABLE arc_outlines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        arc_index INTEGER NOT NULL UNIQUE,
        summary TEXT NOT NULL
      );
      CREATE INDEX idx_arc_outlines_index ON arc_outlines(arc_index);
      CREATE TABLE outline_segment_bindings (
        chapter_number INTEGER PRIMARY KEY,
        arc_id INTEGER NOT NULL REFERENCES arc_outlines(id) ON DELETE CASCADE,
        fine_state TEXT NOT NULL
      );
    `)

    expect(sqliteSchemaFingerprint(db)).toBe(canonical)
    db.close()
  })

  it('still detects an unknown canonical table', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE project_core (id TEXT PRIMARY KEY, synopsis TEXT NOT NULL);`)
    const canonical = sqliteSchemaFingerprint(db)
    db.exec(`CREATE TABLE unexpected_fork (id INTEGER PRIMARY KEY);`)
    expect(sqliteSchemaFingerprint(db)).not.toBe(canonical)
    db.close()
  })
})
