import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { ensureStageReviewSchema } from '../stage-review-schema'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

describe('stage review schema', () => {
  it('creates the stage review tables idempotently', () => {
    const db = new Database(':memory:')
    ensureStageReviewSchema(db)
    ensureStageReviewSchema(db)
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name)
    expect(tables).toContain('stage_review_runs')
    expect(tables).toContain('stage_review_findings')
    const cols = (db.prepare('PRAGMA table_info(stage_review_findings)').all() as { name: string }[]).map(c => c.name)
    for (const c of ['finding_id', 'run_id', 'target_index', 'category', 'severity', 'problem_text', 'expected_text', 'status']) expect(cols).toContain(c)
    const runCols = (db.prepare('PRAGMA table_info(stage_review_runs)').all() as { name: string }[]).map(c => c.name)
    for (const c of ['run_id', 'operation_id', 'target', 'selected_target_indexes', 'source_hash']) expect(runCols).toContain(c)
    db.close()
  })
})
