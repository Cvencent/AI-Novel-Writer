import type BetterSqlite3 from 'better-sqlite3'

/**
 * AI 检查（粗纲 / 细纲 / 蓝图）的持久化。
 * 形状对齐 review_findings，但独立成表，避免污染 m03 严格 schema。
 * target 区分被检查的创作层（arc | outline | blueprint）。
 */
export function ensureStageReviewSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stage_review_runs (
      run_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL UNIQUE,
      target TEXT NOT NULL,
      selected_target_indexes TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      finding_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS stage_review_findings (
      finding_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      target_index INTEGER NOT NULL,
      category TEXT NOT NULL,
      severity TEXT NOT NULL,
      problem_text TEXT NOT NULL,
      expected_text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT DEFAULT NULL,
      FOREIGN KEY (run_id) REFERENCES stage_review_runs(run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_stage_review_findings_run ON stage_review_findings(run_id, status);
    CREATE INDEX IF NOT EXISTS idx_stage_review_runs_target ON stage_review_runs(target, created_at DESC);
  `)
}
