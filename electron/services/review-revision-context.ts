import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import type { ExpectedDraftSource, NovelConfig } from '../../src/shared/ipc-channels'
import type { PrepareReviewRevisionRequest, ReviewMaterialIdentity, ReviewRevisionContext } from '../../src/shared/review-revision-generation'
import { parseHumanConfirmedReviewSnapshot, serializeHumanConfirmedReviewSnapshot } from '../../src/shared/human-confirmed-review'
import { freezeChapterGoals } from '../../src/shared/chapter-goal-review'
import { findBlueprintContinuityRisks } from '../../src/shared/consistency-preflight'
import { proseRepetitionFindings } from '../../src/shared/prose-repetition'
// issue #83：这三项的实现已移到 `src/shared/consistency-preflight.ts`（写前预检与审稿
// 共用同一份）。这里既在本文件内调用、又要保持既有 import 路径不变，所以「import + re-export」。
import {
  abilityBudgetFindings,
  assertionReversalFindings,
  findClosingLabelConflicts,
  findUltimatumStreak,
  numberingFindings,
} from '../../src/shared/consistency-preflight'
export {
  abilityBudgetFindings,
  assertionReversalFindings,
  numberingFindings,
}
import { closingShotOf } from '../../src/shared/blueprint-semantic-contract'
import {
  findDialogueOpenerConvergence,
  findOpeningShapeConvergence,
  findUndeliveredForeshadowing,
} from '../../src/shared/consistency-preflight'
import { foreshadowingDueAt, parseForeshadowingCommitments } from '../../src/shared/foreshadowing-commitments'
// 字形断言（issue #99）：审稿时本章正文还在手边，正是能改的时候。
// 与写前预检（`finalized-prose-audit.ts`）共用同一份判据，只是样本不同。
import { glyphRadicalFindings } from '../../src/shared/glyph-radical'
// 角色名漂移（issue #102）：本章把某个已登记角色写成了同后缀异姓。
import { findCastNameDriftFindings } from '../../src/shared/cast-name-drift'
// 期限宣告未对账（#101）与重复宣告的不可逆处境变更（#105）：审稿时本章还在手边，正是能补的时候。
import { findUnsettledDeadlineFindings } from '../../src/shared/deadline-settlement'
import { findRepeatedRevocationFindings } from '../../src/shared/repeated-revocation'
import { CHARACTER_STATE_TEXT_FIELDS } from '../../src/shared/character-roster'
import { ProjectCoreRepository } from '../repositories/project-core-repository'
import { CharacterRepository } from '../repositories/character-repository'
import { BlueprintRepository } from '../repositories/blueprint-repository'
import { SummaryRepository } from '../repositories/summary-repository'
import { ConsistencyExemptionRepository } from '../repositories/consistency-exemption-repository'
import { ReviewRepository } from '../repositories/review-repository'
import { ReviewCycleRepository } from '../repositories/review-cycle-repository'
import { textHash } from '../repositories/generation-run-repository'

export const REVIEW_REVISION_OPERATIONS = ['review-chapter', 'refine-draft', 'refine-from-review'] as const
const fail = (): never => { throw new Error('GENERATION_REVIEW_CONTEXT_INVALID') }

/** Reconstruct only the original author selection, never a newer manuscript or confirmation. */
export function reviewRevisionRequest(context: ReviewRevisionContext): PrepareReviewRevisionRequest {
  return { operation: context.operation, draftId: context.source.id,
    expectedDraft: { chapterNumber: context.source.chapterNumber, version: context.source.version,
      status: context.source.status, contentHash: context.sourceHash },
    authorInputs: structuredClone(context.authorInputs), uiLocale: context.uiLocale,
    ...(context.confirmation ? { reviewSourceId: context.confirmation.reviewSourceId, confirmedReviewContent: context.confirmation.content } : {}),
    ...(context.recheck ? { reviewCycleId: context.recheck.cycleId, expectedMergedHash: context.recheck.mergedHash } : {}) }
}

/**
 * Captured DB is the authority. The returned material is also re-read on dispatch/resume/save.
 *
 * Only the project id enters the captured identity: the session lease (`epoch`) is deliberately
 * NOT an input, so the result is a pure function of `(db, request)` and therefore identical across
 * a reopen. The live lease is attached to the `SourceRef` at the point of use instead.
 */
export function captureReviewRevisionContext(db: Database.Database, request: PrepareReviewRevisionRequest,
  projectId: string, frozenRecheckVersion?: 1 | 2): ReviewRevisionContext {
  if (!request || Object.keys(request).some(key => !['operation', 'draftId', 'expectedDraft', 'reviewSourceId', 'confirmedReviewContent', 'reviewCycleId', 'expectedMergedHash', 'authorInputs', 'uiLocale'].includes(key))
    || !REVIEW_REVISION_OPERATIONS.includes(request.operation) || !Number.isSafeInteger(request.draftId) || request.draftId < 1
    || !['zh-CN', 'en-US'].includes(request.uiLocale) || !request.expectedDraft
    || Object.keys(request.expectedDraft).some(key => !['chapterNumber', 'version', 'status', 'contentHash'].includes(key))
    || !Array.isArray(request.authorInputs) || request.authorInputs.length > 2) fail()
  const allowedInputs = request.operation === 'refine-draft' ? ['user-prompt', 'merged-guidance'] : request.operation === 'review-chapter' ? ['review-focus'] : []
  if (new Set(request.authorInputs.map(item => item?.id)).size !== request.authorInputs.length
    || request.authorInputs.some(item => !item || Object.keys(item).some(key => !['id', 'text'].includes(key))
      || !allowedInputs.includes(item.id) || typeof item.text !== 'string' || Buffer.byteLength(item.text) > 8 * 1024 * 1024)) fail()
  if (request.operation !== 'refine-from-review' && (request.reviewSourceId !== undefined || request.confirmedReviewContent !== undefined)) fail()
  const recheckRequested = request.reviewCycleId !== undefined || request.expectedMergedHash !== undefined
  if (recheckRequested && (request.operation !== 'review-chapter' || typeof request.reviewCycleId !== 'string'
    || !request.reviewCycleId.trim() || typeof request.expectedMergedHash !== 'string')) fail()
  return db.transaction((): ReviewRevisionContext => {
    const source = db.prepare('SELECT d.id,d.chapter_number AS chapterNumber,d.version,d.status,c.body AS content FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?')
      .get(request.draftId) as ExpectedDraftSource | undefined
    const latest = source && db.prepare("SELECT id FROM drafts WHERE chapter_number=? AND status IN ('draft','revised','reviewed','finalized') ORDER BY version DESC,id DESC LIMIT 1").pluck().get(source.chapterNumber)
    if (!source || latest !== source.id || !isDeepStrictEqual(request.expectedDraft,
      { chapterNumber: source.chapterNumber, version: source.version, status: source.status, contentHash: textHash(source.content) }))
      throw new Error('GENERATION_REVIEW_SOURCE_CHANGED')
    let recheck: ReviewRevisionContext['recheck']
    if (recheckRequested) {
      const plan = ReviewCycleRepository.planRecheck(request.reviewCycleId!, db)
      if (plan.disposition !== 'required' || !plan.context || plan.context.mergedHash !== request.expectedMergedHash
        || textHash(source.content) !== plan.context.mergedHash) throw new Error('GENERATION_REVIEW_RECHECK_NOT_REQUIRED')
      recheck = frozenRecheckVersion === 1 ? { ...plan.context, version: 1 } : plan.context
    }
    const core = ProjectCoreRepository.get(db)
    if (!core) throw new Error('GENERATION_REVIEW_CONTEXT_INVALID')
    const config: NovelConfig = { genre: core.genre, subGenre: core.subGenre, targetAudience: core.targetAudience,
      totalChapters: core.totalChapters, wordsPerChapter: core.wordsPerChapter, writingLanguage: core.writingLanguage,
      creativeStrategy: core.creativeStrategy, narrativeThreadDormantChapterThreshold: core.narrativeThreadDormantChapterThreshold,
      plotStructure: core.plotStructure as NovelConfig['plotStructure'], narrativePOV: core.narrativePov as NovelConfig['narrativePOV'],
      writingStyle: core.writingStyle, referenceWorks: core.referenceWorks, globalGuidance: core.globalGuidance,
      goldenFinger: core.goldenFinger, coreOutline: core.coreOutline, worldSetting: core.worldSetting, protagonistProfile: core.protagonistProfile }
    let confirmation: ReviewRevisionContext['confirmation']
    if (request.operation === 'refine-from-review') {
      if (!Number.isSafeInteger(request.reviewSourceId) || request.reviewSourceId! < 1 || typeof request.confirmedReviewContent !== 'string') fail()
      const stored = ReviewRepository.getFull(request.reviewSourceId!, db)
      const snapshot = stored && parseHumanConfirmedReviewSnapshot(stored.content)
      const requested = parseHumanConfirmedReviewSnapshot(request.confirmedReviewContent!)
      const original = snapshot && ReviewRepository.getFull(snapshot.sourceReviewId, db)
      if (!stored || !snapshot || !requested || !original || snapshot.sourceReviewId === stored.id
        || !isDeepStrictEqual(stored.sourceDraft, source) || !isDeepStrictEqual(snapshot.sourceDraft, source)
        || !isDeepStrictEqual(original.sourceDraft, source) || stored.baseDraftId !== source.id || original.baseDraftId !== source.id
        || !snapshot.items.some(item => item.decision === 'apply')
        || serializeHumanConfirmedReviewSnapshot(snapshot) !== serializeHumanConfirmedReviewSnapshot(requested))
        throw new Error('GENERATION_REVIEW_CONFIRMATION_CHANGED')
      confirmation = { reviewSourceId: stored.id, content: serializeHumanConfirmedReviewSnapshot(snapshot), snapshot,
        originalReviewContentHash: textHash(original.content) }
    }
    const blueprints = BlueprintRepository.getAll(db).filter(row => row.chapterNumber >= source.chapterNumber && row.chapterNumber <= source.chapterNumber + 5)
      .map(({ chapterNumber, title, role, purpose, keyEvents, characters, suspenseHook, userGuidance, notes }) =>
        ({ chapterNumber, title, role, purpose, keyEvents, characters, suspenseHook, userGuidance, notes }))
    const currentBlueprint = blueprints.find(row => row.chapterNumber === source.chapterNumber)
    const projections = SummaryRepository.listFinalizedContinuityBefore(source.chapterNumber, db)
    const rows = db.prepare("SELECT d.id,d.chapter_number,d.version,c.body,o.finalization_id,o.chapter_title,o.content_hash,o.content_snapshot FROM drafts d JOIN contents c ON c.id=d.content_id LEFT JOIN finalization_outbox o ON o.draft_id=d.id WHERE d.status='finalized' AND d.chapter_number < ? AND NOT EXISTS (SELECT 1 FROM drafts n WHERE n.chapter_number=d.chapter_number AND n.status='finalized' AND (n.version>d.version OR n.version=d.version AND n.id>d.id)) ORDER BY d.chapter_number,d.id")
      .all(source.chapterNumber) as { id: number; chapter_number: number; version: number; body: string; finalization_id: string | null; chapter_title: string | null; content_hash: string | null; content_snapshot: string | null }[]
    const history = rows.map(row => {
      if (row.finalization_id && (row.content_hash !== textHash(row.body) || row.content_snapshot !== row.body))
        throw new Error('GENERATION_REVIEW_HISTORY_CHANGED')
      const contentHash = textHash(row.body)
      const sourceIdentity = row.finalization_id ? { draftId: row.id, finalizationId: row.finalization_id, chapterNumber: row.chapter_number, contentHash } : undefined
      const projection = projections.find(item => item.draftId === row.id && item.sourceStatus === 'current' && isDeepStrictEqual(item.source, sourceIdentity))
      // 只增不减：身份走共享选择契约，不改变任何现有消费方读取的字段。
      // 有终稿 outbox 凭据的是已证明的定稿；否则是旧版定稿（legacy），两者都不是 author。
      // 身份**不含会话租约**：租约由使用方按当前会话补上，重开后同一份材料身份逐字段不变。
      const materialIdentity: ReviewMaterialIdentity = { projectId,
        sourceId: `finalized:${row.id}`, revision: row.id, contentHash,
        provenance: row.finalization_id ? 'finalized' : 'legacy' }
      return { draftId: row.id, chapterNumber: row.chapter_number, chapterTitle: row.chapter_title ?? '', content: row.body,
        identity: materialIdentity, ...(sourceIdentity ? { source: sourceIdentity } : {}), ...(projection ? { projection } : {}) }
    })
    // The draft already records the author's selected predecessor. Never substitute a newer row.
    const dependencies = JSON.parse(db.prepare('SELECT source_dependencies FROM drafts WHERE id=?').pluck().get(source.id) as string)
    if (!Array.isArray(dependencies)) throw new Error('GENERATION_REVIEW_HISTORY_CHANGED')
    let predecessor: ReviewRevisionContext['predecessor']
    for (const dependency of dependencies) {
      if (dependency?.kind !== undefined && dependency.kind !== 'candidate') continue
      if (!Number.isSafeInteger(dependency?.draftId) || typeof dependency.contentHash !== 'string')
        throw new Error('GENERATION_REVIEW_HISTORY_CHANGED')
      const row = db.prepare('SELECT d.id,d.chapter_number,d.version,d.status,c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.id=?')
        .get(dependency.draftId) as { id: number; chapter_number: number; version: number; status: string; body: string } | undefined
      if (!row || textHash(row.body) !== dependency.contentHash || !['draft', 'revised', 'reviewed', 'finalized', 'archived'].includes(row.status))
        throw new Error('GENERATION_REVIEW_HISTORY_CHANGED')
      if (row.chapter_number !== source.chapterNumber - 1 || history.some(item => item.draftId === row.id)) continue
      if (predecessor) throw new Error('GENERATION_REVIEW_HISTORY_CHANGED')
      predecessor = { draftId: row.id, chapterNumber: row.chapter_number, chapterTitle: '', content: row.body,
        identity: { projectId, sourceId: `candidate:${row.id}`, revision: row.version,
          contentHash: dependency.contentHash, provenance: 'generated' } }
    }
    const activeIds = new Set((db.prepare('SELECT character_id FROM characters WHERE retired=0').all() as { character_id: string }[]).map(row => row.character_id))
    const authorCards = CharacterRepository.getAll(db).filter(card => card.characterId && activeIds.has(card.characterId))
    const stateLines = authorCards.flatMap(card => {
      const state = card.currentState
      if (!state) return []
      const fields = Object.fromEntries(CHARACTER_STATE_TEXT_FIELDS.flatMap(field => {
        const provenance = state.provenance?.[field]
        return provenance?.kind === 'author' && state[field] ? [[field, `${state[field]} @ch${provenance.chapterNumber}`]] : []
      }))
      if (!Object.keys(fields).length) return []
      return [core.writingLanguage === 'en-US'
        ? `${card.name} (${card.role || 'unknown'}) author state (time-bound to the annotated chapter, not permanent): ${JSON.stringify(fields)}`
        : `${card.name}（${card.role || '未知'}）作者状态（按标注章节理解，非永久约束）: ${JSON.stringify(fields)}`]
    })
    return { version: 1, operation: request.operation, source, sourceHash: textHash(source.content), config,
      writingLanguage: core.writingLanguage, uiLocale: request.uiLocale, authorInputs: structuredClone(request.authorInputs),
      characterStates: stateLines.join('\n') || (core.writingLanguage === 'en-US' ? '(none)' : '（暂无）'),
      worldbuilding: core.worldbuilding, history, blueprints, ...(predecessor ? { predecessor } : {}),
      frozenGoals: freezeChapterGoals(source.chapterNumber, currentBlueprint?.keyEvents,
        [core.worldSetting, ...authorCards.map(card => card.notes)]),
      preflightFindings: [
        ...(currentBlueprint ? findBlueprintContinuityRisks(history.flatMap(item => item.projection ? [item.projection] : []), currentBlueprint, ConsistencyExemptionRepository.list(db)) : []),
        // 正文层的跨章重复（issue #32 场景装置 / #33 人物反应句式）：审稿的「跨章重复」
        // 维度对「同构写法」0 命中（本样本 19 份报告只报出 1 条逐字复写），这里用可机器判的
        // 分布判据补上——样本是**最近定稿正文 + 本章正文**，正是审稿该看的范围。
        ...proseRepetitionFindings([...history.map(item => ({ chapterNumber: item.chapterNumber, content: item.content })),
          { chapterNumber: source.chapterNumber, content: source.content }], source.chapterNumber,
          authorCards.map(card => card.name)),
        // 贯穿性编号的自洽（issue #47）：只做「声明 N 位、紧随数字不是 N 位」这一类——
        // 命中即错，不需要词表。样本是本章正文（最近定稿的编号体系在前面章节里，
        // 但「同一句自相矛盾」永远发生在当章）。
        ...numberingFindings({ chapterNumber: source.chapterNumber, content: source.content }),
        // 能力／资源上限的自相矛盾（issue #51）：第 13 章同一段先说「最后一次溯读已经用尽、
        // 本班次再读不出第二处」，紧接着又写「一行字浮出来」——核心能力的定价机制被自己作废。
        ...abilityBudgetFindings({ chapterNumber: source.chapterNumber, content: source.content }),
        // 跨章「断言反转」（issue #52）：第 16 章正文「是叶九的手」，第 19 章正文「不是叶九的手」，
        // 而第 19 章整章推理架在后一句上。比对源是**前序定稿正文**——它们与本章正文都在这份上下文里。
        ...assertionReversalFindings(
          history.map(item => ({ chapterNumber: item.chapterNumber, content: item.content })),
          { chapterNumber: source.chapterNumber, content: source.content },
          authorCards.map(card => card.name),
        ),
        // 蓝图自报的收束类型与正文最后一幕不符（issue #65）：10 章有 7 章不符，
        // 而下一章正是拿这个标签做「不得重复上一章落幅」（#28）——标错等于把轮换
        // 约束建立在假信息上。只核对能可靠判断的三对（对话/物件/动作），其余不比。
        ...findClosingLabelConflicts(
          currentBlueprint && currentBlueprint.keyEvents
            ? [{ chapterNumber: source.chapterNumber, label: closingShotOf(currentBlueprint.keyEvents), content: source.content }]
            : [],
        ),
        // 连续几章都以「通牒式台词」收尾（issue #66）：与 #28 的「画面同构」不同，
        // 这是**语用**收敛——每章都有人用一句话把主角逼到二选一。样本 = 最近定稿 + 本章。
        // 早先章节点名本章的伏笔没有落地（issue #68）：蓝图里写明「留待第 N 章揭开」
        // 之后，原来没有任何环节回头核对第 N 章到底写没写。这里用全量蓝图解析承诺，
        // 只保留指向本章的，再问正文里能否检索到它的实体词。
        ...findUndeliveredForeshadowing({
          chapterNumber: source.chapterNumber,
          content: source.content,
          commitments: foreshadowingDueAt(parseForeshadowingCommitments(BlueprintRepository.getAll(db)), source.chapterNumber),
        }),
        // 章首句式收敛（issue #71）：前几轮补的是章末（#28/#65/#66）与正文内部
        // （#32/#33/#49），章首这一轴一直是空的。样本 = 最近定稿 + 本章。
        ...findOpeningShapeConvergence({
          chapters: [...history.slice(-5).map(item => ({ chapterNumber: item.chapterNumber, content: item.content })),
            { chapterNumber: source.chapterNumber, content: source.content }],
          castNames: authorCards.map(card => card.name),
          currentChapter: source.chapterNumber,
        }),
        // 同一线索的揭示句式在多章重复（issue #72）：样本里隐藏主线每次都靠
        // 「你爸当年也…」+ 收口推进，5 章同一句式而后半句各不相同。
        ...findDialogueOpenerConvergence({
          chapters: [...history.map(item => ({ chapterNumber: item.chapterNumber, content: item.content })),
            { chapterNumber: source.chapterNumber, content: source.content }],
          castNames: authorCards.map(card => card.name),
          currentChapter: source.chapterNumber,
        }),
        ...findUltimatumStreak({
          chapters: [...history.slice(-4).map(item => ({ chapterNumber: item.chapterNumber, content: item.content })),
            { chapterNumber: source.chapterNumber, content: source.content }],
          currentChapter: source.chapterNumber,
        }),
        // 字形断言与偏旁实际部首不符（issue #99）：第 45 章「半个“温”字……立人旁」、
        // 第 43 章「先露走之底……徐」——两处都是该章唯一的身份判据，两处都错。
        // 样本 = **本章正文**（审稿时这一章还没定稿，正是能改的时候）；历史章不再重复报
        // （它们要么已定稿只读、要么已在上一轮审稿里提示过）。
        ...glyphRadicalFindings([{ chapterNumber: source.chapterNumber, content: source.content }]),
        // 角色名漂移（issue #102）：本章把「陆敬堂」写成「穆敬堂」。审稿合同只管
        // 「同一场所/职级/编号是否被写成不同名称」（维度 8），而**人名**这一层
        // 没有任何地方核对名册——模型报出过，却停在 unresolved、不阻断定稿。
        // 样本 = 本章正文 + 已定稿历史（历史章里那个异姓写法顺带一起报，指出是哪一章）。
        ...findCastNameDriftFindings({
          chapters: [...history.map(item => ({ chapterNumber: item.chapterNumber, content: item.content })),
            { chapterNumber: source.chapterNumber, content: source.content }],
          castNames: authorCards.map(card => card.name),
        }),
        // 期限宣告未对账（issue #101）：本章是否把**上一章**抛出的期限做了交代。
        // 样本 = 上一章 + 本章（审稿时本章还在手边，正是能补的时候）。
        ...findUnsettledDeadlineFindings({
          chapters: [
            ...history.slice(-1).map(item => ({ chapterNumber: item.chapterNumber, content: item.content })),
            { chapterNumber: source.chapterNumber, content: source.content },
          ],
          currentChapter: source.chapterNumber,
        }),
        // 重复宣告的不可逆处境变更（issue #105）：账本记两遍不可逆、第一次从未落地。
        // 样本与写前预检一致——账本（全部蓝图 costsAndTurns）+ 已定稿正文 + 本章。
        ...findRepeatedRevocationFindings({
          ledger: BlueprintRepository.getAll(db).map(row => ({ chapterNumber: row.chapterNumber, costs: row.costsAndTurns ?? '' })),
          prose: [...history.map(item => ({ chapterNumber: item.chapterNumber, content: item.content })),
            { chapterNumber: source.chapterNumber, content: source.content }],
          castNames: authorCards.map(card => card.name),
        }),
      ],
      ...(confirmation ? { confirmation } : {}), ...(recheck ? { recheck } : {}) }
  })()
}
