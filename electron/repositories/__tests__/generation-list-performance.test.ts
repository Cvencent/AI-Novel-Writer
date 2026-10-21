import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'

/**
 * 《源起》实测副本上的热路径回归防线。
 *
 * 这份库有 201 个历史运行、743 条生成记录，generation_attempts 占 355MB。
 * 这里固定住「运行列表必须廉价」这条契约：作品写到几百章以后，列表仍然是
 * 一次针对 generation_runs 的投影查询，绝不触碰 generation_attempts
 * （那份表按 root_action_id 查时要扫全表，而全表就是 355MB）。
 *
 * 库不存在时跳过（CI 上没有这部作品）。
 */
/**
 * 库位置：默认用本机《源起》的实测副本，也可以用 AI_NOVEL_PERF_DB 指向任意
 * 「历史运行很多、生成记录很大」的作品库。找不到就跳过。
 */
const DB = process.env.AI_NOVEL_PERF_DB
  ?? 'C:/Users/vencent/AppData/Local/VibeCodingScratch/an/perf-probe/projects/源起/.ai-novel/project.db'
const has = fs.existsSync(DB)

/** 与 electron/services/main-generation-owner.ts 的 list() 保持一致。 */
const LIST_SQL = `SELECT r.run_id, r.root_action_id, r.status,
    json_extract(r.binding_json,'$.projectId') AS project_id,
    json_extract(r.binding_json,'$.epoch') AS epoch,
    json_extract(r.binding_json,'$.sourceManifest.operation') AS operation
  FROM generation_runs r
  WHERE json_extract(r.binding_json,'$.projectId') = ?
  ORDER BY r.created_at_ms DESC, r.rowid DESC`

describe.skipIf(!has)('generation list stays cheap on a 355MB attempt table', () => {
  it('lists every run without touching the attempt table', () => {
    const db = new Database(DB, { readonly: true, fileMustExist: true })
    db.pragma('cache_size = -16000')

    const totalRuns = db.prepare('SELECT COUNT(*) FROM generation_runs').pluck().get() as number
    const attemptBytes = (db.prepare('SELECT SUM(LENGTH(CAST(usage_receipt_json AS BLOB))) FROM generation_attempts').pluck().get() as number) ?? 0
    console.log('runs', totalRuns, '| attempt JSON MB', (attemptBytes / 1048576).toFixed(1))
    expect(totalRuns).toBeGreaterThan(100)

    // 契约本身：列表查询的计划里不能出现 generation_attempts。
    const plan = db.prepare('EXPLAIN QUERY PLAN ' + LIST_SQL).all('x') as { detail: string }[]
    const planText = plan.map(p => p.detail).join(' | ')
    console.log('plan:', planText)
    expect(planText).not.toContain('generation_attempts')

    const projectId = db.prepare("SELECT json_extract(binding_json,'$.projectId') FROM generation_runs LIMIT 1").pluck().get() as string
    const times: number[] = []
    let rows: unknown[] = []
    for (let i = 0; i < 5; i++) {
      const t0 = process.hrtime.bigint()
      rows = db.prepare(LIST_SQL).all(projectId)
      times.push(Number(process.hrtime.bigint() - t0) / 1e6)
    }
    times.sort((a, b) => a - b)
    const median = times[Math.floor(times.length / 2)]!
    console.log('list() median', median.toFixed(1), 'ms for', rows.length, 'runs')

    // 旧的 list() 对每个 run 调 viewOf()：读整份 binding_json，并对该 root 跑一遍
    // generation_attempts 的查询。在有 355MB attempts 的库上这是秒级。
    const receiptSelect = `SELECT t.attempt_id,t.run_id,t.rowid AS ordinal,t.attempt_json,
        json_object('purpose',json_extract(t.usage_receipt_json,'$.purpose')) AS usage_receipt_json,
        a.artifact_id,a.run_id AS artifact_run_id,a.artifact_json,a.revision,a.status AS artifact_status
      FROM generation_attempts t LEFT JOIN generation_artifacts a ON a.attempt_id=t.attempt_id`
    const all = db.prepare('SELECT run_id, root_action_id FROM generation_runs').all() as { run_id: string; root_action_id: string }[]
    const tOld = process.hrtime.bigint()
    for (const r of all) {
      db.prepare('SELECT * FROM generation_runs WHERE run_id=?').get(r.run_id)
      db.prepare(receiptSelect + ' WHERE t.root_action_id=?').all(r.root_action_id)
    }
    const oldMs = Number(process.hrtime.bigint() - tOld) / 1e6
    console.log('old per-run hydration (same DB)', oldMs.toFixed(1), 'ms')

    expect(rows).toHaveLength(totalRuns)
    // 至少快 5 倍，并且绝对值足够低（一次列表不该像一次全量水合那样接近一秒）。
    expect(median).toBeLessThan(oldMs / 5)
    expect(median).toBeLessThan(300)
    db.close()
  }, 60_000)
})
