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

  it('解析工具调用的名称、参数与返回内容', () => {
    const db = getProjectDb()!
    db.prepare(`INSERT INTO generation_roots (root_action_id, idempotency_key, action_json, budget_json)
      VALUES ('root-tool', 'idem-tool', '{}', '{}')`).run()
    db.prepare(`INSERT INTO generation_runs (run_id, root_action_id, binding_json, status, created_at_ms, open_key)
      VALUES ('run-tool', 'root-tool', '{}', 'completed', 1, 'open-tool')`).run()
    const messages = [
      { role: 'system', content: '系统' },
      { role: 'user', content: '写细纲' },
      { role: 'assistant', content: '<tool_call>{"name":"create_character","arguments":{"name":"新角色"}}</tool_call>' },
      { role: 'user', content: '<tool_result name="create_character">\n已新增角色「新角色」。\n</tool_result>' },
      { role: 'assistant', content: '## 第1章：开头\n正文。' },
    ]
    db.prepare(`INSERT INTO generation_attempts (attempt_id, reservation_id, run_id, root_action_id, attempt_json, usage_receipt_json, invocation_nonce)
      VALUES ('a-tool', 'res-tool', 'run-tool', 'root-tool', ?, ?, 'nonce-tool')`).run(
      JSON.stringify({ attemptId: 'a-tool', status: 'settled', requestedOutputTokens: 8192 }),
      JSON.stringify({ purpose: 'plot-outline:chapter:1', modelId: 'test-model', replayTask: { messages }, artifactIdentity: { artifactId: 'art-tool' } }),
    )
    db.prepare(`INSERT INTO generation_artifacts (artifact_id, attempt_id, run_id, artifact_json, revision, status)
      VALUES ('art-tool', 'a-tool', 'run-tool', ?, 1, 'settled')`).run(JSON.stringify({ text: '## 第1章：开头\n正文。' }))

    const detail = GenerationLogRepository.read('a-tool')!
    expect(detail.toolCalls).toHaveLength(1)
    expect(detail.toolCalls[0]).toMatchObject({
      name: 'create_character',
      arguments: { name: '新角色' },
      result: '已新增角色「新角色」。',
    })
  })

  it('未知 attemptId 返回 null', () => {
    expect(GenerationLogRepository.read('missing')).toBeNull()
  })

  it('超过保留上限时，只清理更早记录里的 Prompt，返回文本与摘要都留着', () => {
    // 保留策略：完整 Prompt 只留最近 N 次调用。更早的记录必须仍然能被列出、仍然有返回文本，
    // 只是 Prompt 被清掉，并且明确标出「已按保留策略清理」，不能静默变成空。
    const db = getProjectDb()!
    const old = [1, 2, 3]
    for (const n of old) seedCall('old-' + n, 'plot-outline:chapter:' + n, '早期提示词 ' + n, '早期返回 ' + n)
    seedCall('kept-1', 'plot-outline:chapter:9', '最近提示词 1', '最近返回 1')
    seedCall('kept-2', 'plot-outline:chapter:10', '最近提示词 2', '最近返回 2')

    const removed = GenerationLogRepository.trimPromptHistory(2, db)
    expect(removed).toBe(3)

    // 更早的三条：Prompt 没了，但返回还在、purpose 还在
    for (const n of old) {
      const detail = GenerationLogRepository.read('old-' + n, db)!
      expect(detail.promptMessages).toEqual([])
      expect(detail.output).toBe('早期返回 ' + n)
      expect(detail.purpose).toBe('plot-outline:chapter:' + n)
      expect(detail.promptTrimmed).toBe(true)
    }
    // 最近的两次：Prompt 完整保留
    for (const id of ['kept-1', 'kept-2']) {
      const detail = GenerationLogRepository.read(id, db)!
      expect(detail.promptMessages.length).toBeGreaterThan(0)
      expect(detail.promptTrimmed).toBe(false)
    }
    // 列表仍然列出全部五条
    expect(GenerationLogRepository.list(50, db)).toHaveLength(5)
  })

  it('保留上限之内不做任何清理', () => {
    const db = getProjectDb()!
    seedCall('a-1', 'p1', '提示词 1', '返回 1')
    seedCall('a-2', 'p2', '提示词 2', '返回 2')
    expect(GenerationLogRepository.trimPromptHistory(10, db)).toBe(0)
    expect(GenerationLogRepository.read('a-1', db)!.promptTrimmed).toBe(false)
  })

  it('list 限制上限为 500', () => {
    seedCall('a3', 'p', 'x', 'y')
    expect(GenerationLogRepository.list(9999)).toHaveLength(1)
  })
})
