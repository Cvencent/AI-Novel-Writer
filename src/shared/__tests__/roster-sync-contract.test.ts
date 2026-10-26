import { describe, expect, it } from 'vitest'
import {
  buildRosterSyncPrompt,
  extractRosterSyncPlan,
  mergeRosterSyncPlan,
  type RosterSyncPlan,
} from '../roster-sync-contract'
import type { CharacterRosterEntry } from '../character-roster'

const entry = (name: string, characterId?: string): CharacterRosterEntry => ({
  characterId, name, role: 'supporting', gender: '', age: '', appearance: '', personality: '',
  background: '', abilities: '', motivation: '',
  relationships: [{ target: '旧角色', relation: '旧关系' }],
  arc: '', notes: '',
})

describe('extractRosterSyncPlan', () => {
  it('parses entries and sanitizes relationships', () => {
    const plan = extractRosterSyncPlan(JSON.stringify({
      entries: [
        { name: '林澈', relationships: [{ targetName: '陆秉文', relation: '对立', description: '复核被拒' }, { bad: true }] },
        { noName: true },
      ],
      notes: ['关系变化说明'],
    }))
    expect(plan?.entries).toHaveLength(1)
    expect(plan?.entries[0]!.relationships).toHaveLength(1)
    expect(plan?.entries[0]!.relationships[0]!.target).toBe('陆秉文')
    expect(plan?.notes).toEqual(['关系变化说明'])
  })

  it('returns null with no valid entries', () => {
    expect(extractRosterSyncPlan('{"entries":[]}')).toBeNull()
    expect(extractRosterSyncPlan('broken')).toBeNull()
  })
})

describe('mergeRosterSyncPlan', () => {
  const current = [entry('林澈'), entry('陆秉文', 'draft:11111111-2222-4333-8444-555555555555')]
  const plan: RosterSyncPlan = {
    entries: [
      { name: '林澈', relationships: [{ target: '陆秉文', relation: '申报对立' }] },
      { characterId: 'draft:11111111-2222-4333-8444-555555555555', name: '陆秉文', relationships: [] },
    ],
    notes: [],
  }

  it('merges by id first then name, replacing only relationships', () => {
    const { entries, changed } = mergeRosterSyncPlan(current, plan)
    expect(changed).toEqual(['林澈', '陆秉文'])
    expect(entries[0]!.relationships[0]!.relation).toBe('申报对立')
    expect(entries[0]!.role).toBe('supporting')
    expect(entries[0]!.personality).toBe('')
    expect(entries[1]!.relationships).toEqual([])
    expect(entries[1]!.background).toBe('')
  })

  it('keeps entries without a matching patch untouched', () => {
    const { entries, changed } = mergeRosterSyncPlan(current, { entries: [{ name: '林澈', relationships: [] }], notes: [] })
    expect(changed).toEqual(['林澈'])
    expect(entries[1]!.relationships[0]!.relation).toBe('旧关系')
  })
})

describe('buildRosterSyncPrompt', () => {
  it('names the prose as the revision source and demands JSON', () => {
    const prompt = buildRosterSyncPrompt({ mergedProse: '正文', roster: '名单', language: 'zh-CN' })
    expect(prompt).toContain('修稿后正文')
    expect(prompt).toContain('只输出 JSON')
  })
})


