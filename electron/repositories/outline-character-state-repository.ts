import type BetterSqlite3 from 'better-sqlite3'
import { getProjectDb } from '../database'
import { hasCharacterIdentitySchema } from './character-repository'
import { refreshCharacterStateProjection } from './character-roster-repository'

export interface CharacterStatePatch {
  characterName: string
  chapterNumber: number
  recentEvents: string
  location?: string
  keyItems?: string
}

function requireDb(db?: BetterSqlite3.Database): BetterSqlite3.Database {
  const database = db ?? getProjectDb()
  if (!database) throw new Error('项目数据库未打开')
  return database
}

/**
 * 让细纲推进角色的动态状态。
 *
 * 只更新已存在的角色（按名字匹配），不新建角色——角色名单是大纲阶段的权威。
 * 同章重复推进会覆盖该章造成的状态变化，保持幂等。
 */
export class OutlineCharacterStateRepository {
  static apply(patch: CharacterStatePatch, db?: BetterSqlite3.Database): boolean {
    const database = requireDb(db)
    const name = patch.characterName.trim()
    if (!name) throw new Error('OUTLINE_CHARACTER_NAME_REQUIRED')
    if (!Number.isSafeInteger(patch.chapterNumber) || patch.chapterNumber < 1) {
      throw new Error('OUTLINE_CHARACTER_CHAPTER_INVALID')
    }
    return database.transaction(() => {
      const info = database.prepare(`
        UPDATE characters
        SET cs_recent_events = ?, cs_location = COALESCE(NULLIF(?, ''), cs_location),
            cs_key_items = COALESCE(NULLIF(?, ''), cs_key_items),
            cs_updated_at_chapter = ?, updated_at = datetime('now')
        WHERE name = ? AND retired = 0
      `).run(patch.recentEvents, patch.location ?? '', patch.keyItems ?? '', patch.chapterNumber, name)
      if (info.changes === 0) return false
      // cs_* 是完整角色事实的一部分。细纲推进后若不刷新 roster 事实哈希，
      // 下一次读取会把完全正常的角色卡误判为 inconsistent。
      if (hasCharacterIdentitySchema(database)) refreshCharacterStateProjection(database)
      return true
    }).immediate()
  }

  static read(characterName: string, db?: BetterSqlite3.Database): { recentEvents: string; location: string; keyItems: string; updatedAtChapter: number | null } | null {
    const database = requireDb(db)
    const row = database.prepare(`SELECT cs_recent_events, cs_location, cs_key_items, cs_updated_at_chapter
      FROM characters WHERE name = ? AND retired = 0 LIMIT 1`).get(characterName.trim()) as
      { cs_recent_events: string; cs_location: string; cs_key_items: string; cs_updated_at_chapter: number | null } | undefined
    return row ? {
      recentEvents: row.cs_recent_events ?? '', location: row.cs_location ?? '',
      keyItems: row.cs_key_items ?? '', updatedAtChapter: row.cs_updated_at_chapter ?? null,
    } : null
  }
}
