import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { MainGenerationRunHandle, MainGenerationSnapshot } from '../../src/services/generation/generation-runtime'
import type { BeginGenerationRequest } from '../../src/shared/generation-owner-contract'
import type { PrepareReviewRevisionRequest, PreparedReviewRevisionContext, ReviewGenerationCommitRequest,
  RevisionGenerationCommitRequest, ReviewRevisionCommitReceipt, ReviewRevisionContext, ReviewRevisionRecovery } from '../../src/shared/review-revision-generation'
import { buildReviewGenerationReport, type ReviewReportVersion } from '../../src/shared/review-generation-report'
import { buildReviewCycleRecheckReport, isNoopRevision } from '../../src/shared/review-cycle'
import { countDraftUnits } from '../../src/shared/draft-units'
import { assertMateriallyCompleteRevision } from '../../src/services/workflows/commands/refinement-completeness'
import { GenerationRunRepository, textHash, type DurableGenerationRun } from '../repositories/generation-run-repository'
import { ReviewRepository } from '../repositories/review-repository'
import { RevisionRepository } from '../repositories/revision-repository'
import { ReviewCycleRepository } from '../repositories/review-cycle-repository'
import { captureReviewRevisionContext, reviewRevisionRequest, REVIEW_REVISION_OPERATIONS } from './review-revision-context'

type ArtifactRef = ReviewGenerationCommitRequest['artifact']
interface Effect {
  kind: 'review' | 'revision'; id: number; index: number; contentHash: string; contextHash: string
  artifact: ArtifactRef; compositionHash?: string; reportVersion?: 2
}
interface AttemptRow { attempt_id: string; run_id: string; usage_receipt_json: string }
const handleOf = (run: DurableGenerationRun): MainGenerationRunHandle => ({ projectId: run.binding.projectId,
  epoch: run.binding.epoch, rootActionId: run.rootActionId, runId: run.runId })
const contextHash = (context: ReviewRevisionContext) => textHash(JSON.stringify(context))

/** Admission contexts are disposable; recovery and formal-effect truth live in the existing run ledger. */
type AdmissionContextKind = 'admission' | 'recovery'

export class ReviewRevisionGeneration {
  /**
   * `contextId` → 那条准入记录（issue #201）。
   *
   * 为什么区分 `kind`：`prepare`（写）产出的凭据丢了就得让作者重做一次预检，
   * 而 `readRecovery`（读）产出的随时能从 run 账本重建 —— **容量吃紧时该先丢后者**。
   */
  private readonly contexts = new Map<string, { prepared: PreparedReviewRevisionContext; kind: AdmissionContextKind }>()
  /** `runId` → 当前那条 recovery 的 contextId，用于「同一状态复用同一个 id」。 */
  private readonly recoveryContextIdByRun = new Map<string, string>()
  constructor(private readonly db: Database.Database, private readonly runs: GenerationRunRepository,
    private readonly scope: { projectId: string; epoch: string }, private readonly assertCurrent: () => void) {}

  private remember(context: ReviewRevisionContext, lineage: { parentRootActionId?: string; modelId?: string } = {},
    kind: AdmissionContextKind = 'admission'): PreparedReviewRevisionContext {
    const prepared = { contextId: randomUUID(), context: structuredClone(context), ...lineage }
    this.evictForCapacity()
    this.contexts.set(prepared.contextId, { prepared: structuredClone(prepared), kind })
    return structuredClone(prepared)
  }

  /**
   * 容量淘汰（issue #201）。
   *
   * 现场：`read-recovery` 每次调用都 `remember` 一条新记录，而运行侧页会对**每个**审稿 run
   * 调一次它 —— 「打开侧页」这个动作按「审稿 run 数」吃掉 Map 容量（上限 64，纯 FIFO）。
   * 于是**正在用的那条（prepare 写进去的）会被自己的恢复列表挤掉**，
   * 点「审稿」时 `admit` 取不到 → `GENERATION_REVIEW_CONTEXT_REQUIRED`。
   *
   * 淘汰顺序：先丢 recovery（可从账本重建），实在没有才丢最老的 admission。
   */
  private evictForCapacity(): void {
    if (this.contexts.size < 64) return
    // 先丢 recovery 条目（能从 run 账本重建），不受本次写入的是哪一类影响：
    // 即使写进来的也是 recovery，丢掉的也是别人那条「随时可重建」的。
    for (const [contextId, entry] of this.contexts) {
      if (entry.kind === 'recovery') { this.forget(contextId); return }
    }
    // 只装了 admission（作者连点很多次预检）时才动它们，且仍从最老的开始。
    const oldest = this.contexts.keys().next().value
    if (oldest !== undefined) this.forget(oldest)
  }

