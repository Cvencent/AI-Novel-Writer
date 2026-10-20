import type BetterSqlite3 from 'better-sqlite3'

/** 粗纲与章节归属的惰性建表，对照 baseline-blueprint-schema 的既有模式。
 *  由 ArcOutlineRepository 在首次使用时调用，不占用迁移槽位。 */
export function ensureArcOutlineTables(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS arc_outlines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      arc_index INTEGER NOT NULL UNIQUE CHECK(arc_index > 0),
      from_chapter INTEGER NOT NULL CHECK(from_chapter > 0),
      to_chapter INTEGER NOT NULL CHECK(to_chapter >= from_chapter),
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      beat TEXT NOT NULL CHECK(beat IN ('setup','escalation','reversal','low','climax','aftermath','transition')),
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed','needs_regen')),
      revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_arc_outlines_index ON arc_outlines(arc_index);

    CREATE TABLE IF NOT EXISTS outline_segment_bindings (
      chapter_number INTEGER PRIMARY KEY CHECK(chapter_number > 0),
      arc_id INTEGER NOT NULL REFERENCES arc_outlines(id) ON DELETE CASCADE,
      arc_revision_at_build INTEGER NOT NULL CHECK(arc_revision_at_build >= 0),
      fine_state TEXT NOT NULL DEFAULT 'fresh' CHECK(fine_state IN ('fresh','stale'))
    );
    CREATE INDEX IF NOT EXISTS idx_outline_binding_arc ON outline_segment_bindings(arc_id);
  `)
}
