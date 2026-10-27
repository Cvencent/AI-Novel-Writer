import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { WritingIntelligenceRepository } from '../writing-intelligence-repository'
import { parseEditorialPanelResponse, parseVoiceProfilesResponse } from '../../../src/shared/writing-intelligence'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

function fixture() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.transaction(() => initializeLegacyBaselineSchema(db))()
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry())
  db.prepare("INSERT INTO characters(character_id,name,role) VALUES('char-1','林岚','protagonist')").run()
  const contentId = Number(db.prepare("INSERT INTO contents(body) VALUES('林岚进入库房。')").run().lastInsertRowid)
  const draftId = Number(db.prepare("INSERT INTO drafts(chapter_number,version,status,content_id) VALUES(3,1,'finalized',?)").run(contentId).lastInsertRowid)
  db.prepare(`INSERT INTO blueprints(chapter_number,title,role,purpose,key_events,characters,suspense_hook,user_guidance,notes)
    VALUES(3,'库房','发展','拿到账册','林岚进入库房','["林岚"]','门锁上了','','')`).run()
  db.prepare(`INSERT INTO finalization_outbox(finalization_id,draft_id,chapter_number,chapter_title,content_hash,
    content_revision,content_snapshot,target_file_name,publication_status) VALUES('fin-3',?,3,'库房',?,1,?,'chapter3.md','published')`)
    .run(draftId, 'a'.repeat(64), '林岚进入库房。')
  return { db, draftId }
}

const panelJson = JSON.stringify({ summary: '可发布', roles: [
  { role: 'plot', score: 82, summary: '主线清楚', findings: [] },
  { role: 'continuity', score: 78, summary: '一致', findings: [] },
  { role: 'character', score: 86, summary: '动机成立', findings: [] },
  { role: 'style', score: 74, summary: '可再收紧', findings: [{ severity: 'warning', description: '重复词偏多' }] },
  { role: 'pacing', score: 80, summary: '节奏正常', findings: [] },
] })

describe('writing intelligence repository', () => {
  it('stores scene cards, quality scores, voice profiles, and one immutable chapter commit', () => {
    const { db, draftId } = fixture()
    try {
      const scenes = WritingIntelligenceRepository.saveScenes(3, [{
        id: 'scene-1', title: '进场', goal: '找账册', conflict: '门锁住', turn: '备用钥匙出现',
        outcome: '进入库房', characters: ['林岚'], targetWords: 700, notes: '',
      }], db)
      expect(WritingIntelligenceRepository.getScenes(3, db)).toEqual(scenes)

      const panel = parseEditorialPanelResponse(panelJson)
      const quality = WritingIntelligenceRepository.saveQualityReview({ draftId, chapterNumber: 3, contentHash: 'a'.repeat(64), panel }, db)
      expect(quality.weightedScore).toBe(panel.weightedScore)
      expect(WritingIntelligenceRepository.listQualityReviews(3, db)).toHaveLength(1)

      const voices = parseVoiceProfilesResponse(JSON.stringify({ profiles: [{
        characterId: 'char-1', characterName: '林岚', summary: '克制', sentenceStyle: '短句', vocabulary: '少形容词',
        dialogueHabits: ['反问'], emotionalTells: '整理袖口', avoid: ['独白'], evidence: ['林岚进入库房。'],
      }] }), [{ characterId: 'char-1', name: '林岚' }], '林岚进入库房。')
      WritingIntelligenceRepository.saveVoiceProfiles(draftId, 'a'.repeat(64),
        voices.map(profile => ({ ...profile, sourceDraftId: draftId, contentHash: 'a'.repeat(64), updatedAt: '' })), db)
      expect(WritingIntelligenceRepository.getVoiceProfile('char-1', db)).toMatchObject({ characterName: '林岚', summary: '克制' })

      db.prepare(`INSERT INTO summary_snapshots(draft_id,chapter_number,chapter_notes,continuity_facts,
        character_state_candidates,source_finalization_id,source_content_hash)
        VALUES(?,3,'林岚拿到账册',?,?,?,?)`).run(draftId,
        JSON.stringify([{ category: 'plot', entities: ['林岚'], statement: '林岚拿到账册', evidence: '林岚进入库房。' }]),
        JSON.stringify({ pending: [{ characterId: 'char-1', field: 'location', value: '库房', source: { chapterNumber: 3 } }], receipts: [] }),
        'fin-3', 'a'.repeat(64))
      const planId = Number(db.prepare(`INSERT INTO narrative_thread_plans(title,type,target_start_chapter,target_end_chapter,author_intent)
        VALUES('缺页账册','伏笔',3,8,'后文回收')`).run().lastInsertRowid)
      db.prepare(`INSERT INTO narrative_thread_confirmations(plan_id,draft_id,event_type,evidence)
        VALUES(?,?,'planted','林岚进入库房。')`).run(planId, draftId)

      const commit = WritingIntelligenceRepository.commitFinalizedChapter(3, draftId, db)
      expect(commit).toMatchObject({ chapterNumber: 3, draftId, finalizationId: 'fin-3', contentHash: 'a'.repeat(64) })
      expect(commit.facts).toEqual([{ kind: 'plot', statement: '林岚拿到账册', evidence: '林岚进入库房。' }])
      expect(commit.characterStates).toEqual([{ characterId: 'char-1', state: { field: 'location', value: '库房', chapterNumber: 3 } }])
      expect(commit.foreshadowing).toEqual([{ title: '缺页账册', status: 'planted', evidence: '林岚进入库房。' }])
      expect(commit.quality.weightedScore).toBe(panel.weightedScore)
      expect(WritingIntelligenceRepository.rebuildChapterCommit(3, db).commitId).toBe(commit.commitId)
    } finally { db.close() }
  })
})