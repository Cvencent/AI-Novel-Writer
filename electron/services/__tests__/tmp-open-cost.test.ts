import { describe, expect, it } from 'vitest'
import { verifyProjectSqlite } from '../sqlite-project-migration'

describe('project open cost on the real 源起 database', () => {
  it('verifies the live project without scanning generation telemetry', () => {
    const databasePath = 'F:/yuanqi/源起/.ai-novel/project.db'
    const started = Date.now()
    const result = verifyProjectSqlite({ databasePath })
    const elapsed = Date.now() - started
    // Real project is ~478 MB with 126 MB of generation_attempts telemetry.
    // Before the fix this verification cost ~2.7 s; telemetry must not dominate.
    console.log('verify ms', elapsed, 'authorTables', Object.keys(result.domain.tableCounts).length,
      'hasTelemetry', 'generation_attempts' in result.domain.tableCounts)
    expect(result.domain.tableCounts.generation_attempts).toBeUndefined()
    expect(result.domain.tableCounts.generation_runs).toBeUndefined()
    expect(elapsed).toBeLessThan(1500)
  })
})
