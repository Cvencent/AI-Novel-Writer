import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getProjectDb } from '../database'
import {
  parseEditorialPanelResponse,
  parseScenePlanResponse,
  validateChapterCommitInput,
  type ChapterCommit,
  type CharacterVoiceProfileRecord,
  type DraftQualityReview,
  type EditorialPanelReview,
  type SceneCard,
} from '../../src/shared/writing-intelligence'

function requireDb(db?: Database.Database): Database.Database {
  const resolved = db ?? getProjectDb()
  if (!resolved) throw new Error('项目数据库未打开')
  return resolved
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T } catch { return fallback }
}

function contentHashOf(text: string): string {
  // The caller supplies the authoritative hash whenever available. This local
  // helper is only used for scenes, which are derived planning data.
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

export class WritingIntelligenceRepository {
  static getScenes(chapterNumber: number, db?: Database.Database): SceneCard[] {
    const row = requireDb(db).prepare('SELECT scenes_json FROM blueprint_scene_plans WHERE chapter_number=?').get(chapterNumber) as { scenes_json: string } | undefined
    return row ? parseScenePlanResponse(row.scenes_json) : []
  }

  static saveScenes(chapterNumber: number, scenes: readonly SceneCard[], db?: Database.Database): SceneCard[] {
    if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1) throw new Error('章节号无效')
    const normalized = parseScenePlanResponse(JSON.stringify({ scenes }))
    requireDb(db).prepare(`INSERT INTO blueprint_scene_plans(chapter_number,scenes_json,source_hash,updated_at)
      VALUES(?,?,?,datetime('now'))
      ON CONFLICT(chapter_number) DO UPDATE SET scenes_json=excluded.scenes_json,
        source_hash=excluded.source_hash,updated_at=datetime('now')`)
      .run(chapterNumber, json(normalized), contentHashOf(json(normalized)))
    return normalized
  }

  static saveQualityReview(input: {
    draftId: number
    chapterNumber: number
    contentHash: string
    panel: EditorialPanelReview
  }, db?: Database.Database): DraftQualityReview {
    if (!Number.isSafeInteger(input.draftId) || input.draftId < 1) throw new Error('草稿身份无效')
    if (!Number.isSafeInteger(input.chapterNumber) || input.chapterNumber < 1) throw new Error('章节号无效')
    if (!/^[a-f0-9]{64}$/iu.test(input.contentHash)) throw new Error('草稿内容哈希无效')
    const panel = parseEditorialPanelResponse(JSON.stringify(input.panel))
    const database = requireDb(db)
    database.prepare(`INSERT INTO draft_quality_reviews(
      draft_id,chapter_number,content_hash,panel_json,weighted_score,blocking_count,reviewed_at
    ) VALUES(?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(draft_id) DO UPDATE SET chapter_number=excluded.chapter_number,content_hash=excluded.content_hash,
      panel_json=excluded.panel_json,weighted_score=excluded.weighted_score,
      blocking_count=excluded.blocking_count,reviewed_at=datetime('now')`)
      .run(input.draftId, input.chapterNumber, input.contentHash, json(panel), panel.weightedScore, panel.blockingCount)
    return this.getQualityReview(input.draftId, database)!
  }

  static getQualityReview(draftId: number, db?: Database.Database): DraftQualityReview | null {
    const row = requireDb(db).prepare(`SELECT draft_id,chapter_number,content_hash,panel_json,reviewed_at
      FROM draft_quality_reviews WHERE draft_id=?`).get(draftId) as {
        draft_id: number; chapter_number: number; content_hash: string; panel_json: string; reviewed_at: string
      } | undefined
    if (!row) return null
    const panel = parseEditorialPanelResponse(row.panel_json)
    return { ...panel, draftId: row.draft_id, chapterNumber: row.chapter_number, contentHash: row.content_hash, reviewedAt: row.reviewed_at }
  }

  static listQualityReviews(chapterNumber?: number, db?: Database.Database, limit = 200): DraftQualityReview[] {
    const database = requireDb(db)
    const rows = (chapterNumber === undefined
      ? database.prepare(`SELECT draft_id,chapter_number,content_hash,panel_json,reviewed_at
          FROM draft_quality_reviews ORDER BY reviewed_at DESC,draft_id DESC LIMIT ?`).all(limit)
      : database.prepare(`SELECT draft_id,chapter_number,content_hash,panel_json,reviewed_at
          FROM draft_quality_reviews WHERE chapter_number=? ORDER BY weighted_score DESC,draft_id DESC LIMIT ?`).all(chapterNumber, limit)) as Array<{
            draft_id: number; chapter_number: number; content_hash: string; panel_json: string; reviewed_at: string
          }>
    return rows.map(row => ({ ...parseEditorialPanelResponse(row.panel_json), draftId: row.draft_id,
      chapterNumber: row.chapter_number, contentHash: row.content_hash, reviewedAt: row.reviewed_at }))
  }

  static saveVoiceProfiles(
    sourceDraftId: number,
    contentHash: string,
    profiles: readonly CharacterVoiceProfileRecord[],
    db?: Database.Database,
  ): CharacterVoiceProfileRecord[] {
    if (!/^[a-f0-9]{64}$/iu.test(contentHash)) throw new Error('章节内容哈希无效')
    const database = requireDb(db)
    const tx = database.transaction(() => {
      for (const profile of profiles) {
        database.prepare(`INSERT INTO character_voice_profiles(
          character_id,source_draft_id,content_hash,profile_json,updated_at
        ) VALUES(?,?,?,?,datetime('now'))
        ON CONFLICT(character_id) DO UPDATE SET source_draft_id=excluded.source_draft_id,
          content_hash=excluded.content_hash,profile_json=excluded.profile_json,updated_at=datetime('now')`)
          .run(profile.characterId, sourceDraftId, contentHash, json({
            characterId: profile.characterId, characterName: profile.characterName, summary: profile.summary,
            sentenceStyle: profile.sentenceStyle, vocabulary: profile.vocabulary,
            dialogueHabits: profile.dialogueHabits, emotionalTells: profile.emotionalTells,
            avoid: profile.avoid, evidence: profile.evidence,
          }))
      }
    })
    tx.immediate()
    return this.listVoiceProfiles(database).filter(profile => profile.sourceDraftId === sourceDraftId)
  }

  static listVoiceProfiles(db?: Database.Database): CharacterVoiceProfileRecord[] {
    const rows = requireDb(db).prepare(`SELECT character_id,source_draft_id,content_hash,profile_json,updated_at
      FROM character_voice_profiles ORDER BY character_id`).all() as Array<{
        character_id: string; source_draft_id: number; content_hash: string; profile_json: string; updated_at: string
      }>
    return rows.map(row => {
      const profile = parseJson(row.profile_json, {} as Record<string, unknown>)
      return {
        characterId: row.character_id,
        characterName: String(profile.characterName ?? ''),
        summary: String(profile.summary ?? ''),
        sentenceStyle: String(profile.sentenceStyle ?? ''),
        vocabulary: String(profile.vocabulary ?? ''),
        dialogueHabits: Array.isArray(profile.dialogueHabits) ? profile.dialogueHabits.map(String) : [],
        emotionalTells: String(profile.emotionalTells ?? ''),
        avoid: Array.isArray(profile.avoid) ? profile.avoid.map(String) : [],
        evidence: Array.isArray(profile.evidence) ? profile.evidence.map(String) : [],
        sourceDraftId: row.source_draft_id,
        contentHash: row.content_hash,
        updatedAt: row.updated_at,
      }
    })
  }

  static getVoiceProfile(characterId: string, db?: Database.Database): CharacterVoiceProfileRecord | null {
    return this.listVoiceProfiles(db).find(profile => profile.characterId === characterId) ?? null
  }

  static getChapterCommit(chapterNumber: number, db?: Database.Database): ChapterCommit | null {
    const row = requireDb(db).prepare('SELECT * FROM chapter_commits WHERE chapter_number=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(chapterNumber) as Record<string, unknown> | undefined
    return row ? this.rowToCommit(row) : null
  }

  static listChapterCommits(db?: Database.Database): ChapterCommit[] {
    return (requireDb(db).prepare('SELECT * FROM chapter_commits ORDER BY chapter_number').all() as Record<string, unknown>[])
      .map(row => this.rowToCommit(row))
  }

  static commitFinalizedChapter(chapterNumber: number, draftId: number, db?: Database.Database): ChapterCommit {
    const database = requireDb(db)
    const finalization = database.prepare(`SELECT f.finalization_id,f.content_hash
      FROM finalization_outbox f JOIN drafts d ON d.id=f.draft_id
      WHERE f.draft_id=? AND f.chapter_number=? AND d.status='finalized'`).get(draftId, chapterNumber) as {
        finalization_id: string; content_hash: string
      } | undefined
    if (!finalization) throw new Error('CHAPTER_COMMIT_FINALIZATION_REQUIRED')
    const summary = database.prepare(`SELECT continuity_facts,character_state_candidates,chapter_notes
      FROM summary_snapshots WHERE draft_id=? ORDER BY id DESC LIMIT 1`).get(draftId) as {
        continuity_facts: string; character_state_candidates: string; chapter_notes: string
      } | undefined
    if (!summary) throw new Error('CHAPTER_COMMIT_CONTINUITY_REQUIRED')
    const facts = parseJson<Array<{ category?: string; statement?: string; evidence?: string }>>(summary.continuity_facts, [])
      .filter(fact => fact.statement && fact.evidence)
      .map(fact => ({ kind: String(fact.category ?? 'event'), statement: String(fact.statement), evidence: String(fact.evidence) }))
    const stateStore = parseJson<unknown>(summary.character_state_candidates, [])
    const candidates = Array.isArray(stateStore) ? stateStore
      : stateStore && typeof stateStore === 'object' && Array.isArray((stateStore as { pending?: unknown[] }).pending)
        ? (stateStore as { pending: unknown[] }).pending : []
    const characterStates = candidates.flatMap(candidate => {
      if (!candidate || typeof candidate !== 'object') return []
      const value = candidate as Record<string, unknown>
      const characterId = typeof value.characterId === 'string' ? value.characterId : ''
      if (!characterId) return []
      return [{ characterId, state: { field: value.field, value: value.value, chapterNumber: (value.source as { chapterNumber?: number } | undefined)?.chapterNumber } }]
    })
    const foreshadowing = database.prepare(`SELECT p.title,c.event_type AS status,c.evidence
      FROM narrative_thread_confirmations c JOIN narrative_thread_plans p ON p.id=c.plan_id
      WHERE c.draft_id=? ORDER BY c.id`).all(draftId) as Array<{ title: string; status: string; evidence: string }>
    const blueprint = database.prepare('SELECT foreshadowing FROM blueprints WHERE chapter_number=?').get(chapterNumber) as { foreshadowing: string } | undefined
    if (foreshadowing.length === 0 && blueprint?.foreshadowing?.trim()) {
      foreshadowing.push({ title: blueprint.foreshadowing.trim(), status: 'planned', evidence: '' })
    }
    const quality = this.getQualityReview(draftId, database)
    const input = validateChapterCommitInput({
      chapterNumber, draftId, finalizationId: finalization.finalization_id, contentHash: finalization.content_hash,
      facts, characterStates, foreshadowing,
      quality: { weightedScore: quality?.weightedScore ?? 0, blockingCount: quality?.blockingCount ?? 0 },
    })
    const commitId = `chapter-commit:${input.finalizationId}`
    database.prepare(`INSERT INTO chapter_commits(
      commit_id,chapter_number,draft_id,finalization_id,content_hash,facts_json,character_states_json,
      foreshadowing_json,quality_json,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(finalization_id) DO UPDATE SET facts_json=excluded.facts_json,
      character_states_json=excluded.character_states_json,foreshadowing_json=excluded.foreshadowing_json,
      quality_json=excluded.quality_json`).run(commitId, input.chapterNumber, input.draftId, input.finalizationId,
        input.contentHash, json(input.facts), json(input.characterStates), json(input.foreshadowing), json(input.quality))
    return this.getChapterCommit(chapterNumber, database)!
  }

  static rebuildChapterCommit(chapterNumber: number, db?: Database.Database): ChapterCommit {
    const database = requireDb(db)
    const latest = database.prepare(`SELECT f.draft_id FROM finalization_outbox f JOIN drafts d ON d.id=f.draft_id
      WHERE f.chapter_number=? AND d.status='finalized' ORDER BY f.created_at DESC,f.rowid DESC LIMIT 1`).get(chapterNumber) as { draft_id: number } | undefined
    if (!latest) throw new Error('CHAPTER_COMMIT_FINALIZED_SOURCE_REQUIRED')
    return this.commitFinalizedChapter(chapterNumber, latest.draft_id, database)
  }

  private static rowToCommit(row: Record<string, unknown>): ChapterCommit {
    return {
      commitId: String(row.commit_id ?? ''),
      chapterNumber: Number(row.chapter_number),
      draftId: Number(row.draft_id),
      finalizationId: String(row.finalization_id ?? ''),
      contentHash: String(row.content_hash ?? ''),
      facts: parseJson(String(row.facts_json ?? '[]'), []),
      characterStates: parseJson(String(row.character_states_json ?? '[]'), []),
      foreshadowing: parseJson(String(row.foreshadowing_json ?? '[]'), []),
      quality: parseJson(String(row.quality_json ?? '{}'), { weightedScore: 0, blockingCount: 0 }),
      createdAt: String(row.created_at ?? ''),
    }
  }
}