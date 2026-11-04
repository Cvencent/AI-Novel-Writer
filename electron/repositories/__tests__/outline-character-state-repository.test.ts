import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase } from '../../database'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { getProjectDb } from '../../database'
import { OutlineCharacterStateRepository } from '../outline-character-state-repository'
import { CharacterRosterRepository, refreshCharacterIdentityProjection } from '../character-roster-repository'

let projectRoot = ''

/** 给某一章放一份已定稿草稿（issue #130 之后，正史只由已定稿正文推进）。 */
function finalizeChapter(chapterNumber: number): void {
  const db = getProjectDb()!
  const contentId = Number(db.prepare('INSERT INTO contents(body) VALUES(?)').run(`第${chapterNumber}章正文。`).lastInsertRowid)
  db.prepare(`INSERT INTO drafts(chapter_number,version,status,content_id) VALUES(?,1,'finalized',?)`)
    .run(chapterNumber, contentId)
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-char-state-'))
  openCanonicalProjectFixture(projectRoot)
  const db = getProjectDb()!
  db.prepare(`INSERT INTO characters (character_id, name, role) VALUES ('char-lead', '主角', 'protagonist')`).run()
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

describe('OutlineCharacterStateRepository', () => {
  it('推进已存在角色的最近事件与章节号', () => {
    finalizeChapter(12)
    expect(OutlineCharacterStateRepository.apply({ characterName: '主角', chapterNumber: 12, recentEvents: '找回账册' })).toBe(true)
    expect(OutlineCharacterStateRepository.read('主角')).toMatchObject({ recentEvents: '找回账册', updatedAtChapter: 12 })
  })


  /**
   * issue #130：细纲跑得比正文快时，角色状态被推进到「还没写的章」。
   * 实测那本书细纲到 26、蓝图 25、草稿 25、**已定稿只到 24**，而
   * 周叙/邵德昌 的 `cs_updated_at_chapter=26`，`cs_recent_events` 写的是
   * 第 26 章才要发生的事。角色面板与 Agent 读取看到的都是「未来」。
   */
  it('不把还没定稿那一章的细纲摘要写进正史（章号也不推进）', () => {
    const db = getProjectDb()!
    finalizeChapter(24)
    expect(OutlineCharacterStateRepository.apply({ characterName: '主角', chapterNumber: 24, recentEvents: '第二十四章确实发生的事' }, db)).toBe(true)
    // 第 26 章的细纲：正文只定稿到 24，这一章还没发生。
    expect(OutlineCharacterStateRepository.apply({ characterName: '主角', chapterNumber: 26, recentEvents: '第二十六章才要发生的事' }, db)).toBe(false)
    const row = db.prepare("SELECT cs_updated_at_chapter AS ch, cs_recent_events AS events FROM characters WHERE character_id='char-lead'")
      .get() as { ch: number; events: string }
    expect(row.ch).toBe(24)
    expect(row.events).toBe('第二十四章确实发生的事')
  })

  it('已定稿章的细纲摘要可以进正史（真实发生的章不能被一刀切掉）', () => {
    const db = getProjectDb()!
    finalizeChapter(25)
    expect(OutlineCharacterStateRepository.apply({ characterName: '主角', chapterNumber: 25, recentEvents: '第二十五章发生的事' }, db)).toBe(true)
    expect(OutlineCharacterStateRepository.read('主角', db)).toMatchObject({ recentEvents: '第二十五章发生的事', updatedAtChapter: 25 })
  })

  it('正文派生过的状态不被细纲摘要覆盖（重跑旧章细纲时）', () => {
    const db = getProjectDb()!
    finalizeChapter(30)
    db.prepare(`UPDATE characters SET cs_recent_events=?, cs_provenance=? WHERE character_id='char-lead'`).run(
      '正文证明过的事实',
      JSON.stringify({ recentEvents: { kind: 'derived', source: {
        draftId: 1, finalizationId: 'f'.repeat(64), chapterNumber: 30, contentHash: 'a'.repeat(64) } } }),
    )
    expect(OutlineCharacterStateRepository.apply({ characterName: '主角', chapterNumber: 30, recentEvents: '细纲的计划摘要' }, db)).toBe(false)
    expect(OutlineCharacterStateRepository.read('主角', db)?.recentEvents).toBe('正文证明过的事实')
  })

  it('不新建不存在的角色', () => {
    expect(OutlineCharacterStateRepository.apply({ characterName: '陌生人', chapterNumber: 3, recentEvents: '出现' })).toBe(false)
    expect(OutlineCharacterStateRepository.read('陌生人')).toBeNull()
  })

  it('同章重复推进覆盖旧状态', () => {
    finalizeChapter(5)
    OutlineCharacterStateRepository.apply({ characterName: '主角', chapterNumber: 5, recentEvents: '旧事件' })
    OutlineCharacterStateRepository.apply({ characterName: '主角', chapterNumber: 5, recentEvents: '新事件' })
    expect(OutlineCharacterStateRepository.read('主角')?.recentEvents).toBe('新事件')
  })

  it('空字符串不覆盖已有的地点与物品', () => {
    finalizeChapter(1); finalizeChapter(2)
    OutlineCharacterStateRepository.apply({ characterName: '主角', chapterNumber: 1, recentEvents: 'a', location: '学院', keyItems: '账册' })
    OutlineCharacterStateRepository.apply({ characterName: '主角', chapterNumber: 2, recentEvents: 'b' })
    const state = OutlineCharacterStateRepository.read('主角')!
    expect(state.location).toBe('学院')
    expect(state.keyItems).toBe('账册')
    expect(state.recentEvents).toBe('b')
  })

  it('推进动态状态后同步刷新角色名单事实哈希', () => {
    const db = getProjectDb()!
    db.prepare("INSERT INTO project_core(id,project_name,writing_language) VALUES('main','角色状态测试','zh-CN')").run()
    db.transaction(() => refreshCharacterIdentityProjection(db))()
    const before = CharacterRosterRepository.read(db)
    expect(before.status).toBe('ready')

    finalizeChapter(12)
    expect(OutlineCharacterStateRepository.apply({ characterName: '主角', chapterNumber: 12, recentEvents: '找回账册' }, db)).toBe(true)

    const after = CharacterRosterRepository.read(db)
    expect(after.status).toBe('ready')
    expect(after.revision).toBe(before.revision + 1)
    expect(after.factHash).not.toBe(before.factHash)
  })

  it('写入细纲摘要时摘掉被写字段的旧来源，避免摘要冒充作者事实', () => {
    const db = getProjectDb()!
    db.prepare(`UPDATE characters SET cs_recent_events=?, cs_provenance=? WHERE character_id='char-lead'`).run(
      '作者确认过的旧事件',
      JSON.stringify({
        recentEvents: { kind: 'author', chapterNumber: 1, revision: 1 },
        location: { kind: 'author', chapterNumber: 1, revision: 2 },
      }),
    )

    finalizeChapter(9)
    OutlineCharacterStateRepository.apply({ characterName: '主角', chapterNumber: 9, recentEvents: '本章计划摘要' }, db)

    const row = db.prepare("SELECT cs_recent_events AS recentEvents, cs_provenance AS provenance FROM characters WHERE character_id='char-lead'")
      .get() as { recentEvents: string; provenance: string }
    expect(row.recentEvents).toBe('本章计划摘要')
    const provenance = JSON.parse(row.provenance) as Record<string, unknown>
    expect(provenance.recentEvents).toBeUndefined()
    // 本次没写的字段，来源保持原样。
    expect(provenance.location).toMatchObject({ kind: 'author', chapterNumber: 1 })
  })
})
