import { randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'

import { ensureStageReviewSchema } from './stage-review-schema'
import type {
  StageReviewFindingRecord,
  StageReviewFindingStatus,
  StageReviewRunRecord,
  StageReviewSaveInput,
  StageReviewTarget,
} from '../../src/shared/stage-review-types'

interface FindingRow {
  finding_id: string
  run_id: string
  target_index: number
  category: string
  severity: string
  problem_text: string
  expected_text: string
  status: string
}

function toRecord(row: FindingRow): StageReviewFindingRecord {
  return {
    findingId: row.finding_id,
    runId: row.run_id,
    targetIndex: row.target_index,
    category: row.category,
    severity: row.severity,
    problemText: row.problem_text,
    expectedText: row.expected_text,
    status: row.status as StageReviewFindingStatus,
  }
}

/**
 * AI 检查结果的仓储：粗纲 / 细纲 / 蓝图共用一张表，用 target 区分。
 * save 按 operationId 幂等——工作流重放不会写出重复建议。
 */
export class StageReviewRepository {
  static save(input: StageReviewSaveInput, db: BetterSqlite3.Database): { runId: string; findings: StageReviewFindingRecord[] } {
    ensureStageReviewSchema(db)
    return db.transaction(() => {
      const existing = db.prepare('SELECT run_id FROM stage_review_runs WHERE operation_id=?').get(input.operationId) as { run_id: string } | undefined
      if (existing) return { runId: existing.run_id, findings: StageReviewRepository.listByRun(existing.run_id, db) }
      db.prepare('INSERT INTO stage_review_runs (run_id, operation_id, target, selected_target_indexes, source_hash, finding_count) VALUES (?,?,?,?,?,?)')
        .run(input.runId, input.operationId, input.target, JSON.stringify([...input.selected]), input.sourceHash, input.findings.length)
      const insert = db.prepare('INSERT INTO stage_review_findings (finding_id, run_id, target_index, category, severity, problem_text, expected_text) VALUES (?,?,?,?,?,?,?)')
      for (const finding of input.findings) {
        insert.run(randomUUID(), input.runId, finding.targetIndex, finding.category, finding.severity, finding.problemText, finding.expectedText)
      }
      return { runId: input.runId, findings: StageReviewRepository.listByRun(input.runId, db) }
    }).immediate()
  }

  static listByRun(runId: string, db: BetterSqlite3.Database): StageReviewFindingRecord[] {
    ensureStageReviewSchema(db)
    const rows = db.prepare('SELECT finding_id, run_id, target_index, category, severity, problem_text, expected_text, status FROM stage_review_findings WHERE run_id=? ORDER BY target_index, finding_id').all(runId) as FindingRow[]
    return rows.map(toRecord)
  }

  /** 某一创作层最近一次检查。不同层各自独立，避免粗纲检查覆盖细纲检查。 */
  static latestRun(target: StageReviewTarget, db: BetterSqlite3.Database): StageReviewRunRecord | null {
    ensureStageReviewSchema(db)
    const row = db.prepare('SELECT run_id, target, selected_target_indexes, source_hash, created_at FROM stage_review_runs WHERE target=? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(target) as { run_id: string; target: string; selected_target_indexes: string; source_hash: string; created_at: string } | undefined
    if (!row) return null
    let selected: number[] = []
    try {
      const parsed = JSON.parse(row.selected_target_indexes)
      if (Array.isArray(parsed)) selected = parsed.filter((value): value is number => Number.isSafeInteger(value))
    } catch { selected = [] }
    return {
      runId: row.run_id,
      target: row.target as StageReviewTarget,
      selected,
      sourceHash: row.source_hash,
      createdAt: row.created_at,
      findings: StageReviewRepository.listByRun(row.run_id, db),
    }
  }

  static resolve(runId: string, findingId: string, status: Exclude<StageReviewFindingStatus, 'open'>, db: BetterSqlite3.Database): boolean {
    ensureStageReviewSchema(db)
    const info = db.prepare("UPDATE stage_review_findings SET status=?, resolved_at=datetime('now') WHERE run_id=? AND finding_id=? AND status='open'")
      .run(status, runId, findingId)
    return info.changes > 0
  }

  static acceptAll(runId: string, db: BetterSqlite3.Database): number {
    ensureStageReviewSchema(db)
    const info = db.prepare("UPDATE stage_review_findings SET status='accepted', resolved_at=datetime('now') WHERE run_id=? AND status='open'")
      .run(runId)
    return info.changes
  }

  /** 删除一次检查（连同它的建议）。作者看过、不打算恢复时用来清掉右侧卡片。 */
  static removeRun(runId: string, db: BetterSqlite3.Database): boolean {
    ensureStageReviewSchema(db)
    return db.transaction(() => {
      db.prepare('DELETE FROM stage_review_findings WHERE run_id=?').run(runId)
      return db.prepare('DELETE FROM stage_review_runs WHERE run_id=?').run(runId).changes > 0
    }).immediate()
  }

  /** 清掉该创作层的全部检查历史。旧版只删最新一次，更早的记录会在下次进入时又顶上来。 */
  static removeForTarget(target: StageReviewTarget, db: BetterSqlite3.Database): number {
    ensureStageReviewSchema(db)
    return db.transaction(() => {
      db.prepare('DELETE FROM stage_review_findings WHERE run_id IN (SELECT run_id FROM stage_review_runs WHERE target=?)').run(target)
      return db.prepare('DELETE FROM stage_review_runs WHERE target=?').run(target).changes
    }).immediate()
  }

  static clearAll(db: BetterSqlite3.Database): void {
    ensureStageReviewSchema(db)
    db.prepare('DELETE FROM stage_review_findings').run()
    db.prepare('DELETE FROM stage_review_runs').run()
  }
}

