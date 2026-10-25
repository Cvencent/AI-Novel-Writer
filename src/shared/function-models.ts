import type { ModelProfile } from './ipc-channels'

/**
 * 按功能分配模型的 key。设置页每行一项；运行时按
 * 「功能配置 → 全局默认 → 任一生成模型」解析。
 */
export type FunctionModelKey =
  | 'outline_generation'
  | 'synopsis_generation'
  | 'blueprint_generation'
  | 'draft_generation'
  | 'outline_review'
  | 'synopsis_review'
  | 'blueprint_review'
  | 'draft_review'
  | 'editor_ai'
  | 'agent_chat'

export const FUNCTION_MODEL_KEYS = [
  'outline_generation',
  'synopsis_generation',
  'blueprint_generation',
  'draft_generation',
  'outline_review',
  'synopsis_review',
  'blueprint_review',
  'draft_review',
  'editor_ai',
  'agent_chat',
] as const satisfies readonly FunctionModelKey[]

/** 每个功能项的双语名称，设置页直接用 text(...labels) 渲染。 */
export const FUNCTION_MODEL_LABELS: Record<FunctionModelKey, readonly [string, string]> = {
  outline_generation: ['粗纲生成', 'Outline generation'],
  synopsis_generation: ['细纲生成', 'Detailed outline generation'],
  blueprint_generation: ['蓝图生成', 'Blueprint generation'],
  draft_generation: ['正文生成', 'Chapter writing'],
  outline_review: ['粗纲审核', 'Outline review'],
  synopsis_review: ['细纲审核', 'Detailed outline review'],
  blueprint_review: ['蓝图审核', 'Blueprint review'],
  draft_review: ['正文审核', 'Chapter review'],
  editor_ai: ['编辑器 AI', 'Editor AI'],
  agent_chat: ['AI 助手对话', 'AI assistant chat'],
}

/** 全局配置中的映射；缺 key 视为「跟随默认」。 */
export type FunctionModelIds = Partial<Record<FunctionModelKey, string | null>>

type GenerationCandidate = Pick<ModelProfile, 'id' | 'purposes'>

function isFunctionModelKey(value: unknown): value is FunctionModelKey {
  return typeof value === 'string' && (FUNCTION_MODEL_KEYS as readonly string[]).includes(value)
}

/** 未知 key、空串与非字符串一律丢弃；空串归一为 null（跟随默认）。 */
export function normalizeFunctionModelIds(value: unknown): FunctionModelIds {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const source = value as Record<string, unknown>
  const result: FunctionModelIds = {}
  for (const [key, raw] of Object.entries(source)) {
    if (!isFunctionModelKey(key)) continue
    if (raw === null) { result[key] = null; continue }
    if (typeof raw !== 'string') continue
    result[key] = raw.trim() === '' ? null : raw
  }
  return result
}

/** id 必须指向一个带 generation 用途的已配置模型。 */
export function usableGenerationModelId(
  models: readonly GenerationCandidate[],
  id: string | null | undefined,
): string | null {
  return id && models.some(model => model.id === id && model.purposes.includes('generation'))
    ? id
    : null
}

/** 功能模型解析：ids[key] → defaultModelId → 第一个生成模型。 */
export function preferredFunctionModelId(
  models: readonly GenerationCandidate[],
  ids: FunctionModelIds,
  key: FunctionModelKey,
  defaultModelId: string | null | undefined,
): string | null {
  return usableGenerationModelId(models, ids[key])
    ?? usableGenerationModelId(models, defaultModelId)
    ?? models.find(model => model.purposes.includes('generation'))?.id
    ?? null
}
