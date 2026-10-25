import { describe, expect, it } from 'vitest'
import {
  FUNCTION_MODEL_KEYS,
  normalizeFunctionModelIds,
  preferredFunctionModelId,
  usableGenerationModelId,
  type FunctionModelKey,
} from '../function-models'
import type { ModelProfile } from '../ipc-channels'

const model = (id: string, purposes: ModelProfile['purposes'] = ['generation']): Pick<ModelProfile, 'id' | 'purposes'> => ({ id, purposes })

describe('FUNCTION_MODEL_KEYS', () => {
  it('exposes exactly the ten designed keys', () => {
    expect([...FUNCTION_MODEL_KEYS]).toEqual([
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
    ])
  })
})

describe('normalizeFunctionModelIds', () => {
  it('keeps known keys with string or null values and drops everything else', () => {
    expect(normalizeFunctionModelIds({
      draft_generation: 'model-a',
      editor_ai: null,
      unknown_key: 'model-b',
      agent_chat: 42,
    })).toEqual({ draft_generation: 'model-a', editor_ai: null })
  })

  it('treats empty strings as null and rejects non-record input', () => {
    expect(normalizeFunctionModelIds({ outline_review: '  ' })).toEqual({ outline_review: null })
    expect(normalizeFunctionModelIds(null)).toEqual({})
    expect(normalizeFunctionModelIds('nope')).toEqual({})
  })
})

describe('usableGenerationModelId', () => {
  it('accepts only ids present with a generation purpose', () => {
    const models = [model('gen'), model('embed', ['embedding'])]
    expect(usableGenerationModelId(models, 'gen')).toBe('gen')
    expect(usableGenerationModelId(models, 'embed')).toBeNull()
    expect(usableGenerationModelId(models, 'missing')).toBeNull()
    expect(usableGenerationModelId(models, null)).toBeNull()
  })
})

describe('preferredFunctionModelId', () => {
  const models = [model('gen-a'), model('gen-b')]
  const ids = { draft_generation: 'gen-b' } as Record<FunctionModelKey, string | null>

  it('prefers the configured function model', () => {
    expect(preferredFunctionModelId(models, ids, 'draft_generation', 'gen-a')).toBe('gen-b')
  })

  it('falls back to the default model when unconfigured', () => {
    expect(preferredFunctionModelId(models, {} as Record<FunctionModelKey, string | null>, 'editor_ai', 'gen-a')).toBe('gen-a')
  })

  it('falls back to the first generation model when the default is unusable', () => {
    expect(preferredFunctionModelId(models, {} as Record<FunctionModelKey, string | null>, 'editor_ai', 'missing')).toBe('gen-a')
    expect(preferredFunctionModelId(models, {} as Record<FunctionModelKey, string | null>, 'editor_ai', null)).toBe('gen-a')
  })

  it('returns null without any usable generation model', () => {
    expect(preferredFunctionModelId([], {} as Record<FunctionModelKey, string | null>, 'editor_ai', null)).toBeNull()
  })
})
