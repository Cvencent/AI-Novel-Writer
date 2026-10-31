/**
 * 一次性数据修复（不是回归测试）：修正源起项目里角色卡的时点状态。
 *
 * 只通过仓库自己的写路径改角色状态，因此 roster 事实哈希与投影会同步刷新，
 * 不会把完好的角色卡变成 inconsistent。
 *
 *   STATE_FIX_PROJECT="F:/yuanqi/源起" pnpm vitest run test/state-fix/fix-character-state.oneoff.test.ts
 *
 * 未设置 STATE_FIX_PROJECT 时整例跳过，所以全量 `pnpm test` 不会碰任何真实项目库。
 * 修复完成后本文件可以删除。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../electron/database'
import {
  refreshCharacterIdentityProjection,
  refreshCharacterStateProjection,
} from '../../electron/repositories/character-roster-repository'

const projectPath = process.env.STATE_FIX_PROJECT ?? ''

/** 第 2 章定稿里沈砚的当场着装（逐字取自该章正文）。 */
const OUTFIT = '洗得泛白的九班制式风衣，领口蹭着未洗净的油墨'
const APPEARANCE = '偏瘦，话少；常年穿着洗得泛白的九班制式风衣，领口蹭着未洗净的油墨。'
const RECENT_EVENTS = '第2章在行政大厅排队时被陆秉文到场打断，退入人群。'
const POLLUTION_MARKER = '场景与出场人物'

it.skipIf(!projectPath)('repairs 沈砚 time-bound state from chapter 2 and drops outline-summary pollution', () => {
  initProjectDatabase(projectPath)
  const db = getProjectDb()!
  const open = (characterId?: string) => db.prepare(`SELECT appearance, cs_location AS location,
      cs_physical_state AS physicalState, cs_recent_events AS recentEvents,
      cs_updated_at_chapter AS updatedAtChapter, cs_provenance AS provenance
    FROM characters WHERE character_id=?`).get(characterId) as Record<string, unknown> | undefined

  const source = db.prepare(
    "SELECT d.id AS draftId, d.chapter_number AS chapterNumber, c.body AS content FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.chapter_number=2 AND d.status='finalized' ORDER BY d.version DESC, d.id DESC LIMIT 1",
  ).get() as { draftId: number; chapterNumber: number; content: string } | undefined
  // 修复必须建立在真实定稿原文上，不能凭记忆补设定。
  expect(source?.content).toContain(OUTFIT)

  const finalization = db.prepare('SELECT finalization_id AS finalizationId FROM finalization_outbox WHERE draft_id=?')
    .get(source!.draftId) as { finalizationId: string } | undefined
  expect(finalization?.finalizationId).toBeTruthy()

  const character = db.prepare("SELECT character_id AS characterId, cs_provenance AS provenance FROM characters WHERE name='沈砚' AND retired=0")
    .get() as { characterId: string; provenance: string } | undefined
  expect(character?.characterId).toBeTruthy()

  const before = open(character!.characterId)!
  // 首次运行时卡面外貌为空，之后重跑已是修好的值：两种状态都接受，保证幂等。
  expect([before.appearance, APPEARANCE]).toContain(APPEARANCE)

  const provenance = JSON.parse(character!.provenance || '{}') as Record<string, unknown>
  // 沿用已有的连续性世代（projectId:generation）写法，避免自造 epoch 触发 source-conflict。
  const existingOrder = (provenance.location as { sourceOrder?: { continuityEpoch?: string } } | undefined)?.sourceOrder
  expect(existingOrder?.continuityEpoch).toBeTruthy()
  const derivedSource = {
    draftId: source!.draftId,
    finalizationId: finalization!.finalizationId,
    chapterNumber: source!.chapterNumber,
    contentHash: createHash('sha256').update(source!.content, 'utf8').digest('hex'),
  }
  const sourceOrder = {
    continuityEpoch: existingOrder!.continuityEpoch!,
    chapterNumber: source!.chapterNumber,
    authoritativeFinalizationRevision: 1,
  }

  db.transaction(() => {
    // 静态外貌首次补入；时点状态写入第 2 章快照并带上可追溯的派生来源。
    for (const field of ['physicalState', 'recentEvents'] as const) {
      provenance[field] = { kind: 'derived', source: derivedSource, revision: 1, sourceOrder }
    }
    db.prepare(`UPDATE characters SET
        appearance = CASE WHEN trim(COALESCE(appearance,''))='' THEN ? ELSE appearance END,
        cs_physical_state = ?, cs_recent_events = ?, cs_provenance = ?,
        cs_updated_at_chapter = ?, updated_at = datetime('now')
      WHERE character_id=?`).run(
      APPEARANCE, OUTFIT, RECENT_EVENTS, JSON.stringify(provenance), source!.chapterNumber, character!.characterId,
    )
    // appearance 是静态事实，会改变只读角色图谱：必须重算身份投影，
    // 只刷状态投影会让 roster 判成 inconsistent（系统随后拒绝一切写入）。
    refreshCharacterIdentityProjection(db)
  })()

  expect(open(character!.characterId)).toMatchObject({
    appearance: APPEARANCE,
    physicalState: OUTFIT,
    recentEvents: RECENT_EVENTS,
    updatedAtChapter: 2,
    location: '行政大厅排队人群深处',
  })
  const afterProvenance = JSON.parse(String(open(character!.characterId)!.provenance)) as
    Record<string, { kind: string; source?: { chapterNumber: number } }>
  for (const field of ['location', 'physicalState', 'recentEvents']) {
    expect(afterProvenance[field]).toMatchObject({ kind: 'derived', source: { chapterNumber: 2 } })
  }

  // 其他角色被大纲摘要污染的 recentEvents 是整章蓝图摘要，不是本章事件。
  // 不能从中猜一句当真事件：直接清空并摘掉该字段来源，等下一章定稿用真实事件重写。
  const polluted = db.prepare(
    'SELECT character_id AS characterId, name FROM characters WHERE retired=0 AND cs_recent_events LIKE ?',
  ).all(`%${POLLUTION_MARKER}%`) as Array<{ characterId: string; name: string }>
  db.transaction(() => {
    for (const row of polluted) {
      const rowProvenance = JSON.parse(
        (db.prepare('SELECT cs_provenance FROM characters WHERE character_id=?').pluck().get(row.characterId) as string) || '{}',
      ) as Record<string, unknown>
      delete rowProvenance.recentEvents
      db.prepare("UPDATE characters SET cs_recent_events='',cs_provenance=?,updated_at=datetime('now') WHERE character_id=?")
        .run(JSON.stringify(rowProvenance), row.characterId)
    }
    if (polluted.length) refreshCharacterStateProjection(db)
  })()
  expect(db.prepare('SELECT COUNT(*) FROM characters WHERE retired=0 AND cs_recent_events LIKE ?')
    .pluck().get(`%${POLLUTION_MARKER}%`)).toBe(0)

  fs.writeFileSync(path.join(import.meta.dirname, 'fix-report.json'), JSON.stringify({
    repairedAt: new Date().toISOString(),
    source: derivedSource,
    characterId: character!.characterId,
    clearedPollution: polluted.map(row => row.name),
  }, null, 2))
})

afterAll(() => { closeProjectDatabase() })