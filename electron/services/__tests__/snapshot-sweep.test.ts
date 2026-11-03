import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TELEMETRY_TABLES, sweepStaleSnapshots } from '../sqlite-project-migration'
import { PROJECT_IDENTITY_VERSION } from '../project-format-migration'
const OWN = { owner: 'AI-Novel-Writer SQLite snapshot', ttlHours: 24 }
// issue #104：应用被强杀时快照的 close() 不会执行，实测本机残留 7 个 sqlite-read-* 目录。
// 每个快照的 .vibe-owner.json 已声明 ttlHours，按它清扫——只删本应用创建且过期的。
describe('sweepStaleSnapshots (issue #104)', () => {
  it('removes only expired snapshots this app owns, and leaves everything else', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-test-'))
    const mk = (name: string, owner: unknown, ageHours: number) => {
      const dir = path.join(base, name); fs.mkdirSync(dir)
      if (owner !== null) fs.writeFileSync(path.join(dir, '.vibe-owner.json'), JSON.stringify(owner))
      const t = Date.now() - ageHours * 3600 * 1000
      fs.utimesSync(dir, new Date(t), new Date(t))
    }
    mk('sqlite-read-stale', OWN, 48)
    mk('sqlite-read-fresh', OWN, 1)
    mk('sqlite-read-custom', { owner: 'AI-Novel-Writer SQLite snapshot', ttlHours: 2 }, 5)
    mk('sqlite-read-foreign', { owner: 'Someone Else' }, 100)
    mk('sqlite-read-noowner', null, 100)
    mk('other-app-dir', OWN, 100)
    fs.mkdirSync(path.join(base, 'sqlite-read-broken'))
    fs.writeFileSync(path.join(base, 'sqlite-read-broken', '.vibe-owner.json'), '{not json')
    const removed = sweepStaleSnapshots(base)
    expect(removed).toBe(2)
    expect(fs.readdirSync(base).sort()).toEqual(['other-app-dir', 'sqlite-read-broken', 'sqlite-read-foreign', 'sqlite-read-fresh', 'sqlite-read-noowner'].sort())
    fs.rmSync(base, { recursive: true, force: true })
  })
})

// issue #104①：把 3 个 selection 合并成一次扫描（原来最多 9 遍全表扫描）。
// 哈希必须逐字不变——只减少 I/O，不改判据语义，否则 journal 里持久化的旧哈希会对不上。
describe('single-pass author-content identity (issue #104)', () => {
  it('keeps the excluded telemetry tables out of the identity, and the author tables in', () => {
    // 排除：无界执行遥测（不被任何迁移的数据保全合同引用）。
    for (const table of ['generation_runs', 'generation_attempts', 'generation_roots', 'generation_artifacts', 'llm_calls', 'post_process_runs', 'post_process_steps']) {
      expect(TELEMETRY_TABLES.has(table), table).toBe(true)
    }
    // 保留：作者内容（审稿报告、修稿记录、每章摘要、定稿快照）——身份校验要保护的正是这些。
    for (const table of ['reviews', 'revisions', 'summary_snapshots', 'finalization_outbox', 'review_findings', 'contents', 'drafts', 'blueprints', 'characters']) {
      expect(TELEMETRY_TABLES.has(table), table).toBe(false)
    }
  })

  it('declares an identity algorithm version so an in-flight journal can be refreshed', () => {
    expect(PROJECT_IDENTITY_VERSION).toBe(1)
  })
})
