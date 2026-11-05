import { CHARACTER_STATE_TEXT_FIELDS, type CharacterStateTextField } from './character-roster'
import { decideDerivedPatch, type CharacterFieldSnapshot, type DerivedSourceOrder } from './character-identity'
import { isFinalizedSourceIdentity, type ProjectEpoch } from './source-ref'

export type FinalizedContinuityFactCategory =
  | 'character-state'
  | 'timeline'
  | 'open-thread'
  /**
   * **记忆回指**（issue #167）：这条事实是「人物记得/想起某件事」这类**内部陈述**。
   *
   * 单独立一档而不是塞进 `plot`，理由是它和别的事实不同源：`plot` 陈述的是「正文里发生了什么」，
   * 而这条陈述的是「人物以为发生过什么」——后者可能根本没在前文发生过
   * （现场：第 78 章「记得温珩摆手让他别停」，而全书「摆手」只出现这一次）。
   *
   * ⚠️ 本档**不做判断**（判断「所指的事有没有发生」需要读前文，属内容判断，交模型：
   * `memory-anchor-review.ts`）。它只把这类事实**标出来**，让下游（起草前的最近摘要）
   * 知道「这一条是回忆，不是已发生」，也让按类取数的实现有机会区别对待。
   */
  | 'memory-callback'
  | 'plot'

/** Existing finalization receipt fields needed to bind derived material to immutable prose. */
export interface FinalizedSourceIdentity {
  draftId: number
  finalizationId: string
  chapterNumber: number
  contentHash: string
}

export type FinalizedProjectionStatus = 'current' | 'stale' | 'legacy'

export interface FinalizedSourceSnapshot {
  source: FinalizedSourceIdentity
  chapterTitle: string
  content: string
  /** Project continuity watermark frozen before semantic extraction starts. */
  projectionGeneration: number
}

export type FinalizedSourceReadResult =
  | { status: 'valid'; snapshot: FinalizedSourceSnapshot }
  | {
      status: 'legacy'
      draftId: number
      chapterNumber: number
      chapterTitle: string
      content: string
    }
  | { status: 'invalid' }

export interface FinalizedContinuityFact {
  category: FinalizedContinuityFactCategory
  entities: string[]
  statement: string
  sourceChapter: number
  evidence: string
  /** Display labels remain readable; only these proven IDs are identity references. */
  characterRefs?: FinalizedCharacterReference[]
}

export interface FinalizedCharacterReference {
  characterId: string
  displayNameSnapshot: string
}

/** A machine-derived locator only; it never becomes an author-confirmed fact. */
export interface FinalizedCharacterStateCandidate {
  /** Absent only on preserved legacy locators, never sufficient for a new write. */
  characterId?: string
  characterName: string
  field: CharacterStateTextField
  value: string
  evidence?: FinalizedCharacterEvidence
  selectionKey?: string
  displayName?: string
  rawValue?: unknown
  reason?: 'author-protected' | 'legacy-protected' | 'character-absent'
  /** Present on current source-bound decisions; omitted only by preserved legacy rows. */
  candidateKey?: string
  source?: FinalizedSourceIdentity
  expectedFieldRevision?: number
  expectedFieldValueHash?: string
}

export interface PendingFinalizedCharacterStateCandidate extends FinalizedCharacterStateCandidate {
  candidateKey: string
  characterId: string
  source: FinalizedSourceIdentity
  expectedFieldRevision: number
  expectedFieldValueHash: string
}

export interface PendingFinalizedCharacterStateCandidateSummary {
  draftId: number
  candidateKey: string
  finalizationId: string
  characterId: string
  characterName: string
  field: CharacterStateTextField
}

export interface FinalizedCharacterStateDecisionRequest {
  draftId: number
  candidateKey: string
  characterId: string
  field: CharacterStateTextField
  expectedFieldRevision: number
  expectedFieldValueHash: string
  operationId: string
  decision: 'accept' | 'decline'
}

export interface FinalizedCharacterStateDecisionReceipt {
  candidateKey: string
  operationId: string
  payloadHash: string
  decision: 'accept' | 'decline'
  source: FinalizedSourceIdentity
  idempotent: boolean
}

