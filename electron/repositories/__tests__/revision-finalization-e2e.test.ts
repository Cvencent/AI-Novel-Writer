import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { getDesktopMigrationRegistry } from '../../migrations/desktop-registry'
import { migrateSchema } from '../../migrations/runner'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { getProjectDb } from '../../database'
import { FinalizationRepository } from '../finalization-repository'
import { WritingIntelligenceRepository } from '../writing-intelligence-repository'
import { RevisionRepository } from '../revision-repository'

vi.mock('../../database', () => ({
  getProjectDb: vi.fn(),
  getCurrentProjectPath: vi.fn(() => null),
}))

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

let db: InstanceType<typeof Database>

/**
 * 端到端回归（issue #234 前置 1）：「修稿 → 应用为新版本 → 定稿 → 三表同步」这条
 * 写入链路此前**没有任何测试**——#137 评论区确认过「贸然接自动定稿会打断 sim」。
 * 本文件把链路本身钉住：无论后续选口径 A（采纳即定稿）还是 B（进审稿流），
 * 「落库三表与既有定稿路径一致」都是硬约束；语义决策（自动/手动）不在这层。
 *
 * schema 用真实 baseline + 桌面迁移（不是手写最小集）——手写集会漏列
 * （content_revision、character_states_json 等），而且漏了不会红。
 */

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.transaction(() => initializeLegacyBaselineSchema(db))()
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry())
  vi.mocked(getProjectDb).mockReturnValue(db)
})

afterEach(() => {
  db.close()
  vi.resetAllMocks()
})

function hash(value: string): string {
  return require('node:crypto').createHash('sha256').update(value, 'utf8').digest('hex')
}

/** 既有定稿路径的最小重现（finalization-service 同形输入）。commit 内部置 finalized。 */
function commitFinalizedDraft(draftId: number, chapterNumber: number, body: string, revision: number): string {
  const finalizationId = `finalization-${draftId}-${revision}`
  FinalizationRepository.commit({
    finalizationId, draftId, chapterNumber,
    chapterTitle: `第${chapterNumber}章`,
    content: body,
    contentHash: hash(body),
    contentRevision: revision,
    targetFileName: `第${chapterNumber}章.txt`,
  })
  return finalizationId
}

