import { describe, expect, it } from 'vitest'
import { hasRequiredApiKey, isLocalModelEndpoint, parseHttpEndpoint } from '../provider-presets'

describe('local model endpoints', () => {
  it('treats Ollama and loopback hosts as keyless endpoints', () => {
    for (const model of [
      { provider: 'ollama', baseUrl: 'http://192.168.1.20:11434/v1', apiKey: '' },
      { provider: 'custom', baseUrl: 'http://localhost:1234/v1', apiKey: '' },
      { provider: 'custom', baseUrl: 'http://127.0.0.1:8000/v1', apiKey: '' },
      { provider: 'custom', baseUrl: 'http://[::1]:8000/v1', apiKey: '' },
    ]) {
      expect(isLocalModelEndpoint(model)).toBe(true)
      expect(hasRequiredApiKey(model)).toBe(true)
    }
  })

  it('still requires a key for cloud endpoints, and accepts a typed key anywhere', () => {
    expect(hasRequiredApiKey({ provider: 'custom', baseUrl: 'https://api.openai.com/v1', apiKey: '   ' })).toBe(false)
    expect(hasRequiredApiKey({ provider: 'custom', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x' })).toBe(true)
    // 明明填了 Key 的远端地址仍然是远端：连接测试按云端超时等。
    expect(isLocalModelEndpoint({ provider: 'custom', baseUrl: 'https://api.example.com/v1' })).toBe(false)
  })

  it('ignores unparseable and non-http base URLs when deciding locality', () => {
    expect(parseHttpEndpoint('  ')).toBeNull()
    expect(parseHttpEndpoint('ftp://localhost/v1')).toBeNull()
    expect(isLocalModelEndpoint({ provider: 'custom', baseUrl: 'not-a-url' })).toBe(false)
  })
})