/** Offsets count JS UTF-16 code units in the immutable, unnormalized prose. */
export interface FinalizedCharacterEvidence { start: number; end: number; text: string }
export interface FinalizedCharacterContext extends ProjectEpoch {
  source: FinalizedSourceIdentity
  content: string
  projectionGeneration: number
  identityRevision: number
  identityStatus: 'bound' | 'legacy'
  sourceOrder: DerivedSourceOrder
  characters: Array<FinalizedCharacterReference & {
    aliases: string[]
    fields: CharacterFieldSnapshot[]
  }>
}
/** Render only: the original fields remain the CAS baseline. originProjectId must be main-verified transfer authority. */
export function finalizedCharacterPromptCards(context: FinalizedCharacterContext, originProjectId?: string) {
  return context.characters.map(character => ({ characterId: character.characterId, name: character.displayNameSnapshot, aliases: character.aliases,
    fields: character.fields.filter(field => {
      const previous = field.sourceOrder
      // chapterNumber identifies the chapter within the verified project lineage; draft IDs identify versions, not chapters.
      const superseded = field.field === 'recentEvents' && field.characterId === character.characterId && field.provenance.kind === 'derived'
        && typeof field.provenance.source?.finalizationId === 'string' && isFinalizedSourceIdentity(field.provenance.source)
        && field.provenance.source.chapterNumber === context.source.chapterNumber
        && field.provenance.source.finalizationId !== context.source.finalizationId
        && previous && previous.authoritativeFinalizationRevision < context.sourceOrder.authoritativeFinalizationRevision
        && decideDerivedPatch(field, { ...field, projectId: context.projectId, epoch: context.epoch,
          baseFieldRevision: field.revision, baseValueHash: field.valueHash, baseProvenance: field.provenance,
          source: context.source, sourceOrder: context.sourceOrder }, { source: context.source, order: context.sourceOrder, originProjectId }) === 'apply-derived'
      return !superseded
    }).map(field => ({ field: field.field, value: field.value, provenance: field.provenance })) }))
}
export type FinalizedCharacterStateValues = Partial<Record<CharacterStateTextField, string>>
export interface FinalizedCharacterStateUpdate {
  characterId: string
  currentState: FinalizedCharacterStateValues
  evidence: FinalizedCharacterEvidence
}
/** A model occurrence requiring an explicit identity decision, never an automatic merge. */
export interface FinalizedCharacterStateOccurrence {
  selectionKey: string
  displayName: string
  originalText: string
  candidateIds: string[]
  currentState: FinalizedCharacterStateValues
  evidence: FinalizedCharacterEvidence
  rawValue: unknown
  reason: 'name-only' | 'unknown-id' | 'ambiguous' | 'legacy'
}
export interface FinalizedCharacterStateResponse {
  updates: FinalizedCharacterStateUpdate[]
  unresolved: FinalizedCharacterStateOccurrence[]
}
export interface FinalizedCharacterStateCommitReceipt {
  applied: number
  unchanged: number
  candidates: FinalizedCharacterStateCandidate[]
}

export class FinalizedCharacterEvidenceError extends Error {
  constructor(code: 'FINALIZED_CHARACTER_EVIDENCE_MISSING' | 'FINALIZED_CHARACTER_EVIDENCE_NOT_UNIQUE' | 'FINALIZED_CHARACTER_EVIDENCE_INVALID',
    readonly updateIndex: number,
    readonly reason: 'missing' | 'no-exact-match' | 'multiple-exact-matches' | 'offset-mismatch') { super(code) }
}

/**
 * 这个角色在**本章正文**里出现过吗（issue #150）。
 *
 * 判据是**姓名或别名逐字出现**，不是语义在场：改名、代称（「那伙计」）都算没出现。
 * 这是刻意的保守——本条要挡的是「整章从头到尾没这个人，却给他写了一整套本章状态」，
 * 而那种情况下连名字都不会出现一次（实测第 71 章「邵广海」0 次、「广海」0 次）。
 *
 * 反过来，只要出现过一次就不再拦：铁链后头挤出个人，哪怕只有一句「她开口」，
 * 归给他的状态至少有落脚点，判据没有能力也没有必要再判「这一句是说他的吗」。
 */
export function characterAppearsInProse(character: { displayNameSnapshot: string; aliases: readonly string[] }, content: string): boolean {
  const body = String(content ?? '')
  const names = [character.displayNameSnapshot, ...character.aliases]
    .map(name => String(name ?? '').trim())
    .filter(name => name.length >= 2)
  return names.some(name => body.includes(name))
}

/**
 * 「本章 0 出场，却要被写入状态」的更新（issue #150）。
 *
 * 现场：第 71 章正文「邵广海」出现 0 次，定稿后处理却给他写了 location/physicalState/
 * mentalState/recentEvents/keyItems 五个字段，内容全是**柯明远**在本章做的事
 * （复核、夹卷宗、定三日内送检）。全书 141 条角色状态更新里 5 条写给了 0 出场的人。
 *
 * 为什么现有校验拦不住：解析器只检查 evidence 能定位、只出现一次、偏移对得上；
 * 「三日内，随布角送检。」本身没有主语，而同一段上一句明写「柯明远伸手」。
 * 归属这一维**完全没有被检查**，合同里也没要求。
 *
 * ⚠️ 本函数只回答第一问（0 出场）；第二问「引文所在句的施事是不是另一个人」需要
 * 指代/施事判定——实测那类句子的引文常常没有主语，规则判不准（#149/#144 的同一教训）。
 * 所以这里**只挡确定的那一档**：一个名字都没出现过的人，不该被写入本章状态。
 *
 * 返回 0 出场却被要求写入的 `characterId`（保持输入顺序，便于报错定位）。
 */
