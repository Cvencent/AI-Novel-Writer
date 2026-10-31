import type { CharacterStateFieldProvenance, CharacterStateTextField } from './character-roster'
import type { FinalizedSourceIdentity } from './finalized-continuity'
import { isContentHash, isFinalizedSourceIdentity, sameProjectEpoch, type ProjectEpoch } from './source-ref'

export type CharacterResolution =
  | { status: 'resolved'; characterId: string }
  | { status: 'ambiguous'; candidateIds: readonly string[]; originalText: string }
  | { status: 'unresolved'; originalText: string }
export interface CharacterAlias extends ProjectEpoch {
  characterId: string; displayText: string; sourceId: string; fromRevision: number; toRevision?: number
}
/** Input candidates come from a project/source-scoped exact alias lookup; never similarity. */
export function resolveCharacterIdentity(originalText: string, candidateIds: readonly string[]): CharacterResolution {
  if (!originalText || candidateIds.some(id => !id)) throw new Error('INVALID_CHARACTER_LOOKUP')
  const unique = [...new Set(candidateIds)]
  return unique.length === 1 ? { status: 'resolved', characterId: unique[0]! }
    : unique.length > 1 ? { status: 'ambiguous', candidateIds: unique, originalText }
      : { status: 'unresolved', originalText }
}
export function assertCharacterResolution(resolution: CharacterResolution, exactCandidateIds: readonly string[]): void {
  const ids = [...new Set(exactCandidateIds)]
  if (ids.some(id => !id) || !(resolution.status === 'resolved' && ids.length === 1 && resolution.characterId === ids[0]
    || resolution.status === 'unresolved' && ids.length === 0 && Boolean(resolution.originalText)
    || resolution.status === 'ambiguous' && ids.length > 1 && Boolean(resolution.originalText)
      && resolution.candidateIds.length === ids.length && new Set(resolution.candidateIds).size === ids.length
      && resolution.candidateIds.every(id => ids.includes(id)))) throw new Error('INVALID_CHARACTER_RESOLUTION')
}
export interface CharacterProposal extends ProjectEpoch {
  proposalId: string; resolution: CharacterResolution
  origin: 'generated' | 'derived' | 'legacy'; status: 'pending' | 'accepted' | 'rejected'
  sourceHash: string
}
export interface DerivedSourceOrder {
  continuityEpoch: string; chapterNumber: number; authoritativeFinalizationRevision: number
}
export interface CharacterFieldSnapshot extends ProjectEpoch {
  characterId: string; field: CharacterStateTextField; revision: number; value: string; valueHash: string
  provenance: CharacterStateFieldProvenance; sourceOrder?: DerivedSourceOrder
}
export interface DerivedCharacterPatch extends ProjectEpoch {
  characterId: string; field: CharacterStateTextField; value: string; valueHash: string
  baseFieldRevision: number; baseValueHash: string; baseProvenance: CharacterStateFieldProvenance
  source: FinalizedSourceIdentity; sourceOrder: DerivedSourceOrder
}
const sameSource = (a: FinalizedSourceIdentity, b: FinalizedSourceIdentity): boolean =>
  a.draftId === b.draftId && a.finalizationId === b.finalizationId && a.chapterNumber === b.chapterNumber && a.contentHash === b.contentHash
const sameProvenance = (a: CharacterStateFieldProvenance, b: CharacterStateFieldProvenance): boolean =>
  a.kind === 'legacy' && b.kind === 'legacy'
  || a.kind === 'author' && b.kind === 'author' && a.chapterNumber === b.chapterNumber
  || a.kind === 'derived' && b.kind === 'derived' && sameSource(a.source, b.source)
/**
 * 跨 epoch 比较：把已验证来源的旧 epoch 记法按 generation 计数器对齐。
 *
 * A verified transfer origin shares the copied projection generation counter: `${origin}:G` is treated as `${projectId}:G`.
 * 返回 `newer`（generation 严格推进）、`equal`（generation 持平）或 `stale`（无法证明推进）。
 * 只有 `newer` 才不再按章/修订排序——`equal` 仍然要比，否则同代旧回包会覆盖更新的章。
 */
