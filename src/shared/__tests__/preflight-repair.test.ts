import { describe, expect, it } from 'vitest'

import {
  LAYER_FIELDS,
  advanceRepairQueue,
  buildRepairPrompt,
  diffRepairPatch,
  parseRepairPatch,
  planRepairCalls,
  remainingRepairLayers,
  shouldContinueRepairChain,
} from '../preflight-repair'

const finding = (stableFactKey: string, zh: string) => ({
  stableFactKey,
  evidence: `第45章：「回执摊在桌上」`,
  issue: { zhCN: zh, enUS: 'problem' },
  suggestion: { zhCN: '在正文开头补一句日界。', enUS: 'Add a boundary.' },
})

/**
 * issue #137 第二层：**生成补丁那一格交给模型，规则只做能断言的四件事**。
 *
 * 用户 2026-11-04 定规：「规则做不完整的地方要交模型，不要到处写强规则。」
 * 判据的 `suggestion` 是自然语言改法（「换一个动作落点」），规则推不出该改哪几个字；
 * 所以这一层只负责：可写字段表、组装输入、校验输出、算差异。
 */
describe('LAYER_FIELDS (issue #137)', () => {
  it('never exposes charactersArch: it is generated from the roster and refuses direct writes', () => {
    for (const fields of Object.values(LAYER_FIELDS)) expect(fields).not.toContain('charactersArch')
  })

  it('never exposes the chapter number as rewritable content', () => {
    expect(LAYER_FIELDS.blueprint).not.toContain('chapterNumber')
  })

  it('gives the prose layer no writable fields at all', () => {
    // 已定稿正文只能「新版本 + 重新定稿」，不走字段级 patch。
    expect(LAYER_FIELDS.prose).toEqual([])
  })
})

describe('buildRepairPrompt (issue #137)', () => {
  const request = {
    layer: 'blueprint' as const,
    chapterNumber: 45,
    current: { title: '回执', keyEvents: '他把回执摊在桌上。', suspenseHook: '谁改了日期？' },
    findings: [finding('chapter-time:anchor-unmet:45', '本章蓝图声明了时间推进，正文没有日界。')],
  }

  it('carries the current text, the reminders and the allowed field list', () => {
    const { system, user } = buildRepairPrompt(request)
    expect(user).toContain('他把回执摊在桌上。')
    expect(user).toContain('chapter-time:anchor-unmet:45')
    expect(user).toContain('在正文开头补一句日界。')
    for (const field of LAYER_FIELDS.blueprint) expect(system).toContain(field)
  })

  it('asks for changed fields only, as complete field text, and requires strict JSON', () => {
    const { system } = buildRepairPrompt(request)
    expect(system).toContain('只输出**真正改动**的字段')
    expect(system).toContain('完整文本')
    expect(system).toContain('JSON 之外不要写任何解释')
  })

  it('states that an empty patch is a legitimate answer', () => {
    // 否则模型会为了「有输出」硬凑一处改动。
    expect(buildRepairPrompt(request).system).toContain('{"fields": {}, "reasons": {}}')
  })
})

describe('parseRepairPatch (issue #137)', () => {
  const request = { layer: 'blueprint' as const, current: { title: '回执', keyEvents: '他把回执摊在桌上。' } }

  it('accepts a well-formed patch and keeps only changed fields', () => {
    const patch = parseRepairPatch(JSON.stringify({
      fields: { keyEvents: '次日清晨，他把回执摊在桌上。', title: '回执' },
      reasons: { keyEvents: '补了日界' },
    }), request)
    expect(patch!.fields).toEqual({ keyEvents: '次日清晨，他把回执摊在桌上。' })
    // 与原文逐字相同的字段不算改动，不该出现在差异里。
    expect(patch!.fields).not.toHaveProperty('title')
    expect(patch!.reasons.keyEvents).toBe('补了日界')
  })

  it('rejects the whole patch when it names a field outside the layer', () => {
    // 模型想顺手改别的层 —— 整条拒绝，而不是「只采纳合法部分」：
    // 后者会让作者以为全都改了。
    const patch = parseRepairPatch(JSON.stringify({
      fields: { keyEvents: '新内容', worldbuilding: '顺手改了世界观' },
    }), request)
    expect(patch).toBeNull()
  })

  it('rejects malformed JSON instead of silently adopting nothing', () => {
    expect(parseRepairPatch('这不是 JSON', request)).toBeNull()
    expect(parseRepairPatch('[1,2,3]', request)).toBeNull()
    expect(parseRepairPatch('{"fields": "x"}', request)).toBeNull()
  })

  it('tolerates a ```json fence', () => {
    const patch = parseRepairPatch('```json\n{"fields":{"keyEvents":"新的"}}\n```', request)
    expect(patch!.fields).toEqual({ keyEvents: '新的' })
  })

  it('treats an empty patch as a valid “no change needed” answer', () => {
    expect(parseRepairPatch('{"fields":{},"reasons":{}}', request)).toEqual({ fields: {}, reasons: {} })
  })

  it('drops non-string values and blank rewrites', () => {
    const patch = parseRepairPatch(JSON.stringify({
      fields: { keyEvents: '   ', title: 42 },
    }), request)
    expect(patch!.fields).toEqual({})
  })
})

