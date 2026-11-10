import { describe, expect, it } from 'vitest'

import { presentWorkflowFailure } from '../ai-output-failure-presentation'

const promptBudgetReport = (sectionName: string) => ({
  totalUtf8Bytes: 13_000,
  limitUtf8Bytes: 12_000,
  reservedOutputTokens: 8_192,
  sections: [
    { sectionName, utf8Bytes: 12_000 },
    { sectionName: 'prompt-overhead', utf8Bytes: 1_000 },
  ],
  modelId: 'model-a',
  errorCode: 'PROMPT_BUDGET_EXHAUSTED' as const,
})

describe('AI output failure presentation', () => {
  it('maps a structured content-filter code to a clear Chinese chapter-draft failure', () => {
    expect(presentWorkflowFailure('content_filter', 'provider-safe message', 'zh-CN', true)).toEqual({
      heading: '正文生成被内容策略拦截',
      reason: '模型的内容安全策略拦截了这次输出。',
      persistence: '本次未保存草稿或正文章节。请调整章节要求，或选择符合预期内容政策的模型后重试。',
    })
  })

  it('maps a structured content-filter code to an English explanation instead of exposing it as prose', () => {
    expect(presentWorkflowFailure('content_filter', 'provider-safe message', 'en-US', true)).toEqual({
      heading: 'Draft generation was blocked by the content policy',
      reason: 'The model safety policy filtered this output.',
      persistence: 'No draft or manuscript chapter was saved. Adjust the chapter request, or choose a model whose policy fits your intended permitted content, then try again.',
    })
  })

  it('keeps a legacy machine-looking error generic when no structured code was supplied', () => {
    const presentation = presentWorkflowFailure(undefined, 'finish:content_filter', 'zh-CN', true)

    expect(presentation.reason).toBe('finish:content_filter')
    expect(presentation.heading).not.toBe('正文生成被内容策略拦截')
  })

  it('offers Novel configuration only for a project-configuration contributor', () => {
    expect(presentWorkflowFailure(
      'prompt_budget_exhausted',
      'safe report summary',
      'en-US',
      false,
      promptBudgetReport('global-guidance'),
    )).toMatchObject({
      action: 'open-novel-config',
      guidance: 'Shorten the listed project configuration fields in Novel configuration, then try again.',
    })
  })

  it('keeps a step-guidance overflow away from the unrelated Novel configuration action', () => {
    const presentation = presentWorkflowFailure(
      'prompt_budget_exhausted',
      'safe report summary',
      'zh-CN',
      false,
      promptBudgetReport('step-guidance'),
    )

    expect(presentation).toMatchObject({
      guidance: '请返回该生成步骤，缩短步骤指导后重试。',
    })
    expect(presentation).not.toHaveProperty('action')
  })

  it.each([
    ['architecture', 'Shorten the related story-architecture content or reduce this generation scope, then try again.'],
    ['validated-prefix', 'Reduce this structured batch and try again; validated content will not be silently truncated.'],
    ['repair-contract', 'The structured repair contract cannot be safely edited in the interface. Reduce this task scope; if the problem persists, report the result code.'],
    ['repair-candidate', 'Shorten the structured content being repaired, or split this import or generation into smaller batches, then try again.'],
  ])('provides safe non-configuration guidance for %s without an unrelated action', (sectionName, guidance) => {
    const presentation = presentWorkflowFailure(
      'prompt_budget_exhausted',
      'safe report summary',
      'en-US',
      false,
      promptBudgetReport(sectionName),
    )

    expect(presentation.guidance).toBe(guidance)
    expect(presentation).not.toHaveProperty('action')
  })
})


it.each([
  ['UND_ERR_BODY_TIMEOUT', '读取响应流超时'],
  ['UND_ERR_SOCKET', '响应连接中断'],
  [undefined, '具体原因未知'],
] as const)('explains safe review transport diagnostics without inferring the upstream cause: %s', (causeCode, reason) => {
  const presentation = presentWorkflowFailure(undefined, 'generic provider failure', 'zh-CN', false, undefined, {
    operation: 'review-chapter', diagnostics: { startedAt: 0, elapsedMs: 478000, firstResponseMs: 3000, lastResponseMs: 171000,
      lastOutputMs: null, phase: 'stream', endReason: 'failed', visibleEvents: 0, reasoningEvents: 0, ...(causeCode ? { causeCode } : {}) },
  })
  expect(presentation.reason).toContain(reason)
  expect(presentation.persistence).toBe('本次未保存完整审稿报告，原稿保留。')
  expect(presentation.guidance).toContain('重新审稿会重新调用模型')
})

