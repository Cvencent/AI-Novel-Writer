import type { CharacterData } from '../../electron/repositories/character-repository'
import type {
  CharacterRosterEntry,
  CharacterRosterRelationship,
} from '../shared/character-roster'
import { normalizeCharacterRole } from '../shared/character-role'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseStructuredRelationships(value: string): CharacterRosterRelationship[] | null {
  const text = value.trim()
  if (!text) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (Array.isArray(parsed)) {
    const relationships: CharacterRosterRelationship[] = []
    for (const raw of parsed) {
      if (!isRecord(raw) || typeof raw.target !== 'string' || typeof raw.relation !== 'string') return null
      relationships.push({ target: raw.target.trim(), relation: raw.relation.trim(), ...(typeof raw.targetCharacterId === 'string' ? { targetCharacterId: raw.targetCharacterId } : {}) })
    }
    return relationships
  }
  if (!isRecord(parsed) || 'target' in parsed || 'relation' in parsed) return null
  return Object.entries(parsed).flatMap(([target, relation]) => (
    target.trim() && typeof relation === 'string' && relation.trim()
      ? [{ target: target.trim(), relation: relation.trim() }]
      : []
  ))
}

/**
 * Renderer/workflow 侧只负责把现有角色卡形状送入唯一 roster seam；最终
 * schema、闭包与事务校验都留在主进程 CharacterRosterRepository。
 */
/**
 * 身份 schema 项目要求每个角色都有稳定 ID。模型新增角色时只能给出名字，
 * 这里为它分配一个 draft:<uuid> ID（与 UI「新建角色」同一形式），
 * 提交后由主进程把它登记为稳定身份。已有角色必须原样保留 ID。
 */
export function assignCharacterIdForNewCard(
  card: CharacterData,
  mintId: () => string,
): CharacterData {
  return card.characterId?.trim() ? card : { ...card, characterId: `draft:${mintId()}` }
}

export function characterRosterEntryFromCard(card: CharacterData): CharacterRosterEntry {
  const relationships = parseStructuredRelationships(card.relationships)
  return {
    characterId: card.characterId,
    name: card.name.trim(),
    role: card.role,
    gender: card.gender,
    age: card.age,
    appearance: card.appearance,
    personality: card.personality,
    background: card.background,
    abilities: card.abilities,
    motivation: card.motivation,
    relationships: relationships ?? [],
    arc: card.arc,
    notes: card.notes,
    ...(card.currentState ? { currentState: card.currentState } : {}),
    ...(relationships === null && card.relationships.trim()
      ? { legacyRelationshipNotes: card.relationships.trim() }
      : {}),
  }
}

export function characterCardFromRosterEntry(entry: CharacterRosterEntry): CharacterData {
  return {
    characterId: entry.characterId,
    name: entry.name,
    role: normalizeCharacterRole(entry.role),
    gender: entry.gender,
    age: entry.age,
    appearance: entry.appearance,
    personality: entry.personality,
    background: entry.background,
    abilities: entry.abilities,
    motivation: entry.motivation,
    relationships: entry.relationships.length > 0 ? JSON.stringify(entry.relationships) : entry.legacyRelationshipNotes ?? '',
    arc: entry.arc,
    notes: entry.notes,
    ...(entry.currentState ? { currentState: entry.currentState } : {}),
  }
}

export function characterRosterEntriesFromCards(cards: readonly CharacterData[]): CharacterRosterEntry[] {
  return cards.map(characterRosterEntryFromCard)
}