describe('diffRepairPatch (issue #137)', () => {
  it('shows before and after per field, in the layer’s field order', () => {
    const diffs = diffRepairPatch(
      { fields: { suspenseHook: '新钩子', title: '新标题' }, reasons: { title: '换个更准的' } },
      { layer: 'blueprint', current: { title: '旧标题', suspenseHook: '旧钩子' } },
    )
    expect(diffs.map(diff => diff.field)).toEqual(['title', 'suspenseHook'])
    expect(diffs[0]).toEqual({ field: 'title', before: '旧标题', after: '新标题', reason: '换个更准的' })
    expect(diffs[1]!.before).toBe('旧钩子')
  })
})

describe('planRepairCalls (issue #137)', () => {
  it('makes one call per layer, never one per finding', () => {
    const calls = planRepairCalls([
      { ...finding('a:1', 'a'), layer: 'blueprint' },
      { ...finding('a:2', 'b'), layer: 'blueprint' },
      { ...finding('b:1', 'c'), layer: 'cast' },
      { ...finding('c:1', 'd'), layer: 'prose' },
    ])
    expect(calls.map(call => call.layer)).toEqual(['cast', 'blueprint'])
    expect(calls.find(call => call.layer === 'blueprint')!.findings).toHaveLength(2)
  })

  it('orders layers deterministically and skips empty ones', () => {
    const calls = planRepairCalls([
      { ...finding('x:1', 'x'), layer: 'blueprint' },
      { ...finding('y:1', 'y'), layer: 'world' },
    ])
    expect(calls.map(call => call.layer)).toEqual(['world', 'blueprint'])
  })
})
/**
 * issue #137：「全部修复」的**跨层排队**。
 *
 * 缺口：`planRepairCalls` 把可修提醒按层排好，但界面只取第一批——于是「全部修复」
 * 实际只修一层，其余层原样留着，而按钮上写的是「全部」。
 */
describe('跨层排队 (issue #137)', () => {
  const group = (layer: 'world' | 'cast' | 'outline' | 'blueprint', ks: string[]) =>
    ({ layer, findings: ks.map(key => ({ stableFactKey: key })) })

  it('drops the finished layer and keeps the others in order', () => {
    const queue = [group('world', ['w1']), group('blueprint', ['b1', 'b2'])]
    expect(advanceRepairQueue(queue, 'world').map(item => item.layer)).toEqual(['blueprint'])
    // 原数组不被修改（界面状态要能回看）。
    expect(queue.map(item => item.layer)).toEqual(['world', 'blueprint'])
  })

  it('does not advance when the layer produced no change', () => {
    // 模型说「这层不用改」/ 作者点了「都不改」→ 队列必须原地不动，
    // 否则那几层的提醒会在没有任何改动的情况下被当作已处理。
    const queue = [group('world', ['w1']), group('blueprint', ['b1'])]
    expect(advanceRepairQueue(queue, null).map(item => item.layer)).toEqual(['world', 'blueprint'])
  })

  it('removes every group of the finished layer, so one layer is never queued twice', () => {
    const queue = [group('blueprint', ['b1']), group('world', ['w1']), group('blueprint', ['b2'])]
    expect(advanceRepairQueue(queue, 'blueprint').map(item => item.layer)).toEqual(['world'])
  })

  it('names the layers still queued, without duplicates', () => {
    expect(remainingRepairLayers([group('world', ['w1']), group('blueprint', ['b1']), group('blueprint', ['b2'])]))
      .toEqual(['world', 'blueprint'])
    expect(remainingRepairLayers([])).toEqual([])
  })

  it('continues only when something was actually applied and another layer is left', () => {
    // 四条组合都要对：「不采纳」绝不能触发下一层，否则作者会看到一串自己没同意的改动。
    expect(shouldContinueRepairChain({ appliedChanges: true, hasOtherLayers: true })).toBe(true)
    expect(shouldContinueRepairChain({ appliedChanges: false, hasOtherLayers: true })).toBe(false)
    expect(shouldContinueRepairChain({ appliedChanges: true, hasOtherLayers: false })).toBe(false)
    expect(shouldContinueRepairChain({ appliedChanges: false, hasOtherLayers: false })).toBe(false)
  })
})
