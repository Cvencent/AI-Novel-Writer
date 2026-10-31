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

type StateProvenance = Record<string, unknown>

function parseProvenance(value: string | null | undefined): StateProvenance {
  if (!value?.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as StateProvenance : {}
  } catch { return {} }
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
      // 细纲层写的是「计划摘要」，不是定稿正文证明的事实：
      // 必须同时摘掉被写字段的 provenance，否则旧的 author/derived 标记会
      // 继续给这段摘要背书，下一章写稿就会把它当作者事实注入。
      const row = database.prepare('SELECT cs_provenance FROM characters WHERE name = ? AND retired = 0 LIMIT 1')
        .pluck().get(name) as string | undefined
      if (row === undefined) return false
      const provenance = parseProvenance(row)
      // recentEvents 每次都会写；location / keyItems 只在传了非空值时才写，
      // 没写的字段保留原来源。
      const overwritten = [
        'recentEvents',
        ...(patch.location?.trim() ? ['location'] : []),
        ...(patch.keyItems?.trim() ? ['keyItems'] : []),
      ]
      for (const field of overwritten) delete provenance[field]
      const info = database.prepare(`
        UPDATE characters
        SET cs_recent_events = ?, cs_location = COALESCE(NULLIF(?, ''), cs_location),
            cs_key_items = COALESCE(NULLIF(?, ''), cs_key_items),
            cs_updated_at_chapter = ?, cs_provenance = ?, updated_at = datetime('now')
        WHERE name = ? AND retired = 0
      `).run(patch.recentEvents, patch.location ?? '', patch.keyItems ?? '', patch.chapterNumber,
        JSON.stringify(provenance), name)
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
