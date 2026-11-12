import type { ModelProfile } from '../../src/shared/ipc-channels'

/**
 * 服务商的 401 响应体常会回显 API Key（如 "Incorrect API key provided: sk-..."）。
 * 历史记录会落盘到 SQLite，必须先把密钥抹掉再持久化，避免明文 Key 进入日志库。
 * 优先精确替换本模型的真实 Key，再兜底常见 Key 形态，并截断超长响应体。
 */
export function redactPersistedError(message: string | undefined, model: Pick<ModelProfile, 'apiKey'>): string | undefined {
  if (!message) return message
  let redacted = message
  const key = model.apiKey?.trim()
  if (key && key.length >= 6) redacted = redacted.split(key).join('[REDACTED]')
  redacted = redacted
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [REDACTED]')
  return redacted.length > 2000 ? `${redacted.slice(0, 2000)}…` : redacted
}