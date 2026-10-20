import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getCurrentProjectPath } from '../../database'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { ArcOutlineRepository } from '../../repositories/arc-outline-repository'

/**
 * 粗纲通道的契约测试：直接验证仓库 seam 与会话参数顺序。
 * 通道注册本身由 db-controller 的既有认证路径覆盖；这里锁定
 * 「必须带 expectedProjectPath」与「区间错误返回失败对象」两条契约。
 */
let projectRoot = ''

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-arc-ipc-'))
  openCanonicalProjectFixture(projectRoot)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

describe('arc outline project-scoped contract', () => {
  it('当前项目路径可用于通道校验', () => {
    expect(getCurrentProjectPath()).toBe(projectRoot)
  })

  it('save 成功返回记录，区间重叠时抛出稳定错误码', () => {
    const record = ArcOutlineRepository.save({
      arcIndex: 1, fromChapter: 1, toChapter: 30, title: '第一段', summary: '起步走向', beat: 'setup',
    })
    expect(record).toMatchObject({ arcIndex: 1, fromChapter: 1, toChapter: 30, status: 'draft' })
    expect(() => ArcOutlineRepository.save({
      arcIndex: 2, fromChapter: 20, toChapter: 50, title: '冲突', summary: '冲突走向', beat: 'escalation',
    })).toThrow('ARC_OUTLINE_RANGE_OVERLAP')
  })

  it('list 返回全部段，confirm 后状态与修订号更新', () => {
    const record = ArcOutlineRepository.save({
      arcIndex: 1, fromChapter: 1, toChapter: 30, title: '第一段', summary: '起步走向', beat: 'setup',
    })
    expect(ArcOutlineRepository.list()).toHaveLength(1)
    const confirmed = ArcOutlineRepository.confirm(1, record.revision)
    expect(confirmed).toMatchObject({ status: 'confirmed', revision: record.revision + 1 })
  })

  it('revise 让状态回到 draft 并递增修订号', () => {
    const record = ArcOutlineRepository.save({
      arcIndex: 1, fromChapter: 1, toChapter: 30, title: '第一段', summary: '起步走向', beat: 'setup',
    })
    ArcOutlineRepository.confirm(1, record.revision)
    const revised = ArcOutlineRepository.revise(1, record.revision + 1, '改后的走向')
    expect(revised).toMatchObject({ summary: '改后的走向', status: 'draft', revision: record.revision + 2 })
  })
})