export function charactersAbsentButUpdated(
  context: Pick<FinalizedCharacterContext, 'characters' | 'content'>,
  updates: ReadonlyArray<{ characterId: string; currentState: Record<string, unknown> }>,
): string[] {
  const absent: string[] = []
  // ⚠️ **前置条件**：正文里至少出现过一个在册角色名。
  //
  // 一个名字都认不出来的正文，本层没有任何依据判断「谁出场了」——那不是「0 出场」，
  // 而是「这份正文不是这个故事的正常叙述」（合成夹具的占位文本就是这种）。
  // 硬判会让每一条更新都被降级，而真实长篇里不会出现这种正文。
  // 与 #107（名册为空整类跳过）、#135（判据静默先算条件在真实数据上成立吗）同一条。
  const anyRegisteredName = context.characters.some(character => characterAppearsInProse(character, context.content))
  if (!anyRegisteredName) return []
  for (const update of updates) {
    const character = context.characters.find(item => item.characterId === update.characterId)
    if (!character) continue
    // 没有任何动态字段的更新本来就不该存在（解析器已拦），这里只判有字段的。
    if (Object.keys(update.currentState ?? {}).length === 0) continue
    if (!characterAppearsInProse(character, context.content)) absent.push(update.characterId)
  }
  return absent
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
/** Main re-parses the settled artifact with its own frozen context before domain commit. */
export function parseFinalizedCharacterStateResponse(content: string, context: FinalizedCharacterContext): FinalizedCharacterStateResponse {
  const text = content.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '')
  const parsed: unknown = JSON.parse(text)
  if (!record(parsed) || !Array.isArray(parsed.updates) || parsed.updates.length > 1_000) throw new Error('FINALIZED_CHARACTER_UPDATES_INVALID')
  const result: FinalizedCharacterStateResponse = { updates: [], unresolved: [] }
  const seen = new Set<string>()
  for (const [index, input] of parsed.updates.entries()) {
    if (!record(input) || !record(input.currentState)) throw new Error('FINALIZED_CHARACTER_UPDATE_INVALID')
    // A distinct code lets the repair turn name the missing field instead of offering only the empty exit.
    if (!record(input.evidence)) throw new FinalizedCharacterEvidenceError('FINALIZED_CHARACTER_EVIDENCE_MISSING', index, 'missing')
    const evidence = input.evidence
    let start = evidence.start, end = evidence.end
    if (!Object.hasOwn(evidence, 'start') && !Object.hasOwn(evidence, 'end') && typeof evidence.text === 'string' && evidence.text.length > 0) {
      const located = context.content.indexOf(evidence.text)
      if (located < 0) throw new FinalizedCharacterEvidenceError('FINALIZED_CHARACTER_EVIDENCE_NOT_UNIQUE', index, 'no-exact-match')
      if (context.content.indexOf(evidence.text, located + 1) !== -1) throw new FinalizedCharacterEvidenceError('FINALIZED_CHARACTER_EVIDENCE_NOT_UNIQUE', index, 'multiple-exact-matches')
      start = located; end = located + evidence.text.length
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0
      || (end as number) <= (start as number) || (end as number) > context.content.length
      || typeof evidence.text !== 'string' || context.content.slice(start as number, end as number) !== evidence.text) {
      throw new FinalizedCharacterEvidenceError('FINALIZED_CHARACTER_EVIDENCE_INVALID', index, 'offset-mismatch')
    }
    const currentState: FinalizedCharacterStateValues = {}
    for (const field of CHARACTER_STATE_TEXT_FIELDS) {
      if (!Object.hasOwn(input.currentState, field)) continue
      if (typeof input.currentState[field] !== 'string') throw new Error('FINALIZED_CHARACTER_FIELD_INVALID')
      currentState[field] = input.currentState[field]
    }
    // ⚠️ 这里判的是**过滤前的键数**，刻意不改（issue #150 附注被证伪）。
    //
    // `{keyItems: ''}` 在本仓是**设计上的清空语义**，已有测试钉住
    // （"clears an explicit empty derived field…"）。把它改成「必须至少有一个非空值」，
    // 会连带禁止清空——那是另一个产品决定，不属于本条。
    // issue 附注说「只带 updatedAtChapter 能过闸」，实测**不成立**（当前实现抛
    // FINALIZED_CHARACTER_FIELD_INVALID）；附注的另一半「落一个空 currentState」
    // 也走不到，因为空对象在这里就被拦下了。
    if (!Object.keys(currentState).length || Object.hasOwn(input.currentState, 'updatedAtChapter') && input.currentState.updatedAtChapter !== context.source.chapterNumber) {
      throw new Error('FINALIZED_CHARACTER_FIELD_INVALID')
    }
    const characterId = typeof input.characterId === 'string' ? input.characterId : ''
    const originalText = typeof input.name === 'string' ? input.name : ''
    const character = context.identityStatus === 'bound' ? context.characters.find(item => item.characterId === characterId) : undefined
    const exactEvidence = { start: start as number, end: end as number, text: evidence.text }
    // Even an explicit model ID cannot disambiguate two source characters with
    // the same frozen display label. Preserve the occurrence for author approval.
    const sharedLabel = character && context.characters.filter(item => item.displayNameSnapshot === character.displayNameSnapshot).length > 1
    if (!character || sharedLabel) {
      if (!originalText.trim() && !characterId) throw new Error('FINALIZED_CHARACTER_IDENTITY_REQUIRED')
      result.unresolved.push({ selectionKey: `update:${index}`, displayName: originalText.trim() ? originalText : character?.displayNameSnapshot ?? originalText, originalText,
        candidateIds: context.characters.filter(item => item.characterId === characterId || sharedLabel && item.displayNameSnapshot === character?.displayNameSnapshot
          || item.displayNameSnapshot === originalText || item.aliases.includes(originalText)).map(item => item.characterId),
        currentState, evidence: exactEvidence, rawValue: structuredClone(input),
        reason: context.identityStatus === 'legacy' ? 'legacy' : sharedLabel ? 'ambiguous' : characterId ? 'unknown-id' : 'name-only' })
      continue
    }
    if (seen.has(characterId)) throw new Error('FINALIZED_CHARACTER_DUPLICATE_ID')
    seen.add(characterId)
    result.updates.push({ characterId, currentState, evidence: exactEvidence })
  }
  return result
}

