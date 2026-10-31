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
    expect(OutlineCharacterStateRepository.apply({ characterName: '主角', chapterNumber: 12, recentEvents: '找回账册' })).toBe(true)
    expect(OutlineCharacterStateRepository.read('主角')).toMatchObject({ recentEvents: '找回账册', updatedAtChapter: 12 })
  })

  it('不新建不存在的角色', () => {
    expect(OutlineCharacterStateRepository.apply({ characterName: '陌生人', chapterNumber: 3, recentEvents: '出现' })).toBe(false)
    expect(OutlineCharacterStateRepository.read('陌生人')).toBeNull()
  })

  it('同章重复推进覆盖旧状态', () => {
    OutlineCharacterStateRepository.apply({ characterName: '主角', chapterNumber: 5, recentEvents: '旧事件' })
    OutlineCharacterStateRepository.apply({ characterName: '主角', chapterNumber: 5, recentEvents: '新事件' })
    expect(OutlineCharacterStateRepository.read('主角')?.recentEvents).toBe('新事件')
  })

  it('空字符串不覆盖已有的地点与物品', () => {
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
