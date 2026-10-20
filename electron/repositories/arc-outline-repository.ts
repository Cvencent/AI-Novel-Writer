import type BetterSqlite3 from 'better-sqlite3'
import { getProjectDb } from '../database'
import { ensureArcOutlineTables } from './arc-outline-schema'

export type ArcBeat = 'setup' | 'escalation' | 'reversal' | 'low' | 'climax' | 'aftermath' | 'transition'
export const ARC_BEATS: readonly ArcBeat[] = ['setup', 'escalation', 'reversal', 'low', 'climax', 'aftermath', 'transition']
export type ArcStatus = 'draft' | 'confirmed' | 'needs_regen'

export interface ArcOutlineRecord {
  id: number
  arcIndex: number
  fromChapter: number
  toChapter: number
  title: string
  summary: string
  beat: ArcBeat
  status: ArcStatus
  revision: number
  createdAt: string
  updatedAt: string
}

export interface ArcOutlineSaveInput {
  arcIndex: number
  fromChapter: number
  toChapter: number
  title: string
  summary: string
  beat: ArcBeat
}

interface ArcOutlineRow {
  id: number
  arc_index: number
  from_chapter: number
  to_chapter: number
  title: string
  summary: string
  beat: ArcBeat
  status: ArcStatus
  revision: number
  created_at: string
  updated_at: string
}

function requireDb(db?: BetterSqlite3.Database): BetterSqlite3.Database {
  const database = db ?? getProjectDb()
  if (!database) throw new Error('项目数据库未打开')
  ensureArcOutlineTables(database)
  return database
}