type ContinuityAdvance = 'newer' | 'equal' | 'stale'
function projectContinuityAdvance(projectId: string, previous: string, current: string, originProjectId?: string): ContinuityAdvance {
  const generation = (epoch: string, project: string) => {
    if (!project || !epoch.startsWith(`${project}:`)) return null
    const value = epoch.slice(project.length + 1)
    return /^(0|[1-9][0-9]*)$/u.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null
  }
  const after = generation(current, projectId)
  if (after === null) return 'stale'
  const before = generation(previous, projectId)
  if (before !== null) return after > before ? 'newer' : after === before ? 'equal' : 'stale'
  const fromOrigin = originProjectId ? generation(previous, originProjectId) : null
  if (fromOrigin === null) return 'stale'
  return after > fromOrigin ? 'newer' : after === fromOrigin ? 'equal' : 'stale'
}
export type DerivedPatchDecision = 'apply-derived' | 'already-applied' | 'proposal-required' | 'source-conflict' | 'field-conflict'
/** Caller recomputes hashes and reads field/authority in the same synchronous commit transaction. */
export function decideDerivedPatch(current: CharacterFieldSnapshot, patch: DerivedCharacterPatch,
  authority: { source: FinalizedSourceIdentity; order: DerivedSourceOrder; originProjectId?: string }): DerivedPatchDecision {
  const order = patch.sourceOrder
  if (!sameProjectEpoch(current, patch) || !isFinalizedSourceIdentity(patch.source) || !isFinalizedSourceIdentity(authority.source) || !sameSource(patch.source, authority.source)
    || !isContentHash(patch.source.contentHash) || !order.continuityEpoch
    || order.continuityEpoch !== authority.order.continuityEpoch || order.chapterNumber !== authority.order.chapterNumber
    || order.chapterNumber !== patch.source.chapterNumber || order.authoritativeFinalizationRevision !== authority.order.authoritativeFinalizationRevision
    || !Number.isSafeInteger(order.chapterNumber) || order.chapterNumber < 1
    || !Number.isSafeInteger(order.authoritativeFinalizationRevision) || order.authoritativeFinalizationRevision < 1) return 'source-conflict'
  if (current.characterId !== patch.characterId || current.field !== patch.field || !patch.characterId
    || !isContentHash(patch.valueHash) || !isContentHash(patch.baseValueHash)
    || !Number.isSafeInteger(current.revision) || current.revision < 0) return 'field-conflict'
  const previous = current.sourceOrder
  if (current.provenance.kind === 'derived' && (!previous
    || previous.chapterNumber !== current.provenance.source.chapterNumber)) return 'source-conflict'
  if (previous && (!previous.continuityEpoch || !Number.isSafeInteger(previous.chapterNumber) || previous.chapterNumber < 1
    || !Number.isSafeInteger(previous.authoritativeFinalizationRevision) || previous.authoritativeFinalizationRevision < 1)) return 'source-conflict'
  if (previous) {
    const sameEpoch = previous.continuityEpoch === order.continuityEpoch
    // 只有「作者已验证来源 + 旧 era 记法 + generation 严格推进」才允许跨 epoch 直接采信；
    // generation 持平（可能是同一代旧回包）仍要走章/修订排序，避免旧的回包覆盖更新的章。
    const advance: ContinuityAdvance = sameEpoch
      ? 'equal'
      : current.provenance.kind === 'derived'
        ? projectContinuityAdvance(patch.projectId, previous.continuityEpoch, order.continuityEpoch, authority.originProjectId)
        : 'stale'
    if (advance === 'stale') return 'source-conflict'
    if (advance !== 'newer' && (previous.chapterNumber > order.chapterNumber
      || previous.chapterNumber === order.chapterNumber && previous.authoritativeFinalizationRevision > order.authoritativeFinalizationRevision)) return 'source-conflict'
  }
  if (current.provenance.kind === 'derived' && sameSource(current.provenance.source, patch.source)
    && current.valueHash === patch.valueHash) return 'already-applied'
  if (current.revision !== patch.baseFieldRevision || current.valueHash !== patch.baseValueHash
    || !sameProvenance(current.provenance, patch.baseProvenance)) return 'field-conflict'
  // legacy 与 author 都受保护：来源未知的旧值可能是早期作者输入，不能静默覆盖；
  // 定稿正文只能提出待确认提议，由作者决定。
  if (current.provenance.kind !== 'derived' && !(current.provenance.kind === 'legacy' && current.value === '')) return 'proposal-required'
  return 'apply-derived'
}
/** Exact source/value-scoped dedupe; a new finalization source may propose again. */
export function rejectedCharacterProposalKey(patch: DerivedCharacterPatch): string {
  return JSON.stringify([patch.projectId, patch.characterId, patch.field, patch.source.contentHash, patch.valueHash])
}

import type { SourceRef } from './source-ref'

export interface ScopedCharacterAlias {
  characterId: string
  name: string
  projectId: string
  sourceKey: string
  validFrom: number
  validThrough: number | null
}
export type ScopedCharacterResolution =
  | { status: 'resolved'; characterId: string }
  | { status: 'ambiguous'; candidateIds: string[] }
  | { status: 'unresolved'; candidateIds: string[] }
export interface CharacterLookup { name: string; projectId: string; sourceKey?: string; revision: number }
/** Names alone are never proof of identity. Matching is exact, scoped and versioned. */
export function resolveScopedCharacterIdentity(aliases: readonly ScopedCharacterAlias[], lookup: CharacterLookup): ScopedCharacterResolution {
  const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
  const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
  if (!lookup || !nonempty(lookup.name) || !nonempty(lookup.projectId) || !revision(lookup.revision)
    || lookup.sourceKey !== undefined && !nonempty(lookup.sourceKey) || !Array.isArray(aliases)
    || aliases.some(alias => !alias || !nonempty(alias.characterId) || !nonempty(alias.name) || !nonempty(alias.projectId)
      || !nonempty(alias.sourceKey) || !revision(alias.validFrom)
      || alias.validThrough !== null && (!revision(alias.validThrough) || alias.validThrough < alias.validFrom))) throw new Error('INVALID_CHARACTER_LOOKUP')
  const candidates = [...new Set(aliases.filter(alias => alias.name === lookup.name && alias.projectId === lookup.projectId
    && alias.validFrom <= lookup.revision && (alias.validThrough === null || lookup.revision <= alias.validThrough)
    && (!lookup.sourceKey || alias.sourceKey === lookup.sourceKey)).map(alias => alias.characterId))].sort()
  if (candidates.length > 1) return { status: 'ambiguous', candidateIds: candidates }
  if (candidates.length === 1 && lookup.sourceKey) return { status: 'resolved', characterId: candidates[0] }
  return { status: 'unresolved', candidateIds: candidates }
}
export type CharacterStaticProvenance =
  | { kind: 'legacy'; sourceKey: string }
  | { kind: 'author'; source: SourceRef }
  | { kind: 'generated' | 'derived'; source: SourceRef; modelRevision: string }
export interface CharacterApproval {
  operationId: string
  expectedRevision: number
  source: CharacterStaticProvenance
  /** Main-process explicit author action, never inferred from generated text. */
  action: 'author-edit' | 'adopt-generated' | 'adopt-import' | 'confirm-identity'
}
