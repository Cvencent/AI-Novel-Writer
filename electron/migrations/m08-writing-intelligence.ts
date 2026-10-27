import type BetterSqlite3 from 'better-sqlite3'

export const M08_WRITING_INTELLIGENCE_SQL = `
CREATE TABLE blueprint_scene_plans (
  chapter_number INTEGER PRIMARY KEY,
  scenes_json TEXT NOT NULL CHECK(json_valid(scenes_json)),
  source_hash TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (chapter_number) REFERENCES blueprints(chapter_number) ON DELETE CASCADE
);

CREATE TABLE draft_quality_reviews (
  draft_id INTEGER PRIMARY KEY REFERENCES drafts(id) ON DELETE CASCADE,
  chapter_number INTEGER NOT NULL CHECK(chapter_number > 0),
  content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
  panel_json TEXT NOT NULL CHECK(json_valid(panel_json)),
  weighted_score REAL NOT NULL CHECK(weighted_score >= 0 AND weighted_score <= 100),
  blocking_count INTEGER NOT NULL CHECK(blocking_count >= 0),
  reviewed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_draft_quality_chapter_score
  ON draft_quality_reviews(chapter_number, weighted_score DESC, draft_id);

CREATE TABLE chapter_commits (
  commit_id TEXT PRIMARY KEY,
  chapter_number INTEGER NOT NULL CHECK(chapter_number > 0),
  draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  finalization_id TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
  facts_json TEXT NOT NULL CHECK(json_valid(facts_json)),
  character_states_json TEXT NOT NULL CHECK(json_valid(character_states_json)),
  foreshadowing_json TEXT NOT NULL CHECK(json_valid(foreshadowing_json)),
  quality_json TEXT NOT NULL CHECK(json_valid(quality_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_chapter_commits_chapter
  ON chapter_commits(chapter_number, created_at DESC);

CREATE TABLE character_voice_profiles (
  character_id TEXT PRIMARY KEY REFERENCES characters(character_id) ON DELETE CASCADE,
  source_draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
  profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_character_voice_source_draft
  ON character_voice_profiles(source_draft_id);
`

export function applyM08WritingIntelligence(db: BetterSqlite3.Database): void {
  if (!db.inTransaction) throw new Error('WRITING_INTELLIGENCE_MIGRATION_TRANSACTION_REQUIRED')
  const required = ['blueprints', 'drafts', 'characters']
  for (const table of required) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
      throw new Error('WRITING_INTELLIGENCE_MIGRATION_SCHEMA_UNRECOGNIZED')
    }
  }
  db.exec(M08_WRITING_INTELLIGENCE_SQL)
}

export function verifyM08WritingIntelligence(db: BetterSqlite3.Database): boolean {
  try {
    if (db.pragma('foreign_keys', { simple: true }) !== 1 || (db.pragma('foreign_key_check') as unknown[]).length) return false
    const expected = new Map<string, string[]>([
      ['blueprint_scene_plans', ['chapter_number', 'scenes_json', 'source_hash', 'updated_at']],
      ['draft_quality_reviews', ['draft_id', 'chapter_number', 'content_hash', 'panel_json', 'weighted_score', 'blocking_count', 'reviewed_at']],
      ['chapter_commits', ['commit_id', 'chapter_number', 'draft_id', 'finalization_id', 'content_hash', 'facts_json', 'character_states_json', 'foreshadowing_json', 'quality_json', 'created_at']],
      ['character_voice_profiles', ['character_id', 'source_draft_id', 'content_hash', 'profile_json', 'updated_at']],
    ])
    for (const [table, columns] of expected) {
      const actual = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name)
      if (columns.some(column => !actual.includes(column))) return false
    }
    return true
  } catch { return false }
}
