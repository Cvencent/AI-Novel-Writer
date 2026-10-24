import type BetterSqlite3 from 'better-sqlite3'

/** 粗纲 AI 检查的持久化（WP5）。形状对齐 review_findings，但独立成表，避免污染 m03 严格 schema。 */
export function ensureArcReviewSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS arc_review_runs (
      run_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL UNIQUE,
      selected_arc_indexes TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      finding_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS arc_review_findings (
      finding_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      arc_index INTEGER NOT NULL,
      category TEXT NOT NULL,
      severity TEXT NOT NULL,
      problem_text TEXT NOT NULL,
      expected_text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT DEFAULT NULL,
      FOREIGN KEY (run_id) REFERENCES arc_review_runs(run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_arc_review_findings_run ON arc_review_findings(run_id, status);
  `)
}
