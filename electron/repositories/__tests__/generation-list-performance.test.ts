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

    // 对照：旧的 list() 对每个 run 调 viewOf()，会读整份 binding_json 并对该 root
    // 跑一遍 attempt 查询。这里只统计「读了多少字节」，不做挂钟比较——挂钟值在
    // 并行跑整套测试时会被其它 477MB 副本的磁盘争用抬高，不适合做断言。
    // 读量是稳定的：旧路径要把每个 run 的整份生成记录搬进内存，新路径一字节都不读。
    const bindingBytes = db.prepare('SELECT SUM(LENGTH(CAST(binding_json AS BLOB))) FROM generation_runs').pluck().get() as number
    const attemptBytesTotal = db.prepare('SELECT SUM(LENGTH(CAST(usage_receipt_json AS BLOB))) FROM generation_attempts').pluck().get() as number
    console.log('old path would have read ~', ((bindingBytes + attemptBytesTotal) / 1048576).toFixed(0), 'MB')
    // 旧路径每个 run 都要读整份绑定；这一项本身就有几十 MB，是它慢的下界。
    expect(bindingBytes).toBeGreaterThan(50 * 1024 * 1024)

    expect(rows).toHaveLength(totalRuns)
    // 绝对上限留得宽：并行跑时磁盘争用会把 120ms 抬到几百毫秒。
    // 真正守住的是上面那条查询计划断言（不触碰 attempt 表）。
    expect(median).toBeLessThan(800)
    db.close()
  }, 60_000)
})
