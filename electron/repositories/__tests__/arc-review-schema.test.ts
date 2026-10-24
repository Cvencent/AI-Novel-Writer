import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { ensureArcReviewSchema } from '../arc-review-schema'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

describe('WP5 arc review schema', () => {
  it('creates the arc_review_runs and arc_review_findings tables idempotently', () => {
    const db = new Database(':memory:')
    ensureArcReviewSchema(db)
    ensureArcReviewSchema(db)
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name)
    expect(tables).toContain('arc_review_runs')
    expect(tables).toContain('arc_review_findings')
    const cols = (db.prepare('PRAGMA table_info(arc_review_findings)').all() as { name: string }[]).map(c => c.name)
    for (const c of ['finding_id', 'run_id', 'arc_index', 'category', 'severity', 'problem_text', 'expected_text', 'status']) expect(cols).toContain(c)
    db.close()
  })
})
