import type BetterSqlite3 from 'better-sqlite3'
import { getProjectDb } from '../database'
import { ensureArcOutlineTables } from './arc-outline-schema'

export type FineState = 'fresh' | 'stale'

export interface OutlineSegmentBinding {
  chapterNumber: number
  arcId: number
  arcRevisionAtBuild: number
  fineState: FineState
}

interface BindingRow {
  chapter_number: number
  arc_id: number
  arc_revision_at_build: number
  fine_state: FineState
}

function requireDb(db?: BetterSqlite3.Database): BetterSqlite3.Database {
  const database = db ?? getProjectDb()
  if (!database) throw new Error('项目数据库未打开')
  ensureArcOutlineTables(database)
  return database
}

function toBinding(row: BindingRow): OutlineSegmentBinding {
  return {
    chapterNumber: row.chapter_number,
    arcId: row.arc_id,
    arcRevisionAtBuild: row.arc_revision_at_build,
    fineState: row.fine_state,
  }
}

/** 章节到粗纲段的归属。用于判定细纲是否因粗纲改动而过期。 */
export class OutlineSegmentBindingRepository {
  /** 为一段区间内的每章写入归属；重复写入时覆盖并重置为 fresh。 */
  static bindRange(chapterFrom: number, chapterTo: number, arcId: number, arcRevision: number, db?: BetterSqlite3.Database): number {
    const database = requireDb(db)
    if (!Number.isSafeInteger(chapterFrom) || !Number.isSafeInteger(chapterTo) || chapterFrom < 1 || chapterTo < chapterFrom) {
      throw new Error('OUTLINE_BINDING_RANGE_INVALID')
    }
    if (!Number.isSafeInteger(arcId) || arcId < 1) throw new Error('OUTLINE_BINDING_ARC_INVALID')
    if (!Number.isSafeInteger(arcRevision) || arcRevision < 0) throw new Error('OUTLINE_BINDING_REVISION_INVALID')

    return database.transaction(() => {
      const statement = database.prepare(`
        INSERT INTO outline_segment_bindings (chapter_number, arc_id, arc_revision_at_build, fine_state)
        VALUES (?, ?, ?, 'fresh')
        ON CONFLICT(chapter_number) DO UPDATE SET
          arc_id = excluded.arc_id,
          arc_revision_at_build = excluded.arc_revision_at_build,
          fine_state = 'fresh'
      `)
      let changes = 0
      for (let chapter = chapterFrom; chapter <= chapterTo; chapter += 1) {
        statement.run(chapter, arcId, arcRevision)
        changes += 1
      }
      return changes
    }).immediate()
  }

  static bindingFor(chapterNumber: number, db?: BetterSqlite3.Database): OutlineSegmentBinding | null {
    const database = requireDb(db)
    const row = database.prepare(
      'SELECT * FROM outline_segment_bindings WHERE chapter_number = ?',
    ).get(chapterNumber) as BindingRow | undefined
    return row ? toBinding(row) : null
  }

  static listStale(db?: BetterSqlite3.Database): number[] {
    const database = requireDb(db)
    const rows = database.prepare(
      "SELECT chapter_number FROM outline_segment_bindings WHERE fine_state = 'stale' ORDER BY chapter_number ASC",
    ).all() as { chapter_number: number }[]
    return rows.map(row => row.chapter_number)
  }

  /** 把该段中修订号落后于当前粗纲的章节标记为 stale，返回受影响的章号。 */
  static markStaleFrom(arcId: number, currentRevision: number, db?: BetterSqlite3.Database): number[] {
    const database = requireDb(db)
    return database.transaction(() => {
      const affected = database.prepare(`
        SELECT chapter_number FROM outline_segment_bindings
        WHERE arc_id = ? AND arc_revision_at_build < ? AND fine_state = 'fresh'
        ORDER BY chapter_number ASC
      `).all(arcId, currentRevision) as { chapter_number: number }[]
      if (affected.length > 0) {
        database.prepare(`
          UPDATE outline_segment_bindings
          SET fine_state = 'stale'
          WHERE arc_id = ? AND arc_revision_at_build < ? AND fine_state = 'fresh'
        `).run(arcId, currentRevision)
      }
      return affected.map(row => row.chapter_number)
    }).immediate()
  }
}