function toRecord(row: ArcOutlineRow): ArcOutlineRecord {
  return {
    id: row.id,
    arcIndex: row.arc_index,
    fromChapter: row.from_chapter,
    toChapter: row.to_chapter,
    title: row.title,
    summary: row.summary,
    beat: row.beat,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 粗纲分段台账。区间必须从第 1 章起连续且互不重叠。 */
export class ArcOutlineRepository {
  static list(db?: BetterSqlite3.Database): ArcOutlineRecord[] {
    const database = requireDb(db)
    const rows = database.prepare(
      'SELECT * FROM arc_outlines ORDER BY arc_index ASC',
    ).all() as ArcOutlineRow[]
    return rows.map(toRecord)
  }

  static save(input: ArcOutlineSaveInput, db?: BetterSqlite3.Database): ArcOutlineRecord {
    const database = requireDb(db)
    if (!Number.isSafeInteger(input.arcIndex) || input.arcIndex < 1) throw new Error('ARC_OUTLINE_INDEX_INVALID')
    if (!Number.isSafeInteger(input.fromChapter) || !Number.isSafeInteger(input.toChapter) || input.fromChapter < 1 || input.toChapter < input.fromChapter) {
      throw new Error('ARC_OUTLINE_RANGE_INVALID')
    }
    if (!input.title.trim() || !input.summary.trim()) throw new Error('ARC_OUTLINE_TEXT_REQUIRED')

    return database.transaction(() => {
      const existing = ArcOutlineRepository.list(database)
      const coveredTo = existing.reduce((max, item) => Math.max(max, item.toChapter), 0)
      const expectedFrom = coveredTo + 1
      if (input.fromChapter < expectedFrom) throw new Error('ARC_OUTLINE_RANGE_OVERLAP')
      if (input.fromChapter > expectedFrom) throw new Error('ARC_OUTLINE_RANGE_GAP')
      const lastIndex = existing.reduce((max, item) => Math.max(max, item.arcIndex), 0)
      if (input.arcIndex !== lastIndex + 1) throw new Error('ARC_OUTLINE_RANGE_GAP')

      const info = database.prepare(`
        INSERT INTO arc_outlines (arc_index, from_chapter, to_chapter, title, summary, beat, status, revision)
        VALUES (?, ?, ?, ?, ?, ?, 'draft', 0)
      `).run(input.arcIndex, input.fromChapter, input.toChapter, input.title.trim(), input.summary.trim(), input.beat)
      const row = database.prepare('SELECT * FROM arc_outlines WHERE id = ?').get(info.lastInsertRowid) as ArcOutlineRow
      return toRecord(row)
    }).immediate()
  }

  static confirm(arcIndex: number, expectedRevision: number, db?: BetterSqlite3.Database): ArcOutlineRecord {
    const database = requireDb(db)
    return database.transaction(() => {
      const row = database.prepare('SELECT * FROM arc_outlines WHERE arc_index = ?').get(arcIndex) as ArcOutlineRow | undefined
      if (!row) throw new Error('ARC_OUTLINE_NOT_FOUND')
      if (row.revision !== expectedRevision) throw new Error('ARC_OUTLINE_REVISION_STALE')
      database.prepare(`
        UPDATE arc_outlines
        SET status = 'confirmed', revision = revision + 1, updated_at = datetime('now')
        WHERE arc_index = ?
      `).run(arcIndex)
      const updated = database.prepare('SELECT * FROM arc_outlines WHERE arc_index = ?').get(arcIndex) as ArcOutlineRow
      return toRecord(updated)
    }).immediate()
  }

  /** 编辑正文：修订号 +1，状态回到 draft，等待作者再确认。 */
  static revise(arcIndex: number, expectedRevision: number, summary: string, db?: BetterSqlite3.Database): ArcOutlineRecord {
    const database = requireDb(db)
    const text = summary.trim()
    if (!text) throw new Error('ARC_OUTLINE_TEXT_REQUIRED')
    return database.transaction(() => {
      const row = database.prepare('SELECT * FROM arc_outlines WHERE arc_index = ?').get(arcIndex) as ArcOutlineRow | undefined
      if (!row) throw new Error('ARC_OUTLINE_NOT_FOUND')
      if (row.revision !== expectedRevision) throw new Error('ARC_OUTLINE_REVISION_STALE')
      database.prepare(`
        UPDATE arc_outlines
        SET summary = ?, status = 'draft', revision = revision + 1, updated_at = datetime('now')
        WHERE arc_index = ?
      `).run(text, arcIndex)
      const updated = database.prepare('SELECT * FROM arc_outlines WHERE arc_index = ?').get(arcIndex) as ArcOutlineRow
      return toRecord(updated)
    }).immediate()
  }

  /** 按作者方向重生成一段：标题、正文、beat 一起替换，修订号 +1 并回到待确认。 */
  static replaceSegment(
    arcIndex: number,
    expectedRevision: number,
    input: { title: string; summary: string; beat: ArcBeat },
    db?: BetterSqlite3.Database,
  ): ArcOutlineRecord {
    const database = requireDb(db)
    if (!input.title.trim() || !input.summary.trim()) throw new Error('ARC_OUTLINE_TEXT_REQUIRED')
    if (!(ARC_BEATS as readonly string[]).includes(input.beat)) throw new Error('ARC_OUTLINE_BEAT_INVALID')
    return database.transaction(() => {
      const row = database.prepare('SELECT * FROM arc_outlines WHERE arc_index = ?').get(arcIndex) as ArcOutlineRow | undefined
      if (!row) throw new Error('ARC_OUTLINE_NOT_FOUND')
      if (row.revision !== expectedRevision) throw new Error('ARC_OUTLINE_REVISION_STALE')
      database.prepare(`
        UPDATE arc_outlines
        SET title = ?, summary = ?, beat = ?, status = 'draft', revision = revision + 1, updated_at = datetime('now')
        WHERE arc_index = ?
      `).run(input.title.trim(), input.summary.trim(), input.beat, arcIndex)
      const updated = database.prepare('SELECT * FROM arc_outlines WHERE arc_index = ?').get(arcIndex) as ArcOutlineRow
      return toRecord(updated)
    }).immediate()
  }

  /** 把该段之后的后续段标记为需要重新生成（它们依赖被改段的结果）。 */
  static markNeedsRegenFrom(arcIndex: number, db?: BetterSqlite3.Database): number {
    const database = requireDb(db)
    const result = database.prepare(`
      UPDATE arc_outlines SET status = 'needs_regen', updated_at = datetime('now')
      WHERE arc_index > ? AND status <> 'needs_regen'
    `).run(arcIndex)
    return result.changes
  }

  /** 删除指定段及其之后的所有段；返回删除条数。 */
  static removeFrom(arcIndex: number, db?: BetterSqlite3.Database): number {
    const database = requireDb(db)
    const result = database.prepare('DELETE FROM arc_outlines WHERE arc_index >= ?').run(arcIndex)
    return result.changes
  }
}
