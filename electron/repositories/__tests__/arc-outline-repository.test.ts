import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase } from '../../database'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { ArcOutlineRepository, type ArcBeat } from '../arc-outline-repository'

let projectRoot = ''

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-arc-'))
  openCanonicalProjectFixture(projectRoot)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

const arc = (arcIndex: number, fromChapter: number, toChapter: number, beat: ArcBeat = 'setup') => ({
  arcIndex, fromChapter, toChapter, title: `第${arcIndex}段`, summary: `第${arcIndex}段走向`, beat,
})

describe('ArcOutlineRepository', () => {
  it('保存并按 arcIndex 列出粗纲段', () => {
    ArcOutlineRepository.save(arc(1, 1, 30))
    ArcOutlineRepository.save(arc(2, 31, 60, 'escalation'))
    const list = ArcOutlineRepository.list()
    expect(list.map(item => item.arcIndex)).toEqual([1, 2])
    expect(list[0]).toMatchObject({ fromChapter: 1, toChapter: 30, status: 'draft', revision: 0 })
  })

  it('拒绝与已有段重叠的区间', () => {
    ArcOutlineRepository.save(arc(1, 1, 30))
    expect(() => ArcOutlineRepository.save(arc(2, 20, 50))).toThrow('ARC_OUTLINE_RANGE_OVERLAP')
  })

  it('拒绝不连续的区间', () => {
    ArcOutlineRepository.save(arc(1, 1, 30))
    expect(() => ArcOutlineRepository.save(arc(2, 40, 60))).toThrow('ARC_OUTLINE_RANGE_GAP')
  })

  it('首段必须从第 1 章开始', () => {
    expect(() => ArcOutlineRepository.save(arc(1, 5, 30))).toThrow('ARC_OUTLINE_RANGE_GAP')
  })

  it('confirm 使 revision+1 且 status=confirmed', () => {
    const saved = ArcOutlineRepository.save(arc(1, 1, 30))
    const confirmed = ArcOutlineRepository.confirm(1, saved.revision)
    expect(confirmed).toMatchObject({ status: 'confirmed', revision: saved.revision + 1 })
  })

  it('confirm 时 expectedRevision 不匹配抛 ARC_OUTLINE_REVISION_STALE', () => {
    ArcOutlineRepository.save(arc(1, 1, 30))
    expect(() => ArcOutlineRepository.confirm(1, 99)).toThrow('ARC_OUTLINE_REVISION_STALE')
  })

  it('removeFrom 删除该段及之后的所有段', () => {
    ArcOutlineRepository.save(arc(1, 1, 30))
    ArcOutlineRepository.save(arc(2, 31, 60, 'escalation'))
    ArcOutlineRepository.save(arc(3, 61, 90, 'reversal'))
    expect(ArcOutlineRepository.removeFrom(2)).toBe(2)
    expect(ArcOutlineRepository.list().map(item => item.arcIndex)).toEqual([1])
  })
})

describe('ArcOutlineRepository.saveDocument', () => {
  it('round-trips an edited arc document without changing ranges', () => {
    ArcOutlineRepository.save(arc(1, 1, 30))
    ArcOutlineRepository.save(arc(2, 31, 60, 'escalation'))
    const markdown = [
      '## 第 1–30 章：改过的标题',
      'beat: setup · 状态: confirmed',
      '',
      '第一段改过的走向。',
      '',
      '## 第 31–60 章：第2段',
      'beat: escalation · 状态: draft',
      '',
      '第2段走向',
    ].join(String.fromCharCode(10))
    const records = ArcOutlineRepository.saveDocument(markdown)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ arcIndex: 1, fromChapter: 1, toChapter: 30, title: '改过的标题', revision: 1, status: 'draft' })
    expect(records[0]!.summary).toBe('第一段改过的走向。')
    // 第二段内容没变：不应被动过 revision
    expect(records[1]).toMatchObject({ arcIndex: 2, title: '第2段', revision: 0 })
  })

  it('refuses a document that adds, removes or re-ranges segments', () => {
    ArcOutlineRepository.save(arc(1, 1, 30))
    expect(() => ArcOutlineRepository.saveDocument('## 第 1–40 章：改区间' + String.fromCharCode(10) + String.fromCharCode(10) + '正文'))
      .toThrow('ARC_OUTLINE_STRUCTURE_CHANGED')
  })
})
