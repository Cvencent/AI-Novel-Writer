import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import { GenerationLogRepository } from '../generation-log-repository'

let projectRoot = ''

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-gen-log-'))
  openCanonicalProjectFixture(projectRoot)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

function seedCall(attemptId: string, purpose: string, prompt: string, output: string) {
  const db = getProjectDb()!
  db.prepare(`INSERT INTO generation_roots (root_action_id, idempotency_key, action_json, budget_json)
    VALUES (?, ?, '{}', '{}')`).run('root-' + attemptId, 'idem-' + attemptId)
  db.prepare(`INSERT INTO generation_runs (run_id, root_action_id, binding_json, status, created_at_ms, open_key)
    VALUES (?, ?, '{}', 'completed', 1, ?)`).run('run-' + attemptId, 'root-' + attemptId, 'open-' + attemptId)
  db.prepare(`INSERT INTO generation_attempts (attempt_id, reservation_id, run_id, root_action_id, attempt_json, usage_receipt_json, invocation_nonce)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    attemptId, 'res-' + attemptId, 'run-' + attemptId, 'root-' + attemptId,
    JSON.stringify({ attemptId, status: 'settled', requestedOutputTokens: 8192 }),
    JSON.stringify({
      purpose,
      modelId: 'test-model',
      replayTask: { messages: [{ role: 'system', content: prompt }, { role: 'user', content: '问' }] },
      artifactIdentity: { artifactId: 'art-' + attemptId },
    }),
    'nonce-' + attemptId,
  )
  db.prepare(`INSERT INTO generation_artifacts (artifact_id, attempt_id, run_id, artifact_json, revision, status)
    VALUES (?, ?, ?, ?, 1, 'settled')`).run(
    'art-' + attemptId, attemptId, 'run-' + attemptId, JSON.stringify({ text: output }),
  )
}

describe('GenerationLogRepository', () => {
  it('列出调用并标记是否含 Prompt 与返回', () => {
    seedCall('a1', 'plot-outline:chapter:1', '系统提示词内容', '模型返回内容')
    const list = GenerationLogRepository.list(10)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ purpose: 'plot-outline:chapter:1', hasPrompt: true, hasOutput: true })
  })

  it('读取单次调用时返回完整 Prompt 与返回文本', () => {
    seedCall('a2', 'arc-outline:from:1', '粗纲系统提示词', '粗纲输出文本')
    const detail = GenerationLogRepository.read('a2')!
    expect(detail.promptMessages.map(m => m.content)).toEqual(['粗纲系统提示词', '问'])
    expect(detail.output).toBe('粗纲输出文本')
  })

  it('未知 attemptId 返回 null', () => {
    expect(GenerationLogRepository.read('missing')).toBeNull()
  })

  it('list 限制上限为 500', () => {
    seedCall('a3', 'p', 'x', 'y')
    expect(GenerationLogRepository.list(9999)).toHaveLength(1)
  })
})
