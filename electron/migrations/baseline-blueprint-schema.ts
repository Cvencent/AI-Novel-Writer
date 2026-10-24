import type BetterSqlite3 from 'better-sqlite3'

/** Columns added by WP2 (M07). Kept separate so the registry can build a
 *  pre-M07 reference schema and so M07 can add them explicitly. */
export const BLUEPRINT_EXTENDED_COLUMNS = Object.freeze([
  { name: 'costs_and_turns', ddl: "ALTER TABLE blueprints ADD COLUMN costs_and_turns TEXT NOT NULL DEFAULT ''" },
  { name: 'foreshadowing', ddl: "ALTER TABLE blueprints ADD COLUMN foreshadowing TEXT NOT NULL DEFAULT ''" },
] as const)

/** Idempotently add the WP2 columns. Safe to call on any canonical project. */
export function addBlueprintExtendedColumns(db: BetterSqlite3.Database): void {
  const columns = db.prepare('PRAGMA table_info(blueprints)').all() as Array<{ name: string }>
  for (const column of BLUEPRINT_EXTENDED_COLUMNS) {
    if (!columns.some(existing => existing.name === column.name)) db.exec(column.ddl)
  }
}

/** The legacy lazy tables installed once by M00. These predate M07. */
export function ensureBaselineBlueprintOperationTables(db: BetterSqlite3.Database): void {
  db.exec(`
      CREATE TABLE IF NOT EXISTS blueprint_commit_operations (
        operation_id TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('full', 'replace-range')),
        start_chapter INTEGER NOT NULL,
        end_chapter INTEGER NOT NULL,
        character_sync_input TEXT NOT NULL,
        committed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS blueprint_character_sync_operations (
        operation_id TEXT PRIMARY KEY,
        blueprint_commit_operation_id TEXT NOT NULL UNIQUE,
        blueprint_commit_payload_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed')),
        start_chapter INTEGER NOT NULL,
        end_chapter INTEGER NOT NULL,
        character_sync_input TEXT NOT NULL,
        completion_receipt TEXT DEFAULT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT DEFAULT NULL,
        FOREIGN KEY (blueprint_commit_operation_id)
          REFERENCES blueprint_commit_operations(operation_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_blueprint_character_sync_status
        ON blueprint_character_sync_operations(status, created_at);
    `)
}

/**
 * The legacy lazy tables are installed once by M00 in canonical projects.
 *
 * M00's domain is frozen: this deliberately does NOT add the WP2 columns, so
 * every previously shipped schema keeps the fingerprint it was created with.
 * The columns are added by migration M07 and lazily by runtime callers.
 */
export function ensureBaselineBlueprintTables(db: BetterSqlite3.Database): void {
  ensureBaselineBlueprintOperationTables(db)
}

/** Runtime guard: legacy lazy tables plus the WP2 columns. */
export function ensureExtendedBlueprintSchema(db: BetterSqlite3.Database): void {
  ensureBaselineBlueprintOperationTables(db)
  addBlueprintExtendedColumns(db)
}