describe('e2e: 修稿 → 应用为新版本 → 定稿 → 三表同步 (issue #234 前置回归)', () => {
  it('walks the full chain: finalized v1 → revision → applyAsNewVersion → finalize v2 → three tables agree', () => {
    // 1) v1 插入为 draft 状态（FinalizationRepository.commit 内部置 finalized），走既有路径定稿
    const v1Body = '第一章的定稿正文。'
    const v1ContentId = Number(db.prepare('INSERT INTO contents(body) VALUES(?)').run(v1Body).lastInsertRowid)
    const v1Id = Number(db.prepare(`INSERT INTO drafts(chapter_number, version, status, content_id, word_count)
      VALUES(3, 1, 'draft', ?, ?)`).run(v1ContentId, v1Body.length).lastInsertRowid)
    commitFinalizedDraft(v1Id, 3, v1Body, 1)
    expect(db.prepare('SELECT status FROM drafts WHERE id=?').get(v1Id)).toEqual({ status: 'finalized' })

    // 2) 修稿挂在该章上（pending）——expectedSource 与 v1 定稿态一致
    const revBody = '修稿后的新正文，作者在差异面板采纳过的。'
    const revision = RevisionRepository.replacePending({
      baseDraftId: v1Id, revisionType: 'refine', content: revBody, wordCount: revBody.length,
      expectedSource: { id: v1Id, chapterNumber: 3, version: 1, status: 'finalized', content: v1Body },
    }, db)

    // 3) 应用为新版本（不触发定稿——现状语义钉住）
    const applied = RevisionRepository.applyAsNewVersion(revision.id, db)
    expect(applied.version).toBe(2)
    const newDraft = db.prepare(`SELECT d.status AS status, d.chapter_number AS chapterNumber,
      c.body AS body FROM drafts d JOIN contents c ON c.id = d.content_id WHERE d.id = ?`)
      .get(applied.draftId) as { status: string; chapterNumber: number; body: string }
    expect(newDraft.status).toBe('draft')
    expect(newDraft.body).toBe(revBody)
    // v2 定稿前：outbox 仍只有 v1 那一条（applyAsNewVersion 不触发后处理）
    expect(db.prepare('SELECT COUNT(*) AS count FROM finalization_outbox').get()).toEqual({ count: 1 })

    // 4) v2 走既有定稿路径（口径 A 在这里自动发生；口径 B 由作者触发——三表一致是共同硬约束）
    const finalizationId = commitFinalizedDraft(applied.draftId, 3, revBody, 2)
    expect(db.prepare('SELECT status FROM drafts WHERE id=?').get(applied.draftId)).toEqual({ status: 'finalized' })

    // 5) 三表同步（模拟定稿后处理的取数）：outbox 指向 v2；
    //    summary_snapshots 由后处理【章节剧情要点】步骤写（saveFinalizedContinuity）；
    //    chapter_commits 由 WritingIntelligenceRepository.commitFinalizedChapter 从 outbox+snapshots 汇总。
    db.prepare(`INSERT INTO summary_snapshots (draft_id, chapter_number, chapter_notes, continuity_facts,
      character_state_candidates, source_finalization_id, source_content_hash, projection_generation)
      VALUES (?, 3, 'v2 笔记', '[]', '[]', ?, ?, 1)`).run(applied.draftId, finalizationId, hash(revBody))
    WritingIntelligenceRepository.commitFinalizedChapter(3, applied.draftId, db)
    const outbox = db.prepare('SELECT finalization_id, chapter_number, content_hash FROM finalization_outbox WHERE draft_id=?')
      .get(applied.draftId) as { finalization_id: string; chapter_number: number; content_hash: string }
    expect(outbox.finalization_id).toBe(finalizationId)
    const snapshot = db.prepare('SELECT source_finalization_id FROM summary_snapshots WHERE draft_id=?')
      .get(applied.draftId) as { source_finalization_id: string } | undefined
    expect(snapshot?.source_finalization_id).toBe(finalizationId)
    const commit = db.prepare('SELECT finalization_id, draft_id, content_hash FROM chapter_commits WHERE chapter_number=3 ORDER BY rowid DESC LIMIT 1')
      .get() as { finalization_id: string; draft_id: number; content_hash: string }
    expect(commit.finalization_id).toBe(finalizationId)
    expect(commit.draft_id).toBe(applied.draftId)
    expect(outbox.content_hash).toBe(hash(revBody))
    expect(commit.content_hash).toBe(hash(revBody))
    // 旧版本 v1 的 outbox 行仍在（历史可回溯）
    expect(db.prepare('SELECT COUNT(*) AS count FROM finalization_outbox').get()).toEqual({ count: 2 })
  })

  it('keeps FinalizationRepository idempotency: same frozen snapshot replays, a different one is refused', () => {
    const body = '唯一的定稿正文。'
    const contentId = Number(db.prepare('INSERT INTO contents(body) VALUES(?)').run(body).lastInsertRowid)
    const draftId = Number(db.prepare(`INSERT INTO drafts(chapter_number, version, status, content_id, word_count)
      VALUES(2, 1, 'draft', ?, ?)`).run(contentId, body.length).lastInsertRowid)
    const first = commitFinalizedDraft(draftId, 2, body, 8)
    expect(db.prepare('SELECT status FROM drafts WHERE id=?').get(draftId)).toEqual({ status: 'finalized' })

    // 同冻结快照重发 → 返回原提交（幂等）
    const replay = FinalizationRepository.commit({
      finalizationId: 'finalization-replay', draftId, chapterNumber: 2,
      chapterTitle: '第2章', content: body, contentHash: hash(body),
      contentRevision: 8, targetFileName: '第2章.txt',
    })
    expect(replay.finalizationId).toBe(first)
    expect(db.prepare('SELECT COUNT(*) AS count FROM finalization_outbox').get()).toEqual({ count: 1 })

    // 不同快照 → 拒绝覆盖
    expect(() => commitFinalizedDraft(draftId, 2, '另一份不同的正文。', 9)).toThrow(/不可替换的定稿提交/)
  })
})
