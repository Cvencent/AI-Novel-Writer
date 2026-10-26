import { describe, expect, it } from 'vitest'
import { removeRecoveryFields } from '../recovery-cleanup'

describe('removeRecoveryFields', () => {
  it('removes every checkpoint field of the requested kinds and keeps the rest', () => {
    const data = {
      synopsis_incomplete: true,
      synopsis_result: 'draft',
      synopsis_covered_to: 10,
      synopsis_generation_handle: {},
      world_building_incomplete: true,
      world_building_partial_result: 'draft-w',
      premise_result: 'premise-body',
      unrelated: 1,
    }
    const next = removeRecoveryFields(data, ['synopsis'])
    expect(next.synopsis_incomplete).toBeUndefined()
    expect(next.synopsis_result).toBeUndefined()
    expect(next.synopsis_covered_to).toBeUndefined()
    expect(next.synopsis_generation_handle).toBeUndefined()
    expect(next.world_building_incomplete).toBe(true)
    expect(next.premise_result).toBe('premise-body')
    expect(next.unrelated).toBe(1)
    // 原对象不被改写
    expect(data.synopsis_incomplete).toBe(true)
  })

  it('clears both kinds at once', () => {
    const data = {
      synopsis_incomplete: true,
      synopsis_result: 'a',
      world_building_partial_result: 'b',
      world_building_generation_handle: {},
      premise_result: 'p',
    }
    const next = removeRecoveryFields(data, ['synopsis', 'worldbuilding'])
    expect(next.synopsis_incomplete).toBeUndefined()
    expect(next.world_building_partial_result).toBeUndefined()
    expect(next.world_building_generation_handle).toBeUndefined()
    expect(next.premise_result).toBe('p')
  })
})