export interface FinalizedContinuityProjection {
  draftId: number
  /** Current finalized prose to read when this derived locator is stale. */
  currentFinalizedDraftId?: number
  chapterNumber: number
  chapterTitle: string
  chapterNotes: string
  facts?: FinalizedContinuityFact[]
  /** Used only to locate the bound finalized prose, never rendered as a fact. */
  characterStateCandidates?: FinalizedCharacterStateCandidate[]
  /** Missing only for pre-v2 rows whose source cannot be safely reconstructed. */
  source?: FinalizedSourceIdentity
  /** Missing legacy callers must be treated exactly like `legacy`, never current. */
  sourceStatus?: FinalizedProjectionStatus
}

export interface SaveFinalizedContinuityRequest {
  draftId: number
  chapterNumber: number
  chapterNotes: string
  facts?: FinalizedContinuityFact[]
  /** Watermark frozen before extraction; stale in-flight results must not advance it. */
  projectionGeneration: number
  /** Frozen before extraction; the main process revalidates it at commit time. */
  source: FinalizedSourceIdentity
}

/**
 * **存量事实的重新分类**（issue #173）。
 *
 * `#148` 修好的是判据，但 `category` 是落库那一刻算一次并写死的——存量 20 章不自愈
 * （真书全量 561 条事实里 148 条与当前判据不符，含 109 条 `plot→open-thread`）。
 * 这个请求只做一件事：把某一章已落库事实的 `category` 按**当前**判据重算一遍，
 * `statement` / `evidence` / `sourceChapter` 逐字不动。
 */
export interface RecategorizeContinuityRequest {
  draftId: number
  chapterNumber: number
}

export interface RecategorizeContinuityReceipt {
  chapterNumber: number
  /** 改了几条。0 表示这一章已经是对的（幂等）。 */
  changed: number
  /** 从 → 到 的计数，例如 `{ 'plot→open-thread': 29 }`，供界面先给作者看差异。 */
  counts: Record<string, number>
  /**
   * `chapter_commits` **整行缺失**（issue #187）：`summary_snapshots` 有事实、`chapter_commits` 没行，
   * 两套账不一致。后处理链在最后一段被中断（关应用/断电/崩溃）就会留下这种状态。
   *
   * ⚠️ 重算分类**修不了它**（那条只改 category），界面必须另给「补齐账本」入口。
   */
  commitLedgerMissing?: true
}

export interface SaveFinalizedCharacterStateCandidatesRequest {
  draftId: number
  chapterNumber: number
  candidates: FinalizedCharacterStateCandidate[]
  /** Watermark frozen before extraction; stale in-flight results must not advance it. */
  projectionGeneration: number
  /** Frozen before extraction; the main process revalidates it at commit time. */
  source: FinalizedSourceIdentity
}
