import { createHash } from 'node:crypto'

import { getProjectDb } from '../database'
import { NarrativeThreadRepository } from './narrative-thread-repository'
import {
  assertPlotTreeSnapshot,
  assertStoredPlotTreeSnapshot,
  type PlotTreeSnapshot,
  type PlotTreeSourceBundle,
} from '../../src/shared/plot-tree'
import { resolveWritingLanguage } from '../../src/shared/writing-language'

function requireDb(): NonNullable<ReturnType<typeof getProjectDb>> {
  const db = getProjectDb()
  if (!db) throw new Error('项目数据库未打开')
  return db
}

function sourceRevision(
  sources: Omit<PlotTreeSourceBundle, 'sourceRevision' | 'snapshot'>,
): string {
  return createHash('sha256').update(JSON.stringify(sources)).digest('hex')
}

export class PlotTreeRepository {
  static read(db = requireDb()): PlotTreeSourceBundle {
    const core = db.prepare(`
      SELECT writing_language, synopsis, plot_tree_snapshot
      FROM project_core WHERE id = 'main'
    `).get() as {
      writing_language: string
      synopsis: string
      plot_tree_snapshot: string
    } | undefined
    if (!core) throw new Error('项目配置不存在')

    const blueprintRows = db.prepare(`
      SELECT chapter_number, title, purpose, key_events
      FROM blueprints ORDER BY chapter_number ASC
    `).all() as Array<{
      chapter_number: number
      title: string
      purpose: string
      key_events: string
    }>
    const finalizedRows = db.prepare(`
      SELECT drafts.id AS draft_id,
             drafts.chapter_number,
             COALESCE(finalization_outbox.chapter_title, blueprints.title, '') AS title,
             COALESCE(
               NULLIF(summary_snapshots.chapter_notes, ''),
               CASE WHEN TRIM(COALESCE(blueprints.notes_updated_at, '')) <> ''
                 THEN blueprints.notes ELSE '' END
             ) AS summary,
             -- 章节要点缺失时的兜底（issue #60）：定稿正文才是「已经写过的情节」的权威。
             -- 原来这三处都没有正文兜底，于是没有 summary_snapshots 行的章（实测第 2/6/10/14/16 章）
             -- 在模型眼里只剩蓝图文本，树就把它们全标成 planned——已经写过的章在故事线视图里说谎。
             -- 只截前 400 字：它的用途是「让模型知道这些章真有正文」，不是替代要点。
             COALESCE((SELECT substr(contents.body, 1, 400) FROM contents WHERE contents.id = drafts.content_id), '') AS body_excerpt
      FROM drafts
      LEFT JOIN finalization_outbox ON finalization_outbox.draft_id = drafts.id
      LEFT JOIN summary_snapshots ON summary_snapshots.draft_id = drafts.id
      LEFT JOIN blueprints ON blueprints.chapter_number = drafts.chapter_number
      WHERE drafts.status = 'finalized'
        AND NOT EXISTS (
          SELECT 1 FROM drafts newer
          WHERE newer.chapter_number = drafts.chapter_number
            AND newer.status = 'finalized'
            AND (newer.version > drafts.version
              OR (newer.version = drafts.version AND newer.id > drafts.id))
        )
      ORDER BY drafts.chapter_number ASC
    `).all() as Array<{
      draft_id: number
      chapter_number: number
      title: string
      summary: string
      body_excerpt: string
    }>
    const narrativeThreads = NarrativeThreadRepository.list(db).map(thread => ({
      id: thread.id,
      title: thread.title,
      type: thread.type,
      targetStartChapter: thread.targetStartChapter,
      targetEndChapter: thread.targetEndChapter,
      authorIntent: thread.authorIntent,
      status: thread.status,
      events: thread.events.map(event => ({
        id: event.id,
        chapterNumber: event.chapterNumber,
        type: event.type,
        evidence: event.evidence,
        reason: event.reason,
      })),
    }))
    const blueprints = blueprintRows.map(row => ({
      chapterNumber: row.chapter_number,
      title: row.title,
      purpose: row.purpose,
      keyEvents: row.key_events,
    }))
    const finalizedChapters = finalizedRows.map(row => ({
      draftId: row.draft_id,
      chapterNumber: row.chapter_number,
      title: row.title,
      // 要点缺失时用定稿正文兜底（issue #60），而不是留空让调用方退回蓝图。
      summary: row.summary.trim() ? row.summary : row.body_excerpt,
    }))
    const facts = {
      writingLanguage: resolveWritingLanguage(core.writing_language),
      synopsis: {
        content: core.synopsis,
      },
      blueprints,
      finalizedChapters,
      narrativeThreads,
    }
    const bundle: PlotTreeSourceBundle = {
      ...facts,
      sourceRevision: sourceRevision(facts),
      snapshot: null,
    }
    if (core.plot_tree_snapshot) {
      try {
        bundle.snapshot = assertStoredPlotTreeSnapshot(JSON.parse(core.plot_tree_snapshot))
      } catch {
        bundle.snapshot = null
        bundle.storedSnapshotInvalid = true
      }
    }
    return bundle
  }

  static save(snapshot: PlotTreeSnapshot, expectedSourceRevision: string, db = requireDb()): PlotTreeSnapshot {
    const sources = this.read(db)
    if (sources.sourceRevision !== expectedSourceRevision) {
      throw new Error('剧情资料在生成期间已更新')
    }
    const validated = assertPlotTreeSnapshot(snapshot, sources)
    const result = db.prepare(`
      UPDATE project_core SET plot_tree_snapshot = ? WHERE id = 'main'
    `).run(JSON.stringify(validated))
    if (result.changes !== 1) throw new Error('剧情树快照保存失败')
    return validated
  }

  static clear(db = requireDb()): void {
    const result = db.prepare(`
      UPDATE project_core SET plot_tree_snapshot = '' WHERE id = 'main'
    `).run()
    if (result.changes !== 1) throw new Error('剧情树快照清除失败')
  }
}
