import type { Database as BetterSqlite3Database } from 'better-sqlite3'


/** M10：review_cycles.review_id 去 UNIQUE——复验后第二轮修稿需要同审稿行多周期（issue #248）。 */
export function applyM10MultiRoundReviewCycle(db: BetterSqlite3Database): void {
  /**
   * ⚠️ `PRAGMA foreign_keys=OFF` 在这里是**空操作**：SQLite 明确禁止在事务内改这个开关
   * （desktop-registry 用 `db.transaction(() => applyM10(db))()` 包住本函数）。于是
   * `DROP TABLE review_cycles` 会按 ON DELETE CASCADE **把子表行一起删掉**——
   * `review_findings` 与 `review_cycle_merges` 都 REFERENCES review_cycles(cycle_id)。
   *
   * 现场（issue #248）：源起打开即 `MIGRATION_VERIFICATION_FAILED`。逐段验证定位到
   * M03 的 merge 快照闸门：M10 跑完 review_cycle_merges 从 2 行变 0 行，
   * `snapshots.size !== merge-committed 周期数` → false → 书打不开。
   *
   * 所以改建表顺序：**先把子表行快照进 TEMP 表**（temp 表没有到 review_cycles 的
   * 外键，不受 CASCADE 影响），换表后原样写回。不依赖关外键，因此和「在事务里跑」
   * 的调用方式相容。
   */
  const rebuild = db.transaction(() => {
    // 0) 快照所有引用 review_cycles(cycle_id) 的子表行（动态发现，避免漏掉未来新增的）。
    const children: Array<{ table: string; temp: string }> = []
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
    for (const { name } of tables) {
      if (name === 'review_cycles' || name === 'review_cycles_m10' || name.startsWith('_m10_')) continue
      const fks = db.prepare(`PRAGMA foreign_key_list("${name.replace(/"/gu, '""')}")`).all() as Array<{ table: string }>
      if (!fks.some(fk => fk.table === 'review_cycles')) continue
      const temp = `_m10_snap_${name}`
      db.exec(`CREATE TEMP TABLE "${temp}" AS SELECT * FROM "${name}"`)
      children.push({ table: name, temp })
    }
    // 1) 新形态表（review_id 去 UNIQUE，改普通索引；confirmation_review_id 同步去
    //    UNIQUE——第二轮的确认行也是新行，两轮各自独占没有意义，唯一性由流程保证）。
    db.exec(`
      CREATE TABLE review_cycles_m10 (
        cycle_id TEXT PRIMARY KEY,
        root_action_id TEXT NOT NULL REFERENCES generation_roots(root_action_id),
        review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        review_content_hash TEXT NOT NULL,
        confirmation_review_id INTEGER REFERENCES reviews(id) ON DELETE CASCADE,
        confirmation_content_hash TEXT,
        revision_id INTEGER UNIQUE REFERENCES revisions(id),
        source_hash TEXT NOT NULL,
        finding_set_hash TEXT NOT NULL,
        comparison_version INTEGER NOT NULL,
        revision_status TEXT NOT NULL,
        merged_hash TEXT,
        recheck_count INTEGER NOT NULL CHECK(recheck_count IN (0,1)),
        recheck_attempt_id TEXT UNIQUE REFERENCES generation_attempts(attempt_id),
        CHECK((confirmation_review_id IS NULL) = (confirmation_content_hash IS NULL)),
        CHECK((revision_status='not-generated' AND revision_id IS NULL AND merged_hash IS NULL AND recheck_count=0 AND recheck_attempt_id IS NULL)
          OR (revision_status='generated' AND revision_id IS NOT NULL AND merged_hash IS NULL AND recheck_count=0 AND recheck_attempt_id IS NULL)
          OR (revision_status='merge-committed' AND revision_id IS NOT NULL AND merged_hash IS NOT NULL
            AND ((recheck_count=0 AND recheck_attempt_id IS NULL) OR (recheck_count=1 AND recheck_attempt_id IS NOT NULL))))
      )`)
    // 2) 拷数据（列序按新表）。
    db.exec(`
      INSERT INTO review_cycles_m10(cycle_id,root_action_id,review_id,review_content_hash,
        confirmation_review_id,confirmation_content_hash,revision_id,source_hash,
        finding_set_hash,comparison_version,revision_status,merged_hash,recheck_count,recheck_attempt_id)
      SELECT cycle_id,root_action_id,review_id,review_content_hash,
        confirmation_review_id,confirmation_content_hash,revision_id,source_hash,
        finding_set_hash,comparison_version,revision_status,merged_hash,recheck_count,recheck_attempt_id
      FROM review_cycles`)
    // 3) 换名。DROP 会按 CASCADE 清掉子表行（FK 开关在事务里改不动），
    //    这里就是要让它清——第 4 步用快照写回。SQLite 的 FK 按**名字**解析，
    //    rename 后子表自动指向新表。
    db.exec('DROP TABLE review_cycles')
    db.exec('ALTER TABLE review_cycles_m10 RENAME TO review_cycles')
    // 4) 子表行原样写回（此时父表行已在位，FK 自洽）。
    for (const { table, temp } of children) {
      db.exec(`INSERT INTO "${table}" SELECT * FROM "${temp}"`)
      db.exec(`DROP TABLE "${temp}"`)
    }
    // 5) 复核审稿行的反查索引（第二轮周期按 reviewId 取最新）。
    db.exec('CREATE INDEX IF NOT EXISTS review_cycles_review_id ON review_cycles(review_id)')
  })
  rebuild()
}

/** M10 的形态校验：review_id 列**不含 UNIQUE**、有普通索引。 */
export function verifyM10MultiRoundReviewCycle(db: BetterSqlite3Database): boolean {
  try {
    const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='review_cycles'")
      .pluck().get() ?? '')
    require('fs').appendFileSync('.runtime/vg-trace.log', '[m10v] sqlHead=' + sql.slice(0, 80) + ' noUniqueCol=' + !sql.includes('review_id INTEGER NOT NULL UNIQUE') + ' | ')
    if (!sql.includes('review_id INTEGER NOT NULL REFERENCES reviews(id)')) { require('fs').appendFileSync('.runtime/vg-trace.log', '[m10v] FAIL col-anchor | '); return false }
    if (sql.includes('review_id INTEGER NOT NULL UNIQUE')) { require('fs').appendFileSync('.runtime/vg-trace.log', '[m10v] FAIL still-unique | '); return false }
    const index = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='review_cycles' AND sql LIKE '%review_id%'").get() as { name: string } | undefined
    if (!index) return false
    return (db.pragma('foreign_key_check') as unknown[]).length === 0
  } catch { return false }
}