  private forget(contextId: string): void {
    this.contexts.delete(contextId)
    for (const [runId, id] of this.recoveryContextIdByRun) if (id === contextId) this.recoveryContextIdByRun.delete(runId)
  }
  private context(run: DurableGenerationRun): ReviewRevisionContext {
    const context = run.binding.sourceManifest.reviewRevisionContext as ReviewRevisionContext | undefined
    if (!context || context.version !== 1 || context.operation !== run.binding.sourceManifest.operation
      || !REVIEW_REVISION_OPERATIONS.includes(context.operation)
      || run.binding.sourceManifest.reviewRevisionContextHash !== contextHash(context)
      || context.sourceHash !== textHash(context.source.content)
      || !isDeepStrictEqual(run.binding.sourceManifest.authorInputs, [{ id: 'review-revision-context', text: JSON.stringify(context) }]))
      throw new Error('GENERATION_REVIEW_CONTEXT_UNPROVEN')
    return context
  }
  private attempts(runId?: string): AttemptRow[] {
    return (runId ? this.db.prepare('SELECT attempt_id,run_id,usage_receipt_json FROM generation_attempts WHERE run_id=? ORDER BY rowid').all(runId)
      : this.db.prepare('SELECT attempt_id,run_id,usage_receipt_json FROM generation_attempts ORDER BY rowid').all()) as AttemptRow[]
  }
  /** Formal effects seal the proof they reference. Retrying their saved ACK remains read-only. */
  assertMutable(runId: string): void {
    if (this.attempts(runId).some(row => JSON.parse(row.usage_receipt_json)?.reviewRevisionEffect))
      throw new Error('GENERATION_REVIEW_ALREADY_SAVED')
  }
  private requireRun(handle: MainGenerationRunHandle): DurableGenerationRun {
    this.assertCurrent()
    const run = this.runs.get(handle.runId)
    if (run.binding.projectId !== this.scope.projectId || !isDeepStrictEqual(handle, handleOf(run))) throw new Error('GENERATION_RUN_IDENTITY_MISMATCH')
    this.context(run)
    return run
  }
  private proveArtifact(run: DurableGenerationRun, reference: ArtifactRef) {
    if (!reference || Object.keys(reference).some(key => !['artifactId', 'revision', 'textHash'].includes(key))) throw new Error('GENERATION_REVIEW_ARTIFACT_INVALID')
    const row = this.db.prepare('SELECT attempt_id,run_id,status FROM generation_artifacts WHERE artifact_id=?').get(reference.artifactId) as { attempt_id: string; run_id: string; status: string } | undefined
    if (!row || row.run_id !== run.runId || row.status === 'discarded') throw new Error('GENERATION_REVIEW_ARTIFACT_INVALID')
    const receipt = this.runs.receipt(row.attempt_id), artifact = receipt.artifact
    if (!artifact || artifact.revision !== reference.revision || artifact.textHash !== reference.textHash
      || textHash(artifact.text) !== reference.textHash || receipt.failureCode || receipt.result?.finishReason !== 'stop'
      || !['settled', 'unknown'].includes(receipt.attempt.status)) throw new Error('GENERATION_REVIEW_ARTIFACT_INVALID')
    return { row, receipt, artifact }
  }
  private reviewBody(run: DurableGenerationRun, reference: ArtifactRef, reportVersion: ReviewReportVersion = 2): string {
    const context = this.context(run), { row, artifact } = this.proveArtifact(run, reference)
    if (context.recheck) {
      const attempt = this.attempts(run.runId).find(candidate => candidate.attempt_id === row.attempt_id)
      let persistedVersion: 1 | 2 | undefined
      try {
        const receipt = attempt && JSON.parse(attempt.usage_receipt_json).reviewCycleRecheck
        if (receipt?.version === 1 || receipt?.version === 2) persistedVersion = receipt.version
      } catch { /* Invalid persisted receipts fail later proof checks; do not downgrade current policy. */ }
      const policy = { ...context.recheck, version: persistedVersion ?? 2 } as const
      const built = buildReviewCycleRecheckReport(artifact.text, context.source.content, policy, context.uiLocale, reportVersion)
      return JSON.stringify({ summary: built.summary, items: built.items }, null, 2)
    }
    return JSON.stringify(buildReviewGenerationReport({ content: artifact.text, sourceContent: context.source.content,
      frozenGoals: context.frozenGoals, writingLanguage: context.writingLanguage, uiLocale: context.uiLocale,
      preflightFindings: context.preflightFindings, reportVersion }), null, 2)
  }
  private saved(run: DurableGenerationRun): { effect: Effect; receipt: ReviewRevisionCommitReceipt } | undefined {
    const rows = this.attempts(run.runId).filter(row => JSON.parse(row.usage_receipt_json)?.reviewRevisionEffect)
    if (rows.length > 1) throw new Error('GENERATION_REVIEW_RECEIPT_INVALID')
    if (!rows[0]) return undefined
    const effect = JSON.parse(rows[0].usage_receipt_json).reviewRevisionEffect as Effect
    const context = this.context(run), proof = this.proveArtifact(run, effect.artifact)
    if (effect.reportVersion !== undefined && (effect.reportVersion !== 2 || effect.kind !== 'review'))
      throw new Error('GENERATION_REVIEW_RECEIPT_INVALID')
    if (proof.row.attempt_id !== rows[0].attempt_id || effect.contextHash !== contextHash(context)
      || effect.kind !== (context.operation === 'review-chapter' ? 'review' : 'revision')) throw new Error('GENERATION_REVIEW_RECEIPT_INVALID')
    const row = effect.kind === 'review' ? ReviewRepository.getFull(effect.id, this.db) : RevisionRepository.getFull(effect.id, this.db)
    const index = row && ('reviewIndex' in row ? row.reviewIndex : row.revisionIndex)
    const composition = effect.kind === 'revision' ? this.runs.readVisibleComposition(run.runId) : undefined
    const body = effect.kind === 'review' ? this.reviewBody(run, effect.artifact, effect.reportVersion ?? 1) : composition?.text.trim()
    if (!row || row.baseDraftId !== context.source.id || index !== effect.index || !isDeepStrictEqual(row.sourceDraft, context.source)
      || effect.contentHash !== textHash(row.content) || row.content !== body
      || effect.kind === 'revision' && (composition?.algorithm !== 'visible-append-v1' || composition.textHash !== effect.compositionHash
        || composition.artifactIds.at(-1) !== effect.artifact.artifactId)) throw new Error('GENERATION_REVIEW_RECEIPT_INVALID')
    const revisionStatus = 'status' in row ? row.status as ReviewRevisionCommitReceipt['revisionStatus'] : undefined
    if (revisionStatus && !['pending', 'merged', 'discarded'].includes(revisionStatus)) throw new Error('GENERATION_REVIEW_RECEIPT_INVALID')
    const cycle = context.recheck ? ReviewCycleRepository.planRecheck(context.recheck.cycleId, this.db) : undefined
    return { effect, receipt: { success: true, kind: effect.kind, id: row.id, index: effect.index,
      content: row.content, contentHash: effect.contentHash, source: structuredClone(context.source), ...(revisionStatus ? { revisionStatus } : {}),
      ...(context.recheck ? { reviewCycle: { cycleId: context.recheck.cycleId, revisionStatus: 'merge-committed',
        recheckCount: cycle?.disposition === 'completed' ? 1 : 0, disposition: cycle?.disposition ?? 'required' } } : {}) } }
  }
  private parent(context: ReviewRevisionContext): { parentRootActionId?: string; modelId?: string } {
    if (context.recheck) {
      const plan = ReviewCycleRepository.planRecheck(context.recheck.cycleId, this.db)
      const frozenPlan = plan.context && { ...plan.context, version: context.recheck.version }
      if (plan.disposition !== 'required' || !frozenPlan || !isDeepStrictEqual(frozenPlan, context.recheck))
        throw new Error('GENERATION_REVIEW_LINEAGE_UNPROVEN')
      const matching = this.attempts().filter(row => {
        const effect = JSON.parse(row.usage_receipt_json)?.reviewRevisionEffect as Effect | undefined
        return effect?.kind === 'review' && effect.id === plan.reviewId
      })
      if (matching.length !== 1) throw new Error('GENERATION_REVIEW_LINEAGE_UNPROVEN')
      const parentRun = this.runs.get(matching[0]!.run_id)
      if (parentRun.rootActionId !== plan.rootActionId || parentRun.binding.projectId !== this.scope.projectId)
        throw new Error('GENERATION_REVIEW_LINEAGE_UNPROVEN')
      return { parentRootActionId: plan.rootActionId,
        modelId: (parentRun.binding.sourceManifest.modelReceipt as { modelId: string }).modelId }
    }
    if (!context.confirmation) return {}
    // issue #244：confirmation 路径的修稿**不再挂父 root**（开新 root）。
    // 旧实现把修稿 run 挂在审稿 run 的 root 下——审稿 run 失败/挂起后 root 被
    // authorEditedRoot/blockedCode/attemptCount 冻结，修稿重试每次都撞 BLOCKED
    // （#238/#242/#244 三连）。lineage 由 confirmation 快照证明（下方校验仍在）：
    // originalReviewContentHash + source 绑定验证报告与正文的关系，不依赖 root。
    // 仍校验 lineage 证据存在（report 未丢），只是不再把新 run 挂到那个 root 上。
    const matching = this.attempts().filter(row => {
      const effect = JSON.parse(row.usage_receipt_json)?.reviewRevisionEffect as Effect | undefined
      return effect?.kind === 'review' && effect.id === context.confirmation!.snapshot.sourceReviewId
    })
    if (matching.length !== 1) throw new Error('GENERATION_REVIEW_LINEAGE_UNPROVEN')
    const run = this.runs.get(matching[0]!.run_id), saved = this.saved(run)
    if (run.binding.projectId !== this.scope.projectId || !saved || saved.receipt.kind !== 'review'
      || saved.receipt.contentHash !== context.confirmation.originalReviewContentHash
      || !isDeepStrictEqual(saved.receipt.source, context.source)) throw new Error('GENERATION_REVIEW_LINEAGE_UNPROVEN')
    return {}
  }
  prepare(request: PrepareReviewRevisionRequest): PreparedReviewRevisionContext {
    this.assertCurrent()
    return this.db.transaction(() => {
      const context = captureReviewRevisionContext(this.db, request, this.scope.projectId)
      return this.remember(context, this.parent(context))
    })()
  }
  admit(selection: BeginGenerationRequest): PreparedReviewRevisionContext | undefined {
    this.assertCurrent()
    if (!REVIEW_REVISION_OPERATIONS.includes(selection.operation as ReviewRevisionContext['operation'])) {
      if (selection.reviewRevisionContextId) throw new Error('GENERATION_REVIEW_CONTEXT_INVALID')
      return undefined
    }
    const prepared = selection.reviewRevisionContextId && this.contexts.get(selection.reviewRevisionContextId)?.prepared
    if (!prepared) throw new Error('GENERATION_REVIEW_CONTEXT_REQUIRED')
    const { context } = prepared, finalized = context.source.status === 'finalized'
    const prompt = context.operation === 'review-chapter' ? 'consistency_check' : context.operation === 'refine-draft' ? 'refine_chapter' : 'refine_from_review'
    /**
     * issue #174：这一串合取项原来只抛一个 `GENERATION_REVIEW_CONTEXT_MISMATCH`，
     * **不说哪一项不等**。现场（第 26 章审稿）主进程日志只有错误码，作者看到的是
     * 「审稿一直在转」720 秒，而排查时无从下手——11 项里没有任何线索说明是哪一项。
     *
     * 改成**带名字的检查表**：错误码后面接第一个不相等的项名（`…_MISMATCH:authorInputs`），
     * 一次复现就能定位。判断内容与顺序**逐条保持原样**（含那一处带注释的 modelId 条件），
     * 只是把「合取」换成「第一个失败的具名项」——短路语义也一致。
     */
    const mismatches: Array<[string, boolean]> = [
      ['operation', selection.operation === context.operation],
      ['chapterNumber', selection.chapterNumber === context.source.chapterNumber],
      ['promptKeys', isDeepStrictEqual(selection.promptKeys, [prompt])],
      ['skillStages', isDeepStrictEqual(selection.skillStages, [context.operation === 'review-chapter' ? 'review' : 'refinement'])],
      ['outputOverrides', selection.outputOverrides === undefined],
      ['batchId', selection.batchId === undefined],
      ['continueDirectoryOperationId', selection.continueDirectoryOperationId === undefined],
      ['output', selection.output === (context.operation === 'review-chapter' ? 'structured-data' : 'visible-text')],
      ['selectedDraftIds', isDeepStrictEqual(selection.selectedDraftIds, finalized ? [] : [context.source.id])],
      ['selectedFinalizedDraftIds', isDeepStrictEqual(selection.selectedFinalizedDraftIds, finalized ? [context.source.id] : [])],
      ['authorInputs', isDeepStrictEqual(selection.authorInputs, [{ id: 'review-revision-context', text: JSON.stringify(context) }])],
      ['parentRootActionId', prepared.parentRootActionId === undefined
        ? selection.parentRootActionId === undefined
        : selection.parentRootActionId === prepared.parentRootActionId],
      // The confirmed review proves lineage, not the model choice of a new revision stage.
      ['modelId', Boolean(context.confirmation) || !prepared.modelId || selection.modelId === prepared.modelId],
    ]
    const failed = mismatches.find(([, matches]) => !matches)
    if (failed) throw new Error(`GENERATION_REVIEW_CONTEXT_MISMATCH:${failed[0]}`)
    if (!isDeepStrictEqual(context, captureReviewRevisionContext(this.db, reviewRevisionRequest(context), this.scope.projectId,
      context.recheck?.version))
      || !isDeepStrictEqual(this.parent(context), prepared.parentRootActionId ? { parentRootActionId: prepared.parentRootActionId, modelId: prepared.modelId } : {}))
      throw new Error('GENERATION_REVIEW_CONTEXT_CHANGED')
    return structuredClone(prepared)
  }
  private assertPrepared(contextId: string, run: DurableGenerationRun): void {
    if (!isDeepStrictEqual(this.contexts.get(contextId)?.prepared.context, this.context(run))) throw new Error('GENERATION_REVIEW_CONTEXT_REQUIRED')
  }
  private record(run: DurableGenerationRun, artifact: ArtifactRef, effect: Omit<Effect, 'artifact' | 'contextHash'>): ReviewRevisionCommitReceipt {
    const proof = this.proveArtifact(run, artifact), row = this.attempts(run.runId).find(row => row.attempt_id === proof.row.attempt_id)!
    const usage = JSON.parse(row.usage_receipt_json)
    this.db.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?').run(JSON.stringify({ ...usage,
      reviewRevisionEffect: { ...effect, artifact, contextHash: contextHash(this.context(run)) } }), row.attempt_id)
    return this.saved(run)!.receipt
  }
  commitReview(request: ReviewGenerationCommitRequest, assertSources: (handle: MainGenerationRunHandle) => void): ReviewRevisionCommitReceipt {
    if (!request || Object.keys(request).some(key => !['contextId', 'handle', 'artifact'].includes(key))) throw new Error('GENERATION_REVIEW_COMMIT_INVALID')
    return this.db.transaction(() => {
      const run = this.requireRun(request.handle), context = this.context(run), saved = this.saved(run)
      if (context.operation !== 'review-chapter') throw new Error('GENERATION_REVIEW_COMMIT_INVALID')
      if (saved) {
        if (!isDeepStrictEqual(saved.effect.artifact, request.artifact)) throw new Error('GENERATION_REVIEW_COMMIT_CONFLICT')
        return saved.receipt
      }
      this.assertPrepared(request.contextId, run); assertSources(request.handle)
      const proof = this.proveArtifact(run, request.artifact)
      const content = this.reviewBody(run, request.artifact)
      const result = ReviewRepository.create({ baseDraftId: context.source.id, content, expectedSource: context.source }, this.db)
      const contentHash = textHash(content)
      const receipt = this.record(run, request.artifact, { kind: 'review', id: result.id, index: result.reviewIndex, contentHash,
        reportVersion: 2 })
      if (context.recheck) {
        const policy = { ...context.recheck, version: 2 } as const
        const built = buildReviewCycleRecheckReport(proof.artifact.text, context.source.content, policy, context.uiLocale)
        const findings = built.decisions.filter(decision => decision.status !== 'unknown').map(decision => {
          const item = built.items[decision.reviewItemIndex]!
          const resolved = decision.status === 'resolved'
          return { findingId: decision.findingId, targetId: decision.targetId, reviewItemIndex: decision.reviewItemIndex,
            evidenceHash: textHash(JSON.stringify({ findingId: decision.findingId, targetId: decision.targetId,
              reviewItemIndex: decision.reviewItemIndex, item, resolved })), resolved }
        })
        const attempt = this.attempts(run.runId).find(row => row.attempt_id === proof.row.attempt_id)
        if (!attempt) throw new Error('GENERATION_REVIEW_RECEIPT_INVALID')
        const usage = JSON.parse(attempt.usage_receipt_json)
        this.db.prepare('UPDATE generation_attempts SET usage_receipt_json=? WHERE attempt_id=?').run(JSON.stringify({ ...usage,
          reviewCycleRecheck: { version: policy.version, cycleId: context.recheck.cycleId,
            comparisonVersion: context.recheck.comparisonVersion, mergedHash: context.recheck.mergedHash,
            findingSetHash: context.recheck.findingSetHash, findings } }), attempt.attempt_id)
        ReviewCycleRepository.commitRecheck(context.recheck.cycleId, attempt.attempt_id, this.db)
        return this.saved(run)!.receipt
      }
      ReviewCycleRepository.create({ rootActionId: run.rootActionId, reviewId: result.id, reviewContentHash: contentHash,
        source: { projectId: run.binding.projectId, epoch: run.binding.epoch, sourceId: `draft:${context.source.id}`,
          revision: context.source.version, contentHash: textHash(context.source.content) } }, this.db)
      return receipt
    }).immediate()
  }
  commitRevision(request: RevisionGenerationCommitRequest, assertSources: (handle: MainGenerationRunHandle) => void): ReviewRevisionCommitReceipt {
    if (!request || Object.keys(request).some(key => !['contextId', 'handle', 'expectedCompositionHash'].includes(key))) throw new Error('GENERATION_REVIEW_COMMIT_INVALID')
    return this.db.transaction(() => {
      const run = this.requireRun(request.handle), context = this.context(run), saved = this.saved(run)
      if (context.operation === 'review-chapter') throw new Error('GENERATION_REVIEW_COMMIT_INVALID')
      if (saved) {
        if (saved.effect.compositionHash !== request.expectedCompositionHash) throw new Error('GENERATION_REVIEW_COMMIT_CONFLICT')
        return saved.receipt
      }
      this.assertPrepared(request.contextId, run); assertSources(request.handle)
      const composition = this.runs.readVisibleComposition(run.runId)
      if (!composition || composition.algorithm !== 'visible-append-v1' || composition.textHash !== request.expectedCompositionHash)
        throw new Error('GENERATION_REVIEW_COMPOSITION_REQUIRED')
      const artifact = composition.sources.at(-1)!
      this.proveArtifact(run, artifact)
      const content = composition.text.trim()
      if (!content) throw new Error('GENERATION_REVIEW_REVISION_EMPTY')
      assertMateriallyCompleteRevision(context.source.content, content, context.config.wordsPerChapter, context.uiLocale)
      if (isNoopRevision(context.source.content, content)) throw new Error('GENERATION_REVIEW_REVISION_NOOP')
      const result = RevisionRepository.replacePending({ baseDraftId: context.source.id,
        revisionType: context.operation === 'refine-from-review' ? 'review-fix' : 'refine',
        ...(context.confirmation ? { reviewSourceId: context.confirmation.reviewSourceId } : {}),
        userPrompt: context.confirmation?.snapshot.authorGuidance ?? context.authorInputs.find(item => item.id === 'user-prompt')?.text ?? '',
        content, wordCount: countDraftUnits(content), expectedSource: context.source }, this.db)
      const receipt = this.record(run, artifact, { kind: 'revision', id: result.id, index: result.revisionIndex,
        contentHash: textHash(content), compositionHash: composition.textHash })
      if (context.confirmation) {
        const cycle = this.db.prepare('SELECT cycle_id,root_action_id FROM review_cycles WHERE review_id=?')
          .get(context.confirmation.snapshot.sourceReviewId) as { cycle_id: string; root_action_id: string } | undefined
        if (!cycle) throw new Error('REVIEW_CYCLE_INPUT_INVALID')
        ReviewCycleRepository.attachGeneratedRevision({ cycleId: cycle.cycle_id, rootActionId: cycle.root_action_id,
          confirmationReviewId: context.confirmation.reviewSourceId,
          confirmationContentHash: textHash(context.confirmation.content), revisionId: result.id,
          revisionContentHash: textHash(content) }, this.db)
      }
      return receipt
    }).immediate()
  }
  /**
   * 同一个 run、同一份 context 的 recovery 凭据要**稳定**（issue #201）。
   *
   * 原来每次 `readRecovery` 都 `remember` 一条新的：运行侧页对每个审稿 run 调一次，
   * 打开一次侧页就吃掉 N 条容量（Map 上限 64、纯 FIFO），**正在用的那条会被挤掉** →
   * 点「审稿」时 `admit` 报 `GENERATION_REVIEW_CONTEXT_REQUIRED`。
   *
   * 现在按 `runId` 复用：同一 run 且有同一条记录在 Map 里 → 返回同一个 id。
   * ⚠️ 只在「同 run + 同 context」时复用 —— `canResume` / `saved` 变化会走不到这里
   * （那两分支本来就不返回 contextId），所以不会把旧状态当成新状态。
   */
  private recoveryContextId(run: DurableGenerationRun, context: ReviewRevisionContext): string {
    const existingId = this.recoveryContextIdByRun.get(run.runId)
    const existing = existingId === undefined ? undefined : this.contexts.get(existingId)
    if (existing && existing.kind === 'recovery' && isDeepStrictEqual(existing.prepared.context, context))
      return existingId!
    const contextId = this.remember(context, this.parent(context), 'recovery').contextId
    this.recoveryContextIdByRun.set(run.runId, contextId)
    return contextId
  }
  readRecovery(handle: MainGenerationRunHandle, sourcesMatch: (run: DurableGenerationRun) => boolean,
    snapshot: (run: DurableGenerationRun) => MainGenerationSnapshot | undefined): ReviewRevisionRecovery {
    const run = this.requireRun(handle), context = this.context(run), saved = this.saved(run)?.receipt
    let current = false
    try { current = sourcesMatch(run) } catch { /* Original candidate remains available when a source/model/template has changed. */ }
    const composition = this.runs.readVisibleComposition(run.runId) ?? undefined, latestArtifact = snapshot(run)
    const last = composition?.artifactIds.at(-1)
    const finish = (id: string | undefined) => {
      const attempt = id && this.db.prepare('SELECT attempt_id FROM generation_artifacts WHERE artifact_id=?').pluck().get(id) as string | undefined
      return attempt ? this.runs.receipt(attempt).result?.finishReason ?? null : null
    }
    const lastCompositionFinishReason = finish(last), latestArtifactFinishReason = finish(latestArtifact?.artifactId)
    const attemptedPurposes = this.attempts(run.runId).map(row => JSON.parse(row.usage_receipt_json).purpose ?? 'unknown')
    let canResume = current
    if (!saved && context.operation === 'review-chapter' && latestArtifactFinishReason === 'length'
      && attemptedPurposes.filter(purpose => purpose === 'review-chapter').length >= 2
      && !attemptedPurposes.includes('review-chapter-rebuild')) canResume = false
    if (!saved && context.operation !== 'review-chapter' && composition && lastCompositionFinishReason === 'stop') {
      try {
        assertMateriallyCompleteRevision(context.source.content, composition.text, context.config.wordsPerChapter, context.uiLocale)
        if (isNoopRevision(context.source.content, composition.text.trim())) canResume = false
      } catch { canResume = false }
    }
    return { handle: handleOf(run), context: structuredClone(context), modelId: (run.binding.sourceManifest.modelReceipt as { modelId: string }).modelId,
      sourceStatus: current ? 'current' : 'conflict', canResume, ...(saved ? { saved } : {}),
      ...(canResume && !saved ? { contextId: this.recoveryContextId(run, context) } : {}), ...(composition ? { composition } : {}),
      lastCompositionFinishReason, ...(latestArtifact ? { latestArtifact, latestArtifactFinishReason } : {}), attemptedPurposes }
  }
  close(): void { this.contexts.clear(); this.recoveryContextIdByRun.clear() }
}
