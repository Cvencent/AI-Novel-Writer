import { describe, expect, it } from 'vitest'
import { redactPersistedError } from '../provider-error-redaction'

describe('redactPersistedError', () => {
  it('returns undefined/empty unchanged', () => {
    expect(redactPersistedError(undefined, { apiKey: 'sk-secret-key' })).toBeUndefined()
    expect(redactPersistedError('', { apiKey: 'sk-secret-key' })).toBe('')
  })

  it('redacts the exact model key echoed in a 401 body', () => {
    const model = { apiKey: 'sk-proj-abc123def456' }
    const message = 'API 调用失败 (401): Incorrect API key provided: sk-proj-abc123def456.'
    const redacted = redactPersistedError(message, model)
    expect(redacted).not.toContain('sk-proj-abc123def456')
    expect(redacted).toContain('[REDACTED]')
    expect(redacted).toContain('401')
  })

  it('redacts every occurrence of the key', () => {
    const model = { apiKey: 'secret-token-99' }
    expect(redactPersistedError('secret-token-99 / secret-token-99', model)).toBe('[REDACTED] / [REDACTED]')
  })

  it('masks generic sk- and Bearer patterns even without the exact key', () => {
    const redacted = redactPersistedError('key sk-abcdefgh12345678 Authorization: Bearer xyz.token-998877', { apiKey: '' })
    expect(redacted).not.toContain('sk-abcdefgh12345678')
    expect(redacted).not.toContain('xyz.token-998877')
    expect(redacted).toContain('Bearer [REDACTED]')
  })

  it('ignores short keys to avoid mangling unrelated text', () => {
    expect(redactPersistedError('a short sk note', { apiKey: 'sk' })).toBe('a short sk note')
  })

  it('truncates oversized response bodies', () => {
    const redacted = redactPersistedError('x'.repeat(5000), { apiKey: '' })
    expect(redacted?.length).toBeLessThanOrEqual(2001)
    expect(redacted?.endsWith('…')).toBe(true)
  })

  it('leaves ordinary diagnostic errors intact', () => {
    expect(redactPersistedError('API 调用失败 (500): upstream timeout', { apiKey: 'sk-secret-key' }))
      .toBe('API 调用失败 (500): upstream timeout')
  })
})