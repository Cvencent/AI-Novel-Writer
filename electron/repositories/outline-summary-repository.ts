import type BetterSqlite3 from 'better-sqlite3'
import { getProjectDb } from '../database'

/** 细纲层的章节摘要。与定稿层摘要共表，用 draft_id IS NULL 区分。 */
export interface OutlineChapterSummary {
  chapterNumber: number
  chapterNotes: string
  characterStates: string
  continuityFacts: string[]
}

interface SummaryRow {
  chapter_number: number
  chapter_notes: string
  character_states: string
  continuity_facts: string
}

function requireDb(db?: BetterSqlite3.Database): BetterSqlite3.Database {
  const database = db ?? getProjectDb()
  if (!database) throw new Error('项目数据库未打开')
  return database
}

function parseFacts(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch { return [] }
}

/**
 * 大纲阶段的连续性记忆。
 *
 * 与定稿层共用 summary_snapshots：大纲层写入 draft_id IS NULL 的行，
 * 定稿层写入 draft_id 非空的行，两者互不覆盖。
 */
export class OutlineSummaryRepository {
  /** 写入或覆盖某章的细纲摘要（同章只保留一条大纲层记录）。 */
  static save(summary: OutlineChapterSummary, db?: BetterSqlite3.Database): void {
    const database = requireDb(db)
    const facts = JSON.stringify(summary.continuityFacts)
    database.transaction(() => {
      database.prepare(
        'DELETE FROM summary_snapshots WHERE chapter_number = ? AND draft_id IS NULL',
      ).run(summary.chapterNumber)
      database.prepare(`INSERT INTO summary_snapshots (draft_id, chapter_number, chapter_notes, character_states, continuity_facts)
        VALUES (NULL, ?, ?, ?, ?)`).run(
        summary.chapterNumber, summary.chapterNotes, summary.characterStates, facts,
      )
    }).immediate()
  }

  static get(chapterNumber: number, db?: BetterSqlite3.Database): OutlineChapterSummary | null {
    const database = requireDb(db)
    const row = database.prepare(`SELECT chapter_number, chapter_notes, character_states, continuity_facts
      FROM summary_snapshots WHERE chapter_number = ? AND draft_id IS NULL
      ORDER BY id DESC LIMIT 1`).get(chapterNumber) as SummaryRow | undefined
    return row ? {
      chapterNumber: row.chapter_number,
      chapterNotes: row.chapter_notes,
      characterStates: row.character_states,
      continuityFacts: parseFacts(row.continuity_facts),
    } : null
  }

  /** 读取截至某章（含）之前的最近 N 条大纲层摘要，按章号升序返回。 */
  static listBefore(chapterNumber: number, limit: number, db?: BetterSqlite3.Database): OutlineChapterSummary[] {
    const database = requireDb(db)
    const rows = database.prepare(`SELECT chapter_number, chapter_notes, character_states, continuity_facts
      FROM summary_snapshots WHERE draft_id IS NULL AND chapter_number <= ?
      ORDER BY chapter_number DESC LIMIT ?`).all(chapterNumber, Math.max(1, limit)) as SummaryRow[]
    return rows.reverse().map(row => ({
      chapterNumber: row.chapter_number,
      chapterNotes: row.chapter_notes,
      characterStates: row.character_states,
      continuityFacts: parseFacts(row.continuity_facts),
    }))
  }

  static count(db?: BetterSqlite3.Database): number {
    const database = requireDb(db)
    return database.prepare('SELECT COUNT(*) FROM summary_snapshots WHERE draft_id IS NULL').pluck().get() as number
  }
}
