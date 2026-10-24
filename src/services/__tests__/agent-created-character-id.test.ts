import { describe, expect, it } from 'vitest'
import { assignCharacterIdForNewCard } from '../character-roster-client'
import type { CharacterData } from '../../../electron/repositories/character-repository'

const base: CharacterData = { name: '程立', role: 'minor', gender: '男', age: '18', appearance: '', personality: '话少', background: '废脉班学生', abilities: '', motivation: '改回评级', relationships: '', arc: '', notes: '' }

describe('model-created characters must receive a stable identity', () => {
  it('assigns a draft id when the model only supplies a name', () => {
    const card = assignCharacterIdForNewCard(base, () => 'abc-123')
    expect(card.characterId).toBe('draft:abc-123')
    expect(card.name).toBe('程立')
  })
  it('keeps an existing identity untouched', () => {
    const existing = { ...base, characterId: 'char-existing' }
    expect(assignCharacterIdForNewCard(existing, () => 'should-not-be-used').characterId).toBe('char-existing')
  })
})
