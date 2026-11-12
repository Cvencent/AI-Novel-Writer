import { describe, expect, it } from 'vitest'
import {
  decryptModelProfiles,
  encryptModelProfiles,
  resolveModelSecretCipher,
  type ModelSecretCipher,
  type StoredModelProfile,
} from '../model-secret-store'
import type { ModelProfile } from '../../../src/shared/ipc-channels'

function fakeCipher(overrides: Partial<ModelSecretCipher> = {}): ModelSecretCipher {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`enc:${plaintext}`, 'utf-8'),
    decryptString: (encrypted: Buffer) => {
      const text = encrypted.toString('utf-8')
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext')
      return text.slice(4)
    },
    ...overrides,
  }
}

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'm1',
    name: 'Model',
    provider: 'openai',
    protocol: 'openai',
    modelName: 'gpt',
    apiKey: 'sk-secret',
    baseUrl: 'https://api.example.com',
    temperature: 0.7,
    maxTokens: 1024,
    purposes: ['generation'],
    ...overrides,
  }
}

describe('resolveModelSecretCipher', () => {
  it('returns null for undefined/null candidate (test electron mock without safeStorage)', () => {
    expect(resolveModelSecretCipher(undefined)).toBeNull()
    expect(resolveModelSecretCipher(null)).toBeNull()
  })

  it('returns null when OS encryption is unavailable', () => {
    expect(resolveModelSecretCipher(fakeCipher({ isEncryptionAvailable: () => false }))).toBeNull()
  })

  it('returns null when availability check throws', () => {
    expect(resolveModelSecretCipher(fakeCipher({ isEncryptionAvailable: () => { throw new Error('keyring') } }))).toBeNull()
  })

  it('returns the candidate when encryption is available', () => {
    const cipher = fakeCipher()
    expect(resolveModelSecretCipher(cipher)).toBe(cipher)
  })
})

describe('encryptModelProfiles', () => {
  it('encrypts apiKey, clears plaintext, preserves other fields', () => {
    const [stored] = encryptModelProfiles([profile()], fakeCipher())
    expect(stored.apiKey).toBe('')
    expect(stored.apiKeyEncrypted).toBe(Buffer.from('enc:sk-secret', 'utf-8').toString('base64'))
    expect(stored.id).toBe('m1')
    expect(stored.baseUrl).toBe('https://api.example.com')
  })

  it('leaves empty apiKey untouched (local endpoints need no key)', () => {
    const [stored] = encryptModelProfiles([profile({ apiKey: '' })], fakeCipher())
    expect(stored.apiKey).toBe('')
    expect(stored.apiKeyEncrypted).toBeUndefined()
  })

  it('falls back to plaintext when cipher is null', () => {
    const [stored] = encryptModelProfiles([profile()], null)
    expect(stored.apiKey).toBe('sk-secret')
    expect(stored.apiKeyEncrypted).toBeUndefined()
  })

  it('falls back to plaintext when encryptString throws', () => {
    const cipher = fakeCipher({ encryptString: () => { throw new Error('keychain failed') } })
    const [stored] = encryptModelProfiles([profile()], cipher)
    expect(stored.apiKey).toBe('sk-secret')
    expect(stored.apiKeyEncrypted).toBeUndefined()
  })
})

describe('decryptModelProfiles', () => {
  it('round-trips an encrypted profile back to plaintext', () => {
    const cipher = fakeCipher()
    const stored = encryptModelProfiles([profile()], cipher)
    const [restored] = decryptModelProfiles(stored, cipher)
    expect(restored.apiKey).toBe('sk-secret')
    expect(restored).not.toHaveProperty('apiKeyEncrypted')
  })

  it('preserves legacy plaintext profiles (no apiKeyEncrypted)', () => {
    const legacy: StoredModelProfile[] = [profile()]
    const [restored] = decryptModelProfiles(legacy, fakeCipher())
    expect(restored.apiKey).toBe('sk-secret')
  })

  it('preserves legacy plaintext even when cipher is null', () => {
    const [restored] = decryptModelProfiles([profile()], null)
    expect(restored.apiKey).toBe('sk-secret')
  })

  it('blanks apiKey when ciphertext exists but cipher is unavailable', () => {
    const stored = encryptModelProfiles([profile()], fakeCipher())
    const [restored] = decryptModelProfiles(stored, null)
    expect(restored.apiKey).toBe('')
    expect(restored).not.toHaveProperty('apiKeyEncrypted')
  })

  it('blanks apiKey when decryption fails (never feeds ciphertext to providers)', () => {
    const stored = encryptModelProfiles([profile()], fakeCipher())
    const broken = fakeCipher({ decryptString: () => { throw new Error('corrupt') } })
    const [restored] = decryptModelProfiles(stored, broken)
    expect(restored.apiKey).toBe('')
    expect(restored).not.toHaveProperty('apiKeyEncrypted')
  })
})