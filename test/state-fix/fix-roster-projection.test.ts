/**
 * 一次性修复：角色名单 `inconsistent`（投影哈希与静态事实不一致）。
 *
 * 成因：直接改了 `appearance` 等静态字段，却只刷新了状态投影（fact_hash），
 * 没有重算身份投影（characters_arch + projection_hash）。
 *
 * `characters_arch` 是从 characters 行确定性渲染的只读图谱，不是作者手写内容，
 * 因此用 `refreshCharacterIdentityProjection` 重算是安全修复，不会覆盖任何事实。
 *
 *   ROSTER_FIX_PROJECT="F:/yuanqi/源起" pnpm vitest run test/state-fix/fix-roster-projection.test.ts
 *
 * 未设置环境变量时整例跳过，全量测试不会碰真实库。
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../electron/database'
import {
  CharacterRosterRepository,
  refreshCharacterIdentityProjection,
} from '../../electron/repositories/character-roster-repository'

const projectPath = process.env.ROSTER_FIX_PROJECT ?? ''

it.skipIf(!projectPath)('rebuilds the roster projection so a static-field edit is consistent again', () => {
  initProjectDatabase(projectPath)
  const db = getProjectDb()!

  const before = CharacterRosterRepository.read(db)
  const beforeArch = db.prepare("SELECT characters_arch FROM project_core WHERE id='main'").pluck().get() as string
  // 只在确实不一致时动手，避免无意义地推高 revision。
  const needsRepair = before.status === 'inconsistent'

  if (needsRepair) {
    db.transaction(() => refreshCharacterIdentityProjection(db))()
  }

  const after = CharacterRosterRepository.read(db)
  const afterArch = db.prepare("SELECT characters_arch FROM project_core WHERE id='main'").pluck().get() as string

  // 修复后必须是 ready：投影、事实哈希、project_core 投影三者一致。
  expect(after.status).toBe('ready')
  if (needsRepair) {
    expect(after.revision).toBe(before.revision + 1)
    expect(afterArch).not.toBe(beforeArch)
  }
  // 静态外貌已经进入列表投影，不再只存在于列里。
  expect(afterArch).toContain('洗得泛白的九班制式风衣')

  fs.writeFileSync(path.join(import.meta.dirname, 'roster-fix-report.json'), JSON.stringify({
    repairedAt: new Date().toISOString(),
    repaired: needsRepair,
    statusBefore: before.status,
    statusAfter: after.status,
    revisionBefore: before.revision,
    revisionAfter: after.revision,
    archLengthBefore: beforeArch.length,
    archLengthAfter: afterArch.length,
  }, null, 2))
})

afterAll(() => { closeProjectDatabase() })