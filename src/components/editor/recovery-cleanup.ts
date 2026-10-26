/**
 * partial_arch.json 里「生成到一半的恢复稿」字段清理。
 * 每种恢复稿的字段写在一处，丢弃单份与一键清除共用，避免清单漂移。
 */
export type RecoveryKind = 'synopsis' | 'worldbuilding'

export const RECOVERY_FIELDS: Record<RecoveryKind, readonly string[]> = {
  synopsis: [
    'synopsis_incomplete',
    'synopsis_result',
    'synopsis_covered_to',
    'synopsis_range',
    'synopsis_db_hash',
    'synopsis_body_hash',
    'synopsis_generation_handle',
  ],
  worldbuilding: [
    'world_building_incomplete',
    'world_building_partial_result',
    'world_building_generation_handle',
  ],
}

/** 返回删掉指定种类恢复稿字段后的浅拷贝；原对象不改写。 */
export function removeRecoveryFields(
  data: Record<string, unknown>,
  kinds: readonly RecoveryKind[],
): Record<string, unknown> {
  const next = { ...data }
  for (const kind of kinds) {
    for (const field of RECOVERY_FIELDS[kind]) delete next[field]
  }
  return next
}
