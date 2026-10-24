import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { ensureBaselineBlueprintTables } from '../baseline-blueprint-schema'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const legacy = "CREATE TABLE blueprints (chapter_number INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '', purpose TEXT NOT NULL DEFAULT '', key_events TEXT NOT NULL DEFAULT '', characters TEXT NOT NULL DEFAULT '[]', suspense_hook TEXT NOT NULL DEFAULT '', user_guidance TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', notes_updated_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))"

describe('WP2a blueprint extended columns', () => {
  it('adds costs_and_turns and foreshadowing to an existing blueprints table', () => {
    const db = new Database(':memory:')
    db.exec(legacy)
    ensureBaselineBlueprintTables(db)
    const cols = (db.prepare('PRAGMA table_info(blueprints)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toContain('costs_and_turns')
    expect(cols).toContain('foreshadowing')
    db.close()
  })
  it('is idempotent', () => {
    const db = new Database(':memory:')
    db.exec(legacy)
    ensureBaselineBlueprintTables(db)
    ensureBaselineBlueprintTables(db)
    const cols = (db.prepare('PRAGMA table_info(blueprints)').all() as { name: string }[]).map(c => c.name)
    expect(cols.filter(c => c === 'costs_and_turns')).toHaveLength(1)
    db.close()
  })
})
