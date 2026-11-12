import type { ModelProfile } from '../../src/shared/ipc-channels'

/**
 * 落盘形态：apiKey 加密后清空，密文以 base64 存于 apiKeyEncrypted。
 * 旧档案只有明文 apiKey（无 apiKeyEncrypted），读取时原样兼容。
 */
export type StoredModelProfile = ModelProfile & { apiKeyEncrypted?: string }

export interface ModelSecretCipher {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(encrypted: Buffer): string
}

/**
 * 仅在操作系统密钥库可用时返回 cipher；否则返回 null，调用方退回明文落盘
 * （与改造前行为一致，避免在无 keyring 的 Linux 上把用户模型配置写丢）。
 * 入参允许 undefined：测试里的 electron mock 不含 safeStorage。
 */
export function resolveModelSecretCipher(
  candidate: ModelSecretCipher | undefined | null,
): ModelSecretCipher | null {
  try {
    if (candidate && typeof candidate.isEncryptionAvailable === 'function' && candidate.isEncryptionAvailable()) {
      return candidate
    }
  } catch {
    // 密钥库查询本身抛错时按不可用处理。
  }
  return null
}

/** 写盘前加密 apiKey；空 Key 或无 cipher 时原样保留明文。 */
export function encryptModelProfiles(
  models: ModelProfile[],
  cipher: ModelSecretCipher | null,
): StoredModelProfile[] {
  return models.map((model) => {
    const plaintext = model.apiKey ?? ''
    if (!plaintext || !cipher) return model
    try {
      const blob = cipher.encryptString(plaintext).toString('base64')
      if (!blob) return model
      return { ...model, apiKey: '', apiKeyEncrypted: blob }
    } catch {
      return model
    }
  })
}

/**
 * 读盘后还原 apiKey：有密文则解密；无 cipher 或解密失败时清空 Key
 * （用户需重新填写），绝不把密文当明文交给下游服务商。
 */
export function decryptModelProfiles(
  stored: StoredModelProfile[],
  cipher: ModelSecretCipher | null,
): ModelProfile[] {
  return stored.map((model) => {
    const { apiKeyEncrypted, ...base } = model
    if (!apiKeyEncrypted) return base
    if (!cipher) return { ...base, apiKey: '' }
    try {
      return { ...base, apiKey: cipher.decryptString(Buffer.from(apiKeyEncrypted, 'base64')) }
    } catch {
      return { ...base, apiKey: '' }
    }
  })
}