import { randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'

import { ensureArcReviewSchema } from './arc-review-schema'
import type { ArcReviewFinding } from '../../src/shared/arc-review-contract'

export type ArcReviewFindingStatus = 'open' | 'accepted' | 'ignored'

export interface ArcReviewFindingRecord extends ArcReviewFinding {
  findingId: string
  runId: string
  status: ArcReviewFindingStatus
}

export interface ArcReviewSaveInput {
  operationId: string
  runId: string
  selected: readonly number[]
  sourceHash: string
  findings: readonly ArcReviewFinding[]
}

interface FindingRow {
  finding_id: string
  run_id: string
  arc_index: number
  category: string
  severity: string
  problem_text: string
  expected_text: string
  status: string
}

function toRecord(row: FindingRow): ArcReviewFindingRecord {
  return {
    findingId: row.finding_id,
    runId: row.run_id,
    arcIndex: row.arc_index,
    category: row.category as ArcReviewFindingRecord['category'],
    severity: row.severity as ArcReviewFindingRecord['severity'],
    problemText: row.problem_text,
    expectedText: row.expected_text,
    status: row.status as ArcReviewFindingStatus,
  }
}

export class ArcReviewRepository {
  static save(input: ArcReviewSaveInput, db: BetterSqlite3.Database): { runId: string; findings: ArcReviewFindingRecord[] } {
    ensureArcReviewSchema(db)
    return db.transaction(() => {
      const existing = db.prepare('SELECT run_id FROM arc_review_runs WHERE operation_id=?').get(input.operationId) as { run_id: string } | undefined
      if (existing) return { runId: existing.run_id, findings: ArcReviewRepository.listByRun(existing.run_id, db) }
      db.prepare('INSERT INTO arc_review_runs (run_id, operation_id, selected_arc_indexes, source_hash, finding_count) VALUES (?,?,?,?,?)')
        .run(input.runId, input.operationId, JSON.stringify([...input.selected]), input.sourceHash, input.findings.length)
      const insert = db.prepare('INSERT INTO arc_review_findings (finding_id, run_id, arc_index, category, severity, problem_text, expected_text) VALUES (?,?,?,?,?,?,?)')
      for (const finding of input.findings) {
        insert.run(randomUUID(), input.runId, finding.arcIndex, finding.category, finding.severity, finding.problemText, finding.expectedText)
      }
      return { runId: input.runId, findings: ArcReviewRepository.listByRun(input.runId, db) }
    }).immediate()
  }

  static listByRun(runId: string, db: BetterSqlite3.Database): ArcReviewFindingRecord[] {
    ensureArcReviewSchema(db)
    const rows = db.prepare('SELECT finding_id, run_id, arc_index, category, severity, problem_text, expected_text, status FROM arc_review_findings WHERE run_id=? ORDER BY arc_index, finding_id').all(runId) as FindingRow[]
    return rows.map(toRecord)
  }

  static latestRun(db: BetterSqlite3.Database): { runId: string; findings: ArcReviewFindingRecord[] } | null {
    ensureArcReviewSchema(db)
    const row = db.prepare('SELECT run_id FROM arc_review_runs ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as { run_id: string } | undefined
    return row ? { runId: row.run_id, findings: ArcReviewRepository.listByRun(row.run_id, db) } : null
  }

  static resolve(runId: string, findingId: string, status: Exclude<ArcReviewFindingStatus, 'open'>, db: BetterSqlite3.Database): boolean {
    ensureArcReviewSchema(db)
    const info = db.prepare("UPDATE arc_review_findings SET status=?, resolved_at=datetime('now') WHERE run_id=? AND finding_id=? AND status='open'")
      .run(status, runId, findingId)
    return info.changes > 0
  }

  static acceptAll(runId: string, db: BetterSqlite3.Database): number {
    ensureArcReviewSchema(db)
    const info = db.prepare("UPDATE arc_review_findings SET status='accepted', resolved_at=datetime('now') WHERE run_id=? AND status='open'")
      .run(runId)
    return info.changes
  }

  static clearAll(db: BetterSqlite3.Database): void {
    ensureArcReviewSchema(db)
    db.prepare('DELETE FROM arc_review_findings').run()
    db.prepare('DELETE FROM arc_review_runs').run()
  }
}
