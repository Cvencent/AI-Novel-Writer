import type { CharacterRosterEntry, CharacterRosterRelationship } from './character-roster'

/**
 * 修稿合并后的人物关系同步契约。
 *
 * 模型收到「修稿后正文 + 当前完整名单」，输出要更新的条目；
 * 代码层只在「同一 characterId/name 的现有条目」上合并关系字段，
 * 不认识的条目被丢弃，身份字段（性别/年龄等）永远保留原值，
 * 避免一次模型输出改写整张角色卡。
 */
export interface RosterSyncEntryPatch {
  /** 与现有条目匹配：优先 characterId，其次 name。 */
  characterId?: string
  name: string
  /** 完整替换该条目的结构化关系列表（可空数组=清除全部关系）。 */
  relationships: CharacterRosterRelationship[]
  /** 该条目的关系变化说明（写进 notes 尾部或日志）。 */
  changeNote?: string
}

export interface RosterSyncPlan {
  entries: RosterSyncEntryPatch[]
  notes: string[]
}

function sanitizeRelationship(value: unknown): CharacterRosterRelationship | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const target = typeof record.target === 'string' ? record.target.trim()
    : typeof record.targetName === 'string' ? record.targetName.trim() : ''
  const relation = typeof record.relation === 'string' ? record.relation.trim() : ''
  if (!target || !relation) return null
  const out: Record<string, unknown> = { target, relation }
  const targetCharacterId = typeof record.targetCharacterId === 'string' ? record.targetCharacterId.trim() : ''
  if (targetCharacterId) out.targetCharacterId = targetCharacterId
  return out as unknown as CharacterRosterRelationship
}

export function extractRosterSyncPlan(raw: string): RosterSyncPlan | null {
  const text = raw.trim().replace(/^`json`?/iu, '').replace(/``?/gu, '')
  let payload: unknown = null
  try { payload = JSON.parse(text) } catch { void 0 }
  if (payload === null) {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) { try { payload = JSON.parse(text.slice(start, end + 1)) } catch { void 0 } }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  const list = Array.isArray(record.entries) ? record.entries : []
  const entries: RosterSyncEntryPatch[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const entry = item as Record<string, unknown>
    const characterId = typeof entry.characterId === 'string' && entry.characterId.trim() ? entry.characterId.trim() : undefined
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (!characterId && !name) continue
    const relationships = Array.isArray(entry.relationships)
      ? entry.relationships.map(sanitizeRelationship).filter((item): item is CharacterRosterRelationship => item !== null)
      : []
    entries.push({
      characterId,
      name,
      relationships,
      changeNote: typeof entry.changeNote === 'string' && entry.changeNote.trim() ? entry.changeNote.trim() : undefined,
    })
  }
  if (entries.length === 0) return null
  const notes = Array.isArray(record.notes) ? record.notes.map(item => String(item).trim()).filter(Boolean) : []
  return { entries, notes }
}

/** 把模型补丁合并进现有名单：按 characterId → name 匹配；身份字段保留，关系整体替换。 */
export function mergeRosterSyncPlan(
  current: readonly CharacterRosterEntry[],
  plan: RosterSyncPlan,
): { entries: CharacterRosterEntry[]; changed: string[] } {
  const changed: string[] = []
  const entries = current.map(entry => {
    const patch = plan.entries.find(candidate => candidate.characterId
      ? candidate.characterId === entry.characterId
      : candidate.name === entry.name)
    if (!patch) return entry
    const relationships = patch.relationships
    const before = JSON.stringify(entry.relationships ?? [])
    const after = JSON.stringify(relationships)
    if (before === after) return entry
    changed.push(entry.name)
    return { ...entry, relationships }
  })
  return { entries, changed }
}

export function buildRosterSyncPrompt(input: {
  mergedProse: string
  roster: string
  language: 'zh-CN' | 'en-US'
}): string {
  const en = input.language === 'en-US'
  return [
    en
      ? 'The chapter prose was just revised by AI. Compare the merged prose with the current character roster and update only relationship entries that the revision actually changed (new relationships, changed relations, renames). Keep every unrelated entry untouched.'
      : '本章正文刚经过 AI 修稿/改写。请把修稿后的正文与当前人物名单对比，只更新这次修稿真正改动的关系（新增关系、关系变化、称呼变化）；未受影响的条目一律原样保留。',
    en
      ? 'Output JSON only: {"entries":[{"name":"...","relationships":[{"target":"...","relation":"...","description":"..."}],"changeNote":"..."}],"notes":["..."]}. Include a full relationships list for each touched entry. Never invent characters that do not exist in the roster.'
      : '只输出 JSON：{"entries":[{"name":"...","relationships":[{"target":"...","relation":"...","description":"..."}],"changeNote":"..."}],"notes":["..."]}。每个被触及的条目都要给出完整关系列表；不得发明名单里不存在的角色。',
    en ? '[Merged prose]' : '【修稿后正文】',
    input.mergedProse,
    en ? '[Current roster]' : '【当前人物名单】',
    input.roster,
  ].join('\n\n')
}


