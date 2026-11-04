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
 *
 * ⚠️ 但 `cs_*` 是**正史列**，只有已定稿正文能推进它（issue #130）：
 * 细纲通常跑在正文前面（本仓推荐用法就是「先铺 +2 章细纲再写正文」）。
 * 旧实现把细纲章号直接写进 `cs_updated_at_chapter`，于是角色卡与 Agent 读取
 * 会看到「第 26 章才要发生的事」，而正文只定稿到第 24 章；`cs_recent_events`
 * 里写的也是那一章的计划。计划不属于「已经发生」。
 *
 * 两条结构性判据（都不引词表）：
 * 1. **该章没有定稿正文 → 不写正史**。这一章还没发生，任何摘要都只是计划；
 *    返回 false，调用方据此知道「这次细纲推进没有成为事实」。
 * 2. **正文派生优先**：该章的 `derived` 状态已经在库里时，不让细纲摘要覆盖它
 *    （重跑旧章细纲不该把正文证明过的事实换成计划文本）。
 *
 * 计划本身不丢：细纲摘要仍写进 `summary_snapshots`（`outline-summary-save`），
 * 那是正文之前的权威材料，起草侧读的是它。
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
      const row = database.prepare('SELECT cs_provenance FROM characters WHERE name = ? AND retired = 0 LIMIT 1')
        .pluck().get(name) as string | undefined
      if (row === undefined) return false
      // 判据 1：正文还没写到这一章 → 只是计划，不进正史。
      const finalized = database.prepare(`SELECT 1 FROM drafts WHERE chapter_number=? AND status='finalized' LIMIT 1`)
        .get(patch.chapterNumber) !== undefined
      if (!finalized) return false
      const provenance = parseProvenance(row)
      // 判据 2：这一章的状态已经由定稿正文派生出来，细纲摘要不许覆盖。
      const derivedHere = (field: string): boolean => {
        const entry = provenance[field]
        return Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)
          && (entry as { kind?: unknown }).kind === 'derived'
          && (entry as { source?: { chapterNumber?: unknown } }).source?.chapterNumber === patch.chapterNumber)
      }
      if (derivedHere('recentEvents')) return false
      // 细纲层写的是「计划摘要」：必须同时摘掉被写字段的 provenance，否则旧的
      // author/derived 标记会继续给这段摘要背书。
      // recentEvents 每次都会写；location / keyItems 只在传了非空值时才写，
      // 没写的字段保留原来源。
      const overwritten = [
        'recentEvents',
        ...(patch.location?.trim() && !derivedHere('location') ? ['location'] : []),
        ...(patch.keyItems?.trim() && !derivedHere('keyItems') ? ['keyItems'] : []),
      ]
      for (const field of overwritten) delete provenance[field]
      const info = database.prepare(`
        UPDATE characters
        SET cs_recent_events = ?, cs_location = COALESCE(NULLIF(?, ''), cs_location),
            cs_key_items = COALESCE(NULLIF(?, ''), cs_key_items),
            cs_updated_at_chapter = ?, cs_provenance = ?, updated_at = datetime('now')
        WHERE name = ? AND retired = 0
      `).run(patch.recentEvents,
        patch.location?.trim() && !derivedHere('location') ? patch.location : '',
        patch.keyItems?.trim() && !derivedHere('keyItems') ? patch.keyItems : '',
        patch.chapterNumber, JSON.stringify(provenance), name)
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
