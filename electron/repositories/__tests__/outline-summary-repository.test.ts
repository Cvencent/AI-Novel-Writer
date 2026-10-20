import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { OutlineSummaryRepository } from '../outline-summary-repository'

let projectRoot = ''

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-outline-summary-'))
  openCanonicalProjectFixture(projectRoot)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

describe('OutlineSummaryRepository', () => {
  it('保存并读回某章摘要', () => {
    OutlineSummaryRepository.save({
      chapterNumber: 12, chapterNotes: '主角找到账册。', characterStates: '{}', continuityFacts: ['账册暴露了路线'],
    })
    expect(OutlineSummaryRepository.get(12)).toMatchObject({
      chapterNumber: 12, chapterNotes: '主角找到账册。', continuityFacts: ['账册暴露了路线'],
    })
  })

  it('同章重复保存只保留最新一条大纲层记录', () => {
    OutlineSummaryRepository.save({ chapterNumber: 5, chapterNotes: '旧', characterStates: '', continuityFacts: [] })
    OutlineSummaryRepository.save({ chapterNumber: 5, chapterNotes: '新', characterStates: '', continuityFacts: [] })
    expect(OutlineSummaryRepository.get(5)?.chapterNotes).toBe('新')
    expect(OutlineSummaryRepository.count()).toBe(1)
  })

  it('listBefore 只返回该章之前的有界条数且按章号升序', () => {
    for (const chapter of [1, 2, 3, 4, 5]) {
      OutlineSummaryRepository.save({ chapterNumber: chapter, chapterNotes: 'c' + chapter, characterStates: '', continuityFacts: [] })
    }
    const recent = OutlineSummaryRepository.listBefore(4, 3)
    expect(recent.map(item => item.chapterNumber)).toEqual([2, 3, 4])
  })

  it('不读取定稿层（draft_id 非空）的摘要', () => {
    const db = getProjectDb()!
    const draft = db.prepare(`INSERT INTO contents (body) VALUES ('定稿正文')`).run()
    const draftRow = db.prepare(`INSERT INTO drafts (chapter_number, version, content_id, word_count, status)
      VALUES (7, 1, ?, 4, 'finalized')`).run(draft.lastInsertRowid)
    db.prepare(`INSERT INTO summary_snapshots (draft_id, chapter_number, chapter_notes)
      VALUES (?, 7, '定稿层摘要')`).run(draftRow.lastInsertRowid)
    expect(OutlineSummaryRepository.count()).toBe(0)
    expect(OutlineSummaryRepository.get(7)).toBeNull()
  })
})