// issue #85：通道失败原来只有审稿这一条链路被识别，其余（定稿后处理/细纲/起草）
// 掉到通用「工作流未完成」，作者看不出该不该直接重试。
describe('transport failure is distinguishable on every link (issue #85)', () => {
  const diagnostics = (over: Record<string, unknown> = {}) => ({
    startedAt: 0, elapsedMs: 56000, firstResponseMs: null, lastResponseMs: null, lastOutputMs: null,
    phase: 'stream' as const, endReason: 'failed' as const, visibleEvents: 0, reasoningEvents: 0, ...over,
  })

  it('says the connection failed, not that the workflow simply "did not finish"', () => {
    // operation 不是审稿，走的是新的通用通道分支。
    const presentation = presentWorkflowFailure(undefined, '模型请求失败。', 'zh-CN', true, undefined,
      { operation: 'chapter-draft-short-outline', diagnostics: diagnostics() })
    expect(presentation.heading).toBe('与模型的连接失败')
    expect(presentation.heading).not.toBe('工作流未完成')
    expect(presentation.reason).toContain('与模型的连接失败')
    // 出路必须可执行：多为瞬时故障，直接重试。
    expect(presentation.guidance).toContain('直接重试通常即可')
  })

  it('names a timeout as a timeout when there was a classified code', () => {
    const presentation = presentWorkflowFailure(undefined, 'x', 'zh-CN', true, undefined,
      { operation: 'finalized-character-state', diagnostics: diagnostics({ causeCode: 'ETIMEDOUT' }) })
    expect(presentation.reason).toContain('连接超时')
  })

  it('names an interrupted connection as interrupted', () => {
    const presentation = presentWorkflowFailure(undefined, 'x', 'zh-CN', true, undefined,
      { operation: 'plot-outline:chapter:19:normal', diagnostics: diagnostics({ errorCode: 'ECONNRESET' }) })
    expect(presentation.reason).toContain('连接中断')
  })

  it('reports an upstream HTTP status when that is what was observed', () => {
    const presentation = presentWorkflowFailure(undefined, 'x', 'zh-CN', true, undefined,
      { operation: 'chapter-draft', diagnostics: diagnostics({ httpStatus: 502, phase: 'response' }) })
    expect(presentation.reason).toContain('HTTP 502')
    // 细节里也回放可判定事实，方便作者反馈时复制。
    expect(presentation.persistence).toContain('HTTP 502')
    expect(presentation.persistence).toContain('56秒')
  })

  it('says the result is incomplete when the connection dropped after output began', () => {
    const presentation = presentWorkflowFailure(undefined, 'x', 'zh-CN', true, undefined,
      { operation: 'chapter-draft', diagnostics: diagnostics({ visibleEvents: 12, lastOutputMs: 40000 }) })
    expect(presentation.reason).toContain('连接断开')
    expect(presentation.reason).not.toContain('未收到任何输出')
  })

  it('explains it in English for the English locale', () => {
    const presentation = presentWorkflowFailure(undefined, 'x', 'en-US', true, undefined,
      { operation: 'chapter-draft', diagnostics: diagnostics({ causeCode: 'ECONNRESET' }) })
    expect(presentation.heading).toBe('Connection to the model failed')
    expect(presentation.guidance).toContain('usually transient')
  })

  it('does not claim a transport failure when the run merely ended without diagnostics', () => {
    // 没有诊断（例如内容类失败）时绝不能误报成通道问题。
    const presentation = presentWorkflowFailure('length', 'AI output reached this request length limit', 'zh-CN', true)
    expect(presentation.heading).not.toBe('与模型的连接失败')
  })

  it('keeps a completed-but-cancelled run from being reported as a connection failure', () => {
    const presentation = presentWorkflowFailure(undefined, 'x', 'zh-CN', true, undefined,
      { operation: 'chapter-draft', diagnostics: diagnostics({ endReason: 'cancelled' }) })
    expect(presentation.heading).not.toBe('与模型的连接失败')
  })

  /**
   * issue #245 现场：编辑部评审失败时，运行卡片上只有一句
   * `SyntaxError: Expected ':' after property name in JSON at position 1102`——
   * V8 的内部措辞，作者看不出是谁的问题、也不知道该做什么。
   * 真库取证是模型漏写键名（`"role": "continuity"` 写成 `"continuity"`），
   * 属**模型输出质量**问题，与作者的正文/设定无关，重试即可。
   */
  it('explains a malformed model structure instead of echoing the JS syntax error', () => {
    const raw = "SyntaxError: Expected ':' after property name in JSON at position 1102 (line 27 column 19)"
    const zh = presentWorkflowFailure(undefined, raw, 'zh-CN', false)
    expect(zh.heading).toBe('模型返回的结构不完整')
    // 必须明确「不是你的东西写错了」，否则作者会去改正文。
    expect(zh.reason).toContain('不是你的正文或设定')
    expect(zh.guidance).toContain('重试')
    // 也不能谎称落库了。
    expect(zh.persistence).toContain('没有保存任何内容')
    const en = presentWorkflowFailure(undefined, raw, 'en-US', false)
    expect(en.heading).toBe('The model returned malformed structured data')
  })

  it('does not swallow a genuine content-contract failure into the structure message', () => {
    // 评分越界这类是模型判断的结果问题，重发只会再撞一次——不能被归成「重试即可」。
    const presentation = presentWorkflowFailure(undefined, 'WRITING_INTELLIGENCE_EDITORIAL_SCORE_INVALID', 'zh-CN', false)
    expect(presentation.heading).not.toBe('模型返回的结构不完整')
  })
})
