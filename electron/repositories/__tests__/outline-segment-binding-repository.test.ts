import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase } from '../../database'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { ArcOutlineRepository } from '../arc-outline-repository'
import { OutlineSegmentBindingRepository } from '../outline-segment-binding-repository'

let projectRoot = ''

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-binding-'))
  openCanonicalProjectFixture(projectRoot)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

function twoArcs() {
  const first = ArcOutlineRepository.save({ arcIndex: 1, fromChapter: 1, toChapter: 30, title: '第一段', summary: '起步', beat: 'setup' })
  const second = ArcOutlineRepository.save({ arcIndex: 2, fromChapter: 31, toChapter: 60, title: '第二段', summary: '升级', beat: 'escalation' })
  return { first, second }
}

describe('OutlineSegmentBindingRepository', () => {
  it('bindRange 为区间内每章写入归属', () => {
    const { first } = twoArcs()
    expect(OutlineSegmentBindingRepository.bindRange(1, 5, first.id, first.revision)).toBe(5)
    expect(OutlineSegmentBindingRepository.bindingFor(3)).toMatchObject({
      chapterNumber: 3, arcId: first.id, arcRevisionAtBuild: first.revision, fineState: 'fresh',
    })
  })

  it('重复 bindRange 覆盖并重置为 fresh', () => {
    const { first } = twoArcs()
    OutlineSegmentBindingRepository.bindRange(1, 3, first.id, first.revision)
    OutlineSegmentBindingRepository.markStaleFrom(first.id, first.revision + 1)
    expect(OutlineSegmentBindingRepository.listStale()).toEqual([1, 2, 3])
    OutlineSegmentBindingRepository.bindRange(1, 3, first.id, first.revision + 1)
    expect(OutlineSegmentBindingRepository.listStale()).toEqual([])
  })

  it('markStaleFrom 把修订号落后的章节标 stale', () => {
    const { first } = twoArcs()
    OutlineSegmentBindingRepository.bindRange(1, 5, first.id, first.revision)
    expect(OutlineSegmentBindingRepository.markStaleFrom(first.id, first.revision + 1)).toEqual([1, 2, 3, 4, 5])
    expect(OutlineSegmentBindingRepository.bindingFor(1)?.fineState).toBe('stale')
  })

  it('markStaleFrom 不动修订号已最新的章节', () => {
    const { first } = twoArcs()
    OutlineSegmentBindingRepository.bindRange(1, 5, first.id, first.revision)
    expect(OutlineSegmentBindingRepository.markStaleFrom(first.id, first.revision)).toEqual([])
    expect(OutlineSegmentBindingRepository.listStale()).toEqual([])
  })

  it('markStaleFrom 只影响指定段', () => {
    const { first, second } = twoArcs()
    OutlineSegmentBindingRepository.bindRange(1, 30, first.id, first.revision)
    OutlineSegmentBindingRepository.bindRange(31, 60, second.id, second.revision)
    expect(OutlineSegmentBindingRepository.markStaleFrom(first.id, first.revision + 1)).toHaveLength(30)
    expect(OutlineSegmentBindingRepository.listStale()).toEqual(Array.from({ length: 30 }, (_v, i) => i + 1))
  })

  it('listStale 只返回 stale 章号', () => {
    const { first } = twoArcs()
    OutlineSegmentBindingRepository.bindRange(1, 3, first.id, first.revision)
    expect(OutlineSegmentBindingRepository.listStale()).toEqual([])
  })
})
