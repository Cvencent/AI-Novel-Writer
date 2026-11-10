import { describe, expect, it } from 'vitest'
import { isMalformedStructureError } from '../editorial-panel.command'
import { parseEditorialPanelResponse } from '../../../../shared/writing-intelligence'

/**
 * issue #245 现场：编辑部评审在运行侧页直接显示
 * `SyntaxError: Expected ':' after property name in JSON at position 1102`。
 *
 * 真库复现后确认：模型把 `"role": "continuity",` 写成了 `"continuity",`。
 * 这是模型的采样质量问题，重发同一个提示词通常能换回一份合法结构，
 * 所以只对**这一类**重试一次；内容合同错误（评分越界 / 角色重复）绝不重试。
 */
describe('编辑部评审的结构错误判据 (issue #245)', () => {
  const malformed = () => {
    // 真库原始响应的骨架：第 2 个角色对象漏了 `"role":` 键名。
    try {
      parseEditorialPanelResponse('{"summary":"x","roles":[{"role":"plot","score":88,"summary":"s","findings":[]},{"continuity","score":75,"summary":"s","findings":[]}]}')
    } catch (error) { return error }
    throw new Error('expected the malformed payload to throw')
  }

  it('treats a malformed JSON response as retryable', () => {
    expect(isMalformedStructureError(malformed())).toBe(true)
  })

  it('does not retry content-contract failures (they would fail again)', () => {
    // 合法 JSON，但评分越界 —— 模型判断的结果问题，重发同一个请求只会再撞一次。
    let contractError: unknown
    try {
      parseEditorialPanelResponse(JSON.stringify({
        summary: 'x',
        roles: [
          { role: 'plot', score: 999, summary: 's', findings: [] },
          { role: 'continuity', score: 75, summary: 's', findings: [] },
          { role: 'character', score: 75, summary: 's', findings: [] },
          { role: 'style', score: 75, summary: 's', findings: [] },
          { role: 'pacing', score: 75, summary: 's', findings: [] },
        ],
      }))
    } catch (error) { contractError = error }
    expect(isMalformedStructureError(contractError)).toBe(false)
  })

  it('does not retry transport failures', () => {
    expect(isMalformedStructureError(new Error('GENERATION_PROVIDER_FAILED'))).toBe(false)
    expect(isMalformedStructureError(new Error('ECONNRESET'))).toBe(false)
  })
})
