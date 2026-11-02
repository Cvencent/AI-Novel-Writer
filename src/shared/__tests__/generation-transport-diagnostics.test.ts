import { describe, expect, it } from 'vitest'

import { formatTransportDiagnostics, safeTransportError, type GenerationTransportDiagnostics } from '../generation-contract'

const base: GenerationTransportDiagnostics = {
  startedAt: 1000,
  elapsedMs: 56123,
  firstResponseMs: 4200,
  lastResponseMs: 55_900,
  lastOutputMs: 55_400,
  phase: 'stream',
  endReason: 'failed',
  visibleEvents: 3,
  reasoningEvents: 0,
}

// issue #85：`llm_calls.error_message` 原来只写裸码 `GENERATION_PROVIDER_FAILED`，
// 报告实测四个链路（定稿后处理/细纲/审稿/起草）的失败记录**全都只有那一个词**，
// 作者与维护者都看不出「超时 / 被掐断 / 上游 5xx / 鉴权失败」的区别，
// 也就无法判断该不该重试。
describe('formatTransportDiagnostics (issue #85)', () => {
  it('keeps the failure code as the leading token so existing LIKE queries still match', () => {
    // 报告里的判据是 `error_message LIKE '%PROVIDER_FAILED%'`：加了诊断段之后
    // 这条查询必须仍然命中，否则「清点通道失败」的既有做法会被静默改坏。
    const line = formatTransportDiagnostics(base, 'GENERATION_PROVIDER_FAILED')
    expect(line.startsWith('GENERATION_PROVIDER_FAILED')).toBe(true)
    expect(line).toContain('GENERATION_PROVIDER_FAILED')
    expect(line.split(' ')[0]).toBe('GENERATION_PROVIDER_FAILED')
  })

  it('records the facts that decide whether a retry makes sense', () => {
    const line = formatTransportDiagnostics(base, 'GENERATION_PROVIDER_FAILED')
    expect(line).toContain('end=failed')
    expect(line).toContain('phase=stream')
    expect(line).toContain('elapsed=56123ms')
    expect(line).toContain('firstResp=4200ms')
    expect(line).toContain('visible=3')
  })

  it('surfaces the upstream HTTP status when there was one', () => {
    const line = formatTransportDiagnostics({ ...base, httpStatus: 502, phase: 'response' }, 'GENERATION_PROVIDER_FAILED')
    expect(line).toContain('http=502')
  })

  it('prefers the classified transport code over the raw error name', () => {
    // 「TypeError」对「该不该重试」几乎无用；归类的 socket/超时码才有用。
    const line = formatTransportDiagnostics({
      ...base, errorName: 'TypeError', errorCode: 'UND_ERR_BODY_TIMEOUT',
    }, 'NETWORK_ERROR')
    expect(line).toContain('code=UND_ERR_BODY_TIMEOUT')
    expect(line).not.toContain('err=TypeError')
  })

  it('falls back to the error name when no transport code was classified', () => {
    const line = formatTransportDiagnostics({ ...base, errorName: 'AbortError' }, 'GENERATION_PROVIDER_FAILED')
    expect(line).toContain('err=AbortError')
  })

  it('uses causeCode when the socket failure is nested under error.cause', () => {
    const transport = safeTransportError(Object.assign(new Error('boom'), { cause: { code: 'ECONNRESET' } }))
    const line = formatTransportDiagnostics({ ...base, ...transport }, 'NETWORK_ERROR')
    expect(line).toContain('code=ECONNRESET')
  })

  it('omits the segments it has no value for instead of writing nulls', () => {
    const line = formatTransportDiagnostics({
      startedAt: 0, elapsedMs: 0, firstResponseMs: null, lastResponseMs: null, lastOutputMs: null,
      phase: 'request', visibleEvents: 0, reasoningEvents: 0,
    }, 'GENERATION_PROVIDER_FAILED')
    expect(line).toBe('GENERATION_PROVIDER_FAILED phase=request elapsed=0ms')
    expect(line).not.toContain('null')
    expect(line).not.toContain('http=')
    expect(line).not.toContain('code=')
  })

  it('degrades to the bare code when diagnostics never arrived', () => {
    // 请求在发出前后就失败（报告里的 id=215 是 0 秒）时可能一条诊断都没有——
    // 这时不能凭空编造，也不能让记录变空（否则连「通道失败」都看不出来）。
    expect(formatTransportDiagnostics(undefined, 'GENERATION_PROVIDER_FAILED')).toBe('GENERATION_PROVIDER_FAILED')
  })

  it('never leaks provider text: the diagnostics object carries structured fields only', () => {
    // 结构化字段里本来就不该有 error.message / HTTP body；这里用一个「带正文的错误」
    // 走一遍 safeTransportError，证明取出来的是码而不是正文。
    const withSecret = Object.assign(new Error('Authorization: Bearer sk-secret-value'), { code: 'ETIMEDOUT' })
    const transport = safeTransportError(withSecret)
    const line = formatTransportDiagnostics({ ...base, ...transport }, 'NETWORK_ERROR')
    expect(line).toContain('code=ETIMEDOUT')
    expect(line).not.toContain('sk-secret-value')
    expect(line).not.toContain('Bearer')
  })
})