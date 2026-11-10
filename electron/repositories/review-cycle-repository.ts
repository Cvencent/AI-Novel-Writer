import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { canonicalM03FindingSetHash, verifyM03ReviewCycle, type M03FindingDescriptor } from '../migrations/m03-review-cycle'
import { parseHumanConfirmedReviewSnapshot, type HumanConfirmedReviewSnapshot } from '../../src/shared/human-confirmed-review'
import { classifyFindingEvidenceChange, unshownMustShowRecheckFindings, type ReviewCycleRecheckContext,
  type ReviewCycleRecheckFinding, type ReviewCycleProjection } from '../../src/shared/review-cycle'

const HASH = /^[a-f0-9]{64}$/u
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const record = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && Number(value) >= minimum
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => (
  Object.keys(value).sort().join() === [...keys].sort().join()
)

export interface ReviewCycleSource {
  projectId: string
  epoch: string
  sourceId: string
  revision: number
  contentHash: string
}

export interface CreateReviewCycleInput {
  rootActionId: string
  reviewId: number
  reviewContentHash: string
  source: ReviewCycleSource
}

export interface CreatedReviewCycle {
  cycleId: string
  findingSetHash: string
  findingCount: number
}

export interface AttachGeneratedRevisionInput {
  cycleId: string
  rootActionId: string
  confirmationReviewId: number
  confirmationContentHash: string
  revisionId: number
  revisionContentHash: string
}

export interface GeneratedRevisionBinding {
  cycleId: string
  confirmationReviewId: number
  revisionId: number
  revisionStatus: 'generated'
  idempotent: boolean
}

export interface AuthorConfirmationBinding {
  cycleId: string
  confirmationReviewId: number
  confirmationContentHash: string
  waivedFindingCount: number
  idempotent: boolean
}

export interface MergeCommittedCycle {
  revisionId: number
  bound: boolean
  cycleId?: string
  revisionStatus?: 'merge-committed'
  idempotent: boolean
}

export interface ReviewCycleRecheckPlan {
  disposition: 'required' | 'not-required' | 'completed'
  context: ReviewCycleRecheckContext | null
  rootActionId: string
  reviewId: number
}

export interface CommittedReviewCycleRecheck {
  cycleId: string
  attemptId: string
  recheckCount: 1
  idempotent: boolean
}

export interface DiscardedRevisionReconciliation {
  revisionId: number
  detached: boolean
}

export interface DiscardedRevisionsReconciliation {
  revisionIds: number[]
  detached: number
}

interface ReviewRow {
  base_draft_id: number
  source_draft_version: number | null
  source_content: string | null
  body: string
}

interface CycleBindingRow {
  cycle_id: string
  root_action_id: string
  review_id: number
  confirmation_review_id: number | null
  confirmation_content_hash: string | null
  revision_id: number | null
  source_hash: string
  revision_status: 'not-generated' | 'generated' | 'merge-committed'
}

interface RecheckCycleRow {
  cycle_id: string
  root_action_id: string
  review_id: number
  finding_set_hash: string
  comparison_version: number
  revision_status: string
  merged_hash: string | null
  recheck_count: number
  recheck_attempt_id: string | null
  source_content: string | null
  merged_body: string
}

interface RecheckFindingRow {
  finding_id: string
  target_id: string | null
  category: string
  kind: 'objective' | 'literary'
  problem_text: string
  expected_text: string | null
  status: string
  span_start: number | null
  span_end: number | null
  span_unit: string | null
  occurrence: number | null
}

interface SourceBoundRow {
  base_draft_id: number
  source_draft_chapter_number: number | null
  source_draft_version: number | null
  source_draft_status: string | null
  source_content: string | null
  body: string
}

interface SavedItem {
  index: number
  category: string
  severity: 'error' | 'warning' | 'pass' | 'unknown'
  description: string
  quote?: string
  goalId?: string
  stableFactKey?: string
}

interface SavedGoal {
  id: string
  text: string
  description: string
  status: 'completed' | 'unmet' | 'unknown'
  evidence: readonly { quote: string; start: number; end: number }[]
}

interface SavedReport {
  items: SavedItem[]
  goals: SavedGoal[]
}

function invalid(): never { throw new Error('REVIEW_CYCLE_INPUT_INVALID') }
function conflict(): never { throw new Error('REVIEW_CYCLE_CONFLICT') }

/**
 * 读路径的 M03 校验缓存：同一数据库 1 秒内的重复读取只做一次完整证明。
 *
 * 证明本身要对全库 attempt 做内容级校验（单次 ~80ms）；单章视图一次会读多个
 * 周期、章节事实又会对每一稿各读一次——3000 章的书上这是分钟级的串行开销，
 * 主进程被拖死就是「动不动未响应」。只缓存**成功**：失败立即返回且清掉缓存。
 */
let m03ReadCache: { db: Database.Database; at: number } | null = null
function verifyM03ForRead(db: Database.Database): boolean {
  const now = Date.now()
  if (m03ReadCache && m03ReadCache.db === db && now - m03ReadCache.at < 1000) return true
  const ok = verifyM03ReviewCycle(db)
  m03ReadCache = ok ? { db, at: now } : null
  return ok
}

function parseSavedReport(body: string): SavedReport {
  let raw: unknown
  try { raw = JSON.parse(body) } catch { invalid() }
  const report = record(raw)
  if (!report || !exactKeys(report, ['summary', 'items', 'goalReview'])
    || !nonempty(report.summary) || !Array.isArray(report.items) || report.items.length === 0) invalid()
  const goalReview = record(report.goalReview)
  if (!goalReview || !exactKeys(goalReview, ['version', 'chapterNumber', 'coverage', 'items'])
    || goalReview.version !== 1 || !integer(goalReview.chapterNumber, 1)
    || !['complete', 'unknown', 'not_configured'].includes(String(goalReview.coverage))
    || !Array.isArray(goalReview.items)) invalid()

  const goalIds = new Set<string>()
  const goals = goalReview.items.map((value): SavedGoal => {
    const item = record(value)
    if (!item || !exactKeys(item, ['id', 'text', 'status', 'description', 'evidence'])
      || !nonempty(item.id) || goalIds.has(item.id) || !nonempty(item.text) || !nonempty(item.description)
      || !['completed', 'unmet', 'unknown'].includes(String(item.status)) || !Array.isArray(item.evidence)) invalid()
    goalIds.add(item.id)
    const evidence = item.evidence.map((entry) => {
      const proof = record(entry)
      if (!proof || !exactKeys(proof, ['quote', 'start', 'end']) || !nonempty(proof.quote)
        || !integer(proof.start) || proof.end !== Number(proof.start) + proof.quote.length) invalid()
      return { quote: proof.quote, start: Number(proof.start), end: Number(proof.end) }
    })
    if (item.status !== 'unknown' && evidence.length === 0) invalid()
    return { id: item.id, text: item.text, description: item.description,
      status: item.status as SavedGoal['status'], evidence }
  })

  const items = report.items.map((value, index): SavedItem => {
    const item = record(value)
    if (!item || Object.keys(item).some(key => ![
      'category', 'severity', 'description', 'quote', 'goalId', 'stableFactKey', 'sourceChapter',
    ].includes(key)) || !nonempty(item.category) || !nonempty(item.description)
      || !['error', 'warning', 'pass', 'unknown'].includes(String(item.severity))
      || (item.quote !== undefined && !nonempty(item.quote))
      || (item.goalId !== undefined && (!nonempty(item.goalId) || !goalIds.has(item.goalId)))
      || (item.stableFactKey !== undefined && !nonempty(item.stableFactKey))
      || (item.goalId !== undefined && item.stableFactKey !== undefined)
      || (item.stableFactKey !== undefined && (item.severity !== 'warning' || !nonempty(item.quote)
        || !integer(item.sourceChapter, 1)))
      || (item.sourceChapter !== undefined && (item.stableFactKey === undefined || !integer(item.sourceChapter, 1)))) invalid()
    return { index, category: item.category, severity: item.severity as SavedItem['severity'], description: item.description,
      ...(item.quote === undefined ? {} : { quote: item.quote }),
      ...(item.goalId === undefined ? {} : { goalId: item.goalId }),
      ...(item.stableFactKey === undefined ? {} : { stableFactKey: item.stableFactKey }) }
  })
  for (const goal of goals) {
    const projections = items.filter(item => item.goalId === goal.id)
    const expectedSeverity = goal.status === 'completed' ? 'pass' : goal.status === 'unmet' ? 'error' : 'unknown'
    const expectedQuote = goal.evidence.length ? goal.evidence.map(item => item.quote).join('\n') : undefined
    if (projections.length !== 1 || projections[0]!.severity !== expectedSeverity
      || projections[0]!.quote !== expectedQuote) invalid()
  }
  return { items, goals }
}

function locateUnique(source: string, quote: string): { start: number; end: number } | null {
  const start = source.indexOf(quote)
  return start >= 0 && source.indexOf(quote, start + 1) < 0 ? { start, end: start + quote.length } : null
}

/**
 * 目标型意见的锚定引文（issue #124）。
 *
 * 旧判据是 `goal.evidence.length === 1 ? goal.evidence[0].quote : null`——**证据多于一条就整条不锚定**。
 * 实测那本 55 章的书：38 条目标型意见里 26 条带多条证据，而这 26 条的引文**全部**能唯一定位
 * （26/26），却因为条数判据一律落成 `unverified`，于是 `recheckContext` / `disposition` 整条跳过、
 * 合并后永不复验。而「本章目标 unmet」恰好是审稿里唯一直接说明「蓝图事件没写出来」的结论。
 *
 * 「能不能自动复验」的依据是**有没有一条引文能唯一定位**，不是证据总条数是不是 1。
 * 取模型给出顺序里第一条能唯一定位的证据做锚（确定性），其余证据仍留在审稿报告里给作者看。
 * 一条也定位不到的（含零证据的 unknown 目标）仍返回 null → 仍落 `unverified`，口径没有放松。
 */
function goalAnchorQuote(sourceText: string, goal: SavedGoal): string | null {
  for (const item of goal.evidence) if (locateUnique(sourceText, item.quote) !== null) return item.quote
  return null
}

/**
 * 把一条审稿意见锚定到源稿（issue #7）。
 *
 * 旧判据是 `targetId !== null && span !== null`——**只有目标型意见才会被锚定**。
 * 正常审稿的文笔/连贯性意见没有 stableFactKey，于是 `targetId` 恒为 null，
 * 于是 `status` 直接落成 `unverified`，于是 `recheckContext` 整条跳过、
 * `disposition` 返回 `not-required`、合并后**永远不会复验**。
 * 实测两章的共同问题（数字链条、时段冲突）全是普通意见，一条都没进复验。
 *
 * 但原稿的引用句明明能在源稿里唯一定位——这才是「能不能复验」的真正依据。
 * 现在：**引文能唯一定位就锚定**，`targetId` 只用于目标验收那一路。
 * 确实定位不到原文的意见仍然落成 `unverified`（那才是「不可复验」的本来含义）。
 */
function finding(input: {
  source: ReviewCycleSource
  sourceText: string
  category: string
  targetId: string | null
  kind: 'objective' | 'literary'
  problemText: string
  expectedText?: string
  quote: string | null
  anchoredStatus: 'unresolved' | 'unknown'
  logicalIdentity: string
}): M03FindingDescriptor {
  const span = input.quote === null ? null : locateUnique(input.sourceText, input.quote)
  const anchored = span !== null
  const descriptor: M03FindingDescriptor = {
    findingId: '',
    source: { ...input.source, span: anchored ? { ...span, unit: 'utf16-code-unit' } : null },
    excerptHash: anchored ? hash(input.quote!) : null,
    occurrence: anchored ? 1 : null,
    category: input.category,
    // 非目标型意见仍然带 targetId（schema 的 CHECK 要求锚定行必须有 target_id）。
    // 用 `free:<序号>` 而不是 stableFactKey：它只用来满足不变式与复验回执的配对，
    // 不参与目标验收（那一路读的是 stableFactKey / goalId）。
    targetId: anchored ? (input.targetId ?? `free:${input.logicalIdentity}`) : null,
    kind: input.kind,
    problemText: input.problemText,
    expectedText: input.expectedText ?? null,
    status: anchored ? input.anchoredStatus : 'unverified',
    evidenceHash: null,
    confirmationItemIndex: null,
  }
  const identity = { sourceProjectId: descriptor.source.projectId, sourceEpoch: descriptor.source.epoch,
    sourceId: descriptor.source.sourceId, sourceRevision: descriptor.source.revision,
    sourceContentHash: descriptor.source.contentHash, spanStart: descriptor.source.span?.start ?? null,
    spanEnd: descriptor.source.span?.end ?? null, spanUnit: descriptor.source.span?.unit ?? null,
    excerptHash: descriptor.excerptHash, occurrence: descriptor.occurrence, category: descriptor.category,
    targetId: descriptor.targetId, kind: descriptor.kind, logicalIdentity: input.logicalIdentity }
  descriptor.findingId = `finding:${hash(JSON.stringify(identity))}`
  return descriptor
}

function buildFindings(report: SavedReport, source: ReviewCycleSource, sourceText: string): M03FindingDescriptor[] {
  const result: M03FindingDescriptor[] = []
  const findingById = new Map<string, M03FindingDescriptor>()
  const add = (item: M03FindingDescriptor) => {
    const existing = findingById.get(item.findingId)
    if (!existing) {
      result.push(item)
      findingById.set(item.findingId, item)
    } else if (existing.status !== item.status && item.status === 'unresolved') existing.status = 'unresolved'
  }
  for (const goal of report.goals) {
    if (goal.evidence.some(item => sourceText.slice(item.start, item.end) !== item.quote)) invalid()
    if (goal.status === 'completed') continue
    const projection = report.items.find(item => item.goalId === goal.id)!
    const quote = goalAnchorQuote(sourceText, goal)
    add(finding({ source, sourceText, category: projection.category, targetId: goal.id, kind: 'objective', quote,
      problemText: projection.description, expectedText: `${goal.text}\n${goal.description}`,
      anchoredStatus: goal.status === 'unknown' ? 'unknown' : 'unresolved', logicalIdentity: `goal:${goal.id}` }))
  }
  for (const item of report.items) {
    if (item.severity === 'pass' || item.goalId) continue
    const objective = item.stableFactKey !== undefined
    add(finding({ source, sourceText, category: item.category, targetId: item.stableFactKey ?? null,
      kind: objective ? 'objective' : 'literary', quote: item.quote ?? null, problemText: item.description,
      anchoredStatus: 'unresolved',
      logicalIdentity: objective ? `preflight:${item.stableFactKey}` : `free:${item.index}` }))
  }
  return result
}

function cycleId(input: CreateReviewCycleInput): string {
  return `cycle:${hash(JSON.stringify([input.rootActionId, input.reviewId, input.reviewContentHash]))}`
}

function persistedFinding(row: Record<string, unknown>): M03FindingDescriptor {
  return {
    findingId: row.finding_id as string,
    source: { projectId: row.source_project_id as string, epoch: row.source_epoch as string,
      sourceId: row.source_id as string, revision: row.source_revision as number,
      contentHash: row.source_content_hash as string, span: row.span_start === null ? null
        : { start: row.span_start as number, end: row.span_end as number, unit: 'utf16-code-unit' } },
    excerptHash: row.excerpt_hash as string | null,
    occurrence: row.occurrence as number | null,
    category: row.category as string,
    targetId: row.target_id as string | null,
    kind: row.kind as M03FindingDescriptor['kind'],
    problemText: row.problem_text as string,
    expectedText: row.expected_text as string | null,
    status: row.status as M03FindingDescriptor['status'],
    evidenceHash: row.evidence_hash as string | null,
    confirmationItemIndex: row.confirmation_item_index as number | null,
  }
}

function sourceMatches(left: SourceBoundRow, right: SourceBoundRow): boolean {
  return left.base_draft_id === right.base_draft_id
    && left.source_draft_chapter_number === right.source_draft_chapter_number
    && left.source_draft_version === right.source_draft_version
    && left.source_draft_status === right.source_draft_status
    && left.source_content !== null && left.source_content === right.source_content
}

function validateGeneratedBinding(input: AttachGeneratedRevisionInput, cycle: CycleBindingRow,
  db: Database.Database): { baseDraftId: number; snapshot: HumanConfirmedReviewSnapshot } {
  const review = db.prepare(`SELECT r.base_draft_id,r.source_draft_chapter_number,r.source_draft_version,
      r.source_draft_status,r.source_content,c.body FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?`)
    .get(cycle.review_id) as SourceBoundRow | undefined
  const confirmation = db.prepare(`SELECT r.base_draft_id,r.source_draft_chapter_number,r.source_draft_version,
      r.source_draft_status,r.source_content,c.body FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?`)
    .get(input.confirmationReviewId) as SourceBoundRow | undefined
  const revision = db.prepare(`SELECT r.base_draft_id,r.source_draft_chapter_number,r.source_draft_version,
      r.source_draft_status,r.source_content,r.review_source_id,r.status,c.body
      FROM revisions r JOIN contents c ON c.id=r.content_id WHERE r.id=?`).get(input.revisionId) as
    (SourceBoundRow & { review_source_id: number | null; status: string }) | undefined
  const snapshot = confirmation && parseHumanConfirmedReviewSnapshot(confirmation.body)
  if (!review || !confirmation || !revision || !snapshot?.sourceDraft
    || hash(review.source_content ?? '') !== cycle.source_hash
    || !sourceMatches(review, confirmation) || !sourceMatches(review, revision)
    || hash(confirmation.body) !== input.confirmationContentHash
    || hash(revision.body) !== input.revisionContentHash
    || snapshot.sourceReviewId !== cycle.review_id || snapshot.sourceDraft.id !== review.base_draft_id
    || snapshot.sourceDraft.chapterNumber !== review.source_draft_chapter_number
    || snapshot.sourceDraft.version !== review.source_draft_version
    || snapshot.sourceDraft.status !== review.source_draft_status || snapshot.sourceDraft.content !== review.source_content
    || revision.review_source_id !== input.confirmationReviewId || revision.status !== 'pending') invalid()
  return { baseDraftId: review.base_draft_id, snapshot }
}

function validateAuthorConfirmation(cycle: CycleBindingRow, confirmationReviewId: number,
  db: Database.Database): { snapshot: HumanConfirmedReviewSnapshot; contentHash: string } {
  const review = db.prepare(`SELECT r.base_draft_id,r.source_draft_chapter_number,r.source_draft_version,
      r.source_draft_status,r.source_content,c.body FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?`)
    .get(cycle.review_id) as SourceBoundRow | undefined
  const confirmation = db.prepare(`SELECT r.base_draft_id,r.source_draft_chapter_number,r.source_draft_version,
      r.source_draft_status,r.source_content,c.body FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?`)
    .get(confirmationReviewId) as SourceBoundRow | undefined
  const snapshot = confirmation && parseHumanConfirmedReviewSnapshot(confirmation.body)
  if (!review || !confirmation || !snapshot?.sourceDraft || hash(review.source_content ?? '') !== cycle.source_hash
    || !sourceMatches(review, confirmation) || snapshot.sourceReviewId !== cycle.review_id
    || snapshot.sourceDraft.id !== review.base_draft_id
    || snapshot.sourceDraft.chapterNumber !== review.source_draft_chapter_number
    || snapshot.sourceDraft.version !== review.source_draft_version
    || snapshot.sourceDraft.status !== review.source_draft_status
    || snapshot.sourceDraft.content !== review.source_content) invalid()
  return { snapshot, contentHash: hash(confirmation.body) }
}

function bindAuthorWaivers(input: { cycleId: string; confirmationContentHash: string },
  snapshot: HumanConfirmedReviewSnapshot, db: Database.Database, apply: boolean): number {
  if (snapshot.schemaVersion === 1) return 0
  if (snapshot.cycleId !== input.cycleId) invalid()
  const findings = db.prepare(`SELECT finding_id,status,evidence_hash,confirmation_item_index
    FROM review_findings WHERE cycle_id=?`).all(input.cycleId) as Array<{ finding_id: string; status: string;
      evidence_hash: string | null; confirmation_item_index: number | null }>
  const byId = new Map(findings.map(finding => [finding.finding_id, finding]))
  const seen = new Set<string>()
  let waived = 0
  for (const [index, item] of snapshot.items.entries()) {
    if (item.origin !== 'ai' || item.findingId === undefined) continue
    if (seen.has(item.findingId) || !byId.has(item.findingId)) invalid()
    seen.add(item.findingId)
    if (item.decision !== 'waive') continue
    waived += 1
    const current = byId.get(item.findingId)!
    if (!apply) {
      if (current.status !== 'author-waived' || current.evidence_hash !== input.confirmationContentHash
        || current.confirmation_item_index !== index) conflict()
      continue
    }
    if (current.status === 'resolved') conflict()
    const result = db.prepare(`UPDATE review_findings
      SET status='author-waived',evidence_hash=?,confirmation_item_index=?
      WHERE cycle_id=? AND finding_id=? AND status<>'resolved'`)
      .run(input.confirmationContentHash, index, input.cycleId, item.findingId)
    if (result.changes !== 1) conflict()
  }
  return waived
}

function lineageSet(ids: Set<number>, id: number): boolean {
  return ids.has(id)
}

function reconcileDiscardedRevisionIds(db: Database.Database, revisionIds: readonly number[]): number {
  const cycles: Array<{ cycle_id: string; revision_id: number }> = []
  for (const revisionId of revisionIds) {
    const revision = db.prepare('SELECT status FROM revisions WHERE id=?').get(revisionId) as { status: string } | undefined
    if (!revision || revision.status !== 'discarded') conflict()
    const cycle = db.prepare('SELECT cycle_id,revision_status FROM review_cycles WHERE revision_id=?').get(revisionId) as {
      cycle_id: string; revision_status: string
    } | undefined
    if (cycle && cycle.revision_status !== 'generated') conflict()
    if (cycle) cycles.push({ cycle_id: cycle.cycle_id, revision_id: revisionId })
  }
  for (const cycle of cycles) {
    const result = db.prepare(`UPDATE review_cycles SET revision_id=NULL,revision_status='not-generated'
      WHERE cycle_id=? AND revision_id=? AND revision_status='generated'`).run(cycle.cycle_id, cycle.revision_id)
    if (result.changes !== 1) conflict()
  }
  return cycles.length
}

function detachDiscardedGeneratedCycles(db: Database.Database, baseDraftId: number, excludedCycleId: string): void {
  const rows = db.prepare(`SELECT rc.revision_id FROM review_cycles rc
    JOIN revisions r ON r.id=rc.revision_id
    WHERE rc.revision_status='generated' AND r.status='discarded' AND r.base_draft_id=? AND rc.cycle_id<>?`)
    .all(baseDraftId, excludedCycleId) as { revision_id: number }[]
  reconcileDiscardedRevisionIds(db, rows.map(row => row.revision_id))
}

function isCurrentMergedCycle(cycleId: string, mergedHash: string, db: Database.Database): boolean {
  const current = db.prepare(`SELECT c.body,v.revision_index,
      (SELECT MAX(newer.revision_index) FROM revisions newer
        WHERE newer.base_draft_id=v.base_draft_id AND newer.status='merged') AS latest_merged_index
    FROM review_cycles rc JOIN revisions v ON v.id=rc.revision_id
    JOIN drafts d ON d.id=v.base_draft_id JOIN contents c ON c.id=d.content_id WHERE rc.cycle_id=?`)
    .get(cycleId) as { body: string; revision_index: number; latest_merged_index: number | null } | undefined
  return Boolean(current && current.revision_index === current.latest_merged_index
    && hash(current.body) === mergedHash)
}

function readRecheckCycle(cycleId: string, db: Database.Database): RecheckCycleRow {
  const snapshot = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_cycle_merges'").get())
  const cycle = db.prepare(`SELECT rc.cycle_id,rc.root_action_id,rc.review_id,rc.finding_set_hash,rc.comparison_version,
      rc.revision_status,rc.merged_hash,rc.recheck_count,rc.recheck_attempt_id,r.source_content,
      ${snapshot ? 'm.body' : 'c.body'} AS merged_body
    FROM review_cycles rc JOIN reviews r ON r.id=rc.review_id JOIN revisions v ON v.id=rc.revision_id
    JOIN drafts d ON d.id=v.base_draft_id JOIN contents c ON c.id=d.content_id
    ${snapshot ? 'JOIN review_cycle_merges m ON m.cycle_id=rc.cycle_id' : ''} WHERE rc.cycle_id=?`)
    .get(cycleId) as RecheckCycleRow | undefined
  if (!cycle || cycle.revision_status !== 'merge-committed' || !cycle.merged_hash
    || !HASH.test(cycle.merged_hash) || cycle.source_content === null
    || hash(cycle.merged_body) !== cycle.merged_hash || !isCurrentMergedCycle(cycleId, cycle.merged_hash, db)
    || !verifyM03ForRead(db)) conflict()
  return cycle
}

function recheckContext(cycle: RecheckCycleRow, db: Database.Database): ReviewCycleRecheckContext {
  const rows = db.prepare(`SELECT finding_id,target_id,category,kind,problem_text,expected_text,status,span_start,span_end,span_unit,occurrence
    FROM review_findings WHERE cycle_id=? ORDER BY finding_id`).all(cycle.cycle_id) as RecheckFindingRow[]
  const findings: ReviewCycleRecheckFinding[] = []
  for (const row of rows) {
    if (['unverified', 'resolved', 'author-waived'].includes(row.status) || row.target_id === null
      || row.span_start === null || row.span_end === null || row.span_unit !== 'utf16-code-unit'
      || row.occurrence === null) continue
    const finding: ReviewCycleRecheckFinding = { findingId: row.finding_id, targetId: row.target_id,
      category: row.category, kind: row.kind,
      problem: row.problem_text, ...(row.expected_text ? { expected: row.expected_text } : {}),
      sourceSpan: { start: row.span_start, end: row.span_end, unit: 'utf16-code-unit' }, occurrence: row.occurrence,
      sourceExcerpt: cycle.source_content!.slice(row.span_start, row.span_end) }
    if (classifyFindingEvidenceChange(cycle.source_content!, cycle.merged_body, finding) === 'changed') findings.push(finding)
  }
  const sourceRows = db.prepare(`SELECT c.body AS review_body, cc.body AS confirmation_body
    FROM review_cycles rc JOIN reviews r ON r.id=rc.review_id JOIN contents c ON c.id=r.content_id
    LEFT JOIN reviews cr ON cr.id=rc.confirmation_review_id LEFT JOIN contents cc ON cc.id=cr.content_id
    WHERE rc.cycle_id=?`).get(cycle.cycle_id) as { review_body: string; confirmation_body: string | null }
  const originalReport = JSON.parse(sourceRows.review_body) as unknown
  const snapshot = sourceRows.confirmation_body ? parseHumanConfirmedReviewSnapshot(sourceRows.confirmation_body) : null
  const unshown = unshownMustShowRecheckFindings(originalReport, snapshot, rows.map(row => ({
    findingId: row.finding_id, kind: row.kind, status: row.status, targetId: row.target_id,
    problemText: row.problem_text, expectedText: row.expected_text,
  }))).filter(finding => classifyFindingEvidenceChange(cycle.source_content!, cycle.merged_body, finding) === 'changed')
  findings.push(...unshown)
  return { version: 2, cycleId: cycle.cycle_id, comparisonVersion: cycle.comparison_version,
    mergedHash: cycle.merged_hash!, findingSetHash: cycle.finding_set_hash,
    ...(unshown.length ? { sourceContent: cycle.source_content! } : {}), findings }
}

export class ReviewCycleRepository {
  static getByReviewId(reviewId: number, db: Database.Database): ReviewCycleProjection | null {
    if (!integer(reviewId, 1)) invalid()
    const cycle = db.prepare(`SELECT cycle_id,review_id,revision_status,merged_hash,recheck_count
      FROM review_cycles WHERE review_id=?`).get(reviewId) as { cycle_id: string; review_id: number;
        revision_status: ReviewCycleProjection['revisionStatus']; merged_hash: string | null; recheck_count: 0 | 1 } | undefined
    if (!cycle) return null
    if (!verifyM03ForRead(db)) conflict()
    const review = db.prepare(`SELECT r.source_content,c.body FROM reviews r
      JOIN contents c ON c.id=r.content_id WHERE r.id=?`).get(reviewId) as { source_content: string | null; body: string } | undefined
    if (!review || review.source_content === null) conflict()
    const report = parseSavedReport(review.body)
    const sourceRow = db.prepare(`SELECT source_project_id,source_epoch,source_id,source_revision,source_content_hash
      FROM review_findings WHERE cycle_id=? LIMIT 1`).get(cycle.cycle_id) as { source_project_id: string; source_epoch: string;
        source_id: string; source_revision: number; source_content_hash: string } | undefined
    const persisted = db.prepare(`SELECT finding_id,category,target_id,kind,status FROM review_findings
      WHERE cycle_id=? ORDER BY finding_id`).all(cycle.cycle_id) as Array<{ finding_id: string; category: string;
        target_id: string | null; kind: 'objective' | 'literary'; status: ReviewCycleProjection['findings'][number]['status'] }>
    if (!sourceRow && persisted.length) conflict()
    const itemIndex = new Map<string, number>()
    if (sourceRow) {
      const source: ReviewCycleSource = { projectId: sourceRow.source_project_id, epoch: sourceRow.source_epoch,
        sourceId: sourceRow.source_id, revision: sourceRow.source_revision, contentHash: sourceRow.source_content_hash }
      for (const item of report.items) {
        if (item.severity === 'pass') continue
        const goal = item.goalId ? report.goals.find(candidate => candidate.id === item.goalId) : undefined
        if (goal?.status === 'completed') continue
        const objective = item.stableFactKey !== undefined || Boolean(goal)
        // 必须与 buildFindings 用同一个锚定判据（issue #124）：这里重建 descriptor 只为反查
        // reviewItemIndex，判据一旦不一致，落库行就配不上界面行，多证据目标会再次从 UI 掉线。
        const descriptor = finding({ source, sourceText: review.source_content, category: item.category,
          targetId: goal?.id ?? item.stableFactKey ?? null, kind: objective ? 'objective' : 'literary',
          quote: goal ? goalAnchorQuote(review.source_content, goal) : item.quote ?? null,
          problemText: item.description, ...(goal ? { expectedText: `${goal.text}\n${goal.description}` } : {}),
          anchoredStatus: goal?.status === 'unknown' ? 'unknown' : 'unresolved',
          logicalIdentity: goal ? `goal:${goal.id}` : objective ? `preflight:${item.stableFactKey}` : `free:${item.index}` })
        if (!itemIndex.has(descriptor.findingId)) itemIndex.set(descriptor.findingId, item.index)
      }
    }
    const projection: ReviewCycleProjection = { cycleId: cycle.cycle_id, reviewId: cycle.review_id,
      revisionStatus: cycle.revision_status, ...(cycle.merged_hash ? { mergedHash: cycle.merged_hash } : {}),
      recheckCount: cycle.recheck_count, findings: persisted.map(row => ({ findingId: row.finding_id,
        reviewItemIndex: itemIndex.get(row.finding_id) ?? null, category: row.category, kind: row.kind, status: row.status,
        ...(row.target_id ? { targetId: row.target_id } : {}) })) }
    if (cycle.revision_status === 'merge-committed') {
      if (cycle.merged_hash && isCurrentMergedCycle(cycle.cycle_id, cycle.merged_hash, db)) {
        projection.recheckDisposition = this.planRecheck(cycle.cycle_id, db).disposition
      }
    }
    return projection
  }

  static create(input: CreateReviewCycleInput, db: Database.Database): CreatedReviewCycle {
    if (!db.inTransaction) throw new Error('REVIEW_CYCLE_TRANSACTION_REQUIRED')
    if (!nonempty(input.rootActionId) || !integer(input.reviewId, 1) || !HASH.test(input.reviewContentHash)
      || !nonempty(input.source.projectId) || !nonempty(input.source.epoch) || !nonempty(input.source.sourceId)
      || !integer(input.source.revision, 1) || !HASH.test(input.source.contentHash)) invalid()

    return db.transaction((): CreatedReviewCycle => {
      const root = db.prepare('SELECT action_json FROM generation_roots WHERE root_action_id=?').get(input.rootActionId) as {
        action_json: string
      } | undefined
      let action: Record<string, unknown> | null = null
      try { action = record(root && JSON.parse(root.action_json)) } catch { invalid() }
      if (!action || action.rootActionId !== input.rootActionId || action.projectId !== input.source.projectId
        || action.epoch !== input.source.epoch || action.operation !== 'review-chapter') invalid()

      const review = db.prepare(`SELECT r.base_draft_id,r.source_draft_version,r.source_content,c.body
        FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?`).get(input.reviewId) as ReviewRow | undefined
      if (!review || review.source_content === null || !integer(review.source_draft_version, 1)
        || input.source.sourceId !== `draft:${review.base_draft_id}`
        || input.source.revision !== review.source_draft_version
        || hash(review.source_content) !== input.source.contentHash || hash(review.body) !== input.reviewContentHash) invalid()

      const report = parseSavedReport(review.body)
      const findings = buildFindings(report, input.source, review.source_content)
      const findingSetHash = canonicalM03FindingSetHash(findings)
      const id = cycleId(input)
      const existing = db.prepare(`SELECT cycle_id,root_action_id,review_content_hash,source_hash,finding_set_hash,comparison_version
        FROM review_cycles WHERE review_id=?`).get(input.reviewId) as Record<string, unknown> | undefined
      if (existing) {
        const stored = db.prepare('SELECT * FROM review_findings WHERE cycle_id=? ORDER BY finding_id').all(existing.cycle_id) as Record<string, unknown>[]
        if (existing.cycle_id !== id || existing.root_action_id !== input.rootActionId
          || existing.review_content_hash !== input.reviewContentHash || existing.source_hash !== input.source.contentHash
          || existing.finding_set_hash !== findingSetHash || existing.comparison_version !== 1
          || canonicalM03FindingSetHash(stored.map(persistedFinding)) !== findingSetHash) conflict()
        if (!verifyM03ReviewCycle(db)) conflict()
        return { cycleId: id, findingSetHash, findingCount: findings.length }
      }

      db.prepare(`INSERT INTO review_cycles(cycle_id,root_action_id,review_id,review_content_hash,source_hash,
        finding_set_hash,comparison_version,revision_status,recheck_count) VALUES(?,?,?,?,?,?,1,'not-generated',0)`)
        .run(id, input.rootActionId, input.reviewId, input.reviewContentHash, input.source.contentHash, findingSetHash)
      const insert = db.prepare(`INSERT INTO review_findings(cycle_id,finding_id,source_project_id,source_epoch,source_id,
        source_revision,source_content_hash,span_start,span_end,span_unit,excerpt_hash,occurrence,category,target_id,kind,
        problem_text,expected_text,status,evidence_hash,confirmation_item_index) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      for (const item of findings) insert.run(id, item.findingId, item.source.projectId, item.source.epoch, item.source.sourceId,
        item.source.revision, item.source.contentHash, item.source.span?.start ?? null, item.source.span?.end ?? null,
        item.source.span?.unit ?? null, item.excerptHash, item.occurrence, item.category, item.targetId, item.kind,
        item.problemText, item.expectedText, item.status,
        item.evidenceHash, item.confirmationItemIndex)
      if (!verifyM03ReviewCycle(db)) invalid()
      return { cycleId: id, findingSetHash, findingCount: findings.length }
    })()
  }

  /**
   * issue #248：复验（merge-committed）后作者基于复核意见**再修一轮**的 cycle 通道。
   * 旧 cycle 已 merge-committed（attach 拒第二轮），复核审稿行 body 是 wrapped
   * 形态（parseSavedReport 拒）——无法给复核审稿行建新 cycle。
   * 本方法从**已 merge-committed 的旧 cycle 克隆**出第二轮 cycle：
   *  - cycle_id 由 (root=复核 run 的 root, review_id=新确认行 id, hash) 生成，
   *    与旧 cycle 独立；
   *  - findings 从旧 cycle **逐行复制**（findingId/excerpt/span 全保留，
    *    finding_set_hash 一致性随之成立）；状态映射按作者最新决策：
    *    resolved 保持（已处理）、waive 决策置 author-waived、其余 unverified
    *    （等待下一轮修稿/复验裁决）；
   *  - 旧 cycle 行不动（历史不变量）。
   * 谱系校验：确认行必须归属本 draft、快照 sourceReviewId 指向旧 cycle 的
   * 原始审稿或其复核审稿（二者都是这条审稿谱系的报告）。
   */
  /**
   * issue #248：复验（merge-committed）后作者基于复核意见**再修一轮**的 cycle 通道。
   * 旧 cycle 已 merge-committed（attach 拒第二轮），复核审稿行 body 是 wrapped
   * 形态（parseSavedReport 拒）——无法给复核审稿行走标准 create。
   * 本方法从**已 merge-committed 的旧 cycle 克隆**出第二轮 cycle：
   *  - review_id = **复核审稿行**（快照 sourceReviewId，run 产物——满足
   *    verifyM03 的 reviewAttempts effect 证明）；
   *  - root = 复核 run 的 root（action.operation=review-chapter ✓）；
   *  - findings 从旧 cycle **逐行复制**（findingId/span 全保留，
   *    finding_set_hash 一致性随之成立）；状态按作者最新决策映射：
   *    resolved 保留、waive 决策置 author-waived、其余 unverified；
   *  - 确认行只写 confirmation_review_id/confirmation_content_hash；
   *  - 旧 cycle 行不动（历史不变量），两条链并存。
   * 谱系校验：确认行归属本 draft、快照 schemaVersion 2、cycleId 指向本
   * 新 cycle（渲染层占位）、sourceReviewId 指向复核审稿行。
   */
  static createForConfirmation(input: { sourceCycleId: string; confirmationReviewId: number;
    rootActionId: string }, db: Database.Database): { cycleId: string; findingCount: number } {
    if (!db.inTransaction) throw new Error('REVIEW_CYCLE_TRANSACTION_REQUIRED')
    if (!nonempty(input.sourceCycleId) || !integer(input.confirmationReviewId, 1)
      || !nonempty(input.rootActionId)) invalid()
    return db.transaction((): { cycleId: string; findingCount: number } => {
      const source = db.prepare(`SELECT cycle_id,root_action_id,review_id,source_hash,finding_set_hash,
        comparison_version,merged_hash,revision_status FROM review_cycles WHERE cycle_id=?`).get(input.sourceCycleId) as
        (CycleBindingRow & { finding_set_hash: string; comparison_version: number; merged_hash: string | null }) | undefined
      if (!source || source.revision_status !== 'merge-committed') conflict()
      const confirmation = db.prepare(`SELECT r.base_draft_id,c.body FROM reviews r JOIN contents c ON c.id=r.content_id
        WHERE r.id=?`).get(input.confirmationReviewId) as { base_draft_id: number; body: string } | undefined
      let snapshot = confirmation && parseHumanConfirmedReviewSnapshot(confirmation.body)
      // 占位 cycleId：渲染层先落库 v2 快照（cycleId='pending:<确认行id>'，打破
      // 「cycleId←content←cycleId」自引用），这里生成真实 cycleId 后回写确认行。
      const placeholder = `pending:${input.confirmationReviewId}`
      if (!confirmation || !snapshot?.sourceDraft || snapshot.schemaVersion !== 2) invalid()
      if (snapshot.cycleId === placeholder) {
        // review_id = 快照 sourceReviewId（复核审稿行）：cycle_id 与 review 行
        // 内容（复核审稿行 body 的 hash）解耦——占位内容不参与 id。
        const realId = `cycle:${hash(JSON.stringify([input.rootActionId, snapshot.sourceReviewId, input.confirmationReviewId]))}`
        // JSON 感知回写：确认行 body 是 null,2 缩进序列化，字段替换用解析改写
        // （字符串正则对缩进敏感，已踩过）。
        const patchedBody = JSON.stringify({ ...JSON.parse(confirmation.body), cycleId: realId }, null, 2)
        if (patchedBody === confirmation.body) invalid()
        db.prepare('UPDATE contents SET body=? WHERE id=(SELECT content_id FROM reviews WHERE id=?)')
          .run(patchedBody, input.confirmationReviewId)
        confirmation.body = patchedBody
        snapshot = parseHumanConfirmedReviewSnapshot(patchedBody)
      }
      // 回写后 cycleId=真实新 id；禁止指回旧 cycle 或旧 cycle 的原始审稿绑定。
      if (!snapshot || snapshot.cycleId === input.sourceCycleId) invalid()
      // 确认行归属本 draft；快照指向本谱系内的审稿行（复核审稿行）。
      const lineageReviewIds = db.prepare(`SELECT id FROM reviews WHERE base_draft_id=?`).all(confirmation.base_draft_id) as
        Array<{ id: number }>
      if (!lineageSet(new Set(lineageReviewIds.map(row => row.id)), snapshot.sourceReviewId)) invalid()
      const root = db.prepare('SELECT action_json FROM generation_roots WHERE root_action_id=?').get(input.rootActionId) as
        { action_json: string } | undefined
      const action = root && record(JSON.parse(root.action_json))
      if (!action || action.rootActionId !== input.rootActionId || action.operation !== 'review-chapter') invalid()
      // review 行 = 快照 sourceReviewId（复核审稿行）：必须是 run 产物（有收据）
      // ——verifyM03 的 reviewAttempts effect 证明依赖它。状态列取该行的
      // source_draft_*（=复核时的 revised 稿绑定）。
      const review = db.prepare(`SELECT r.base_draft_id,r.source_draft_version,r.source_draft_status,
        r.source_content,c.body FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?`)
        .get(snapshot.sourceReviewId) as ReviewRow | undefined
      if (!review || review.source_content === null || !integer(review.source_draft_version, 1)
        || review.base_draft_id !== confirmation.base_draft_id) invalid()
      const id = `cycle:${hash(JSON.stringify([input.rootActionId, snapshot.sourceReviewId, input.confirmationReviewId]))}`
      const existing = db.prepare('SELECT cycle_id FROM review_cycles WHERE cycle_id=?').get(id)
      if (existing) conflict()
      const rows = db.prepare(`SELECT finding_id,source_project_id,source_epoch,source_id,source_revision,
        source_content_hash,span_start,span_end,span_unit,excerpt_hash,occurrence,category,target_id,kind,
        problem_text,expected_text,status,evidence_hash,confirmation_item_index FROM review_findings
        WHERE cycle_id=? ORDER BY finding_id`).all(input.sourceCycleId) as Array<Record<string, unknown>>
      const waivedIds = new Set(snapshot.items.filter(item => item.origin === 'ai' && item.findingId !== undefined
        && item.decision === 'waive').map(item => item.findingId as string))
      db.prepare(`INSERT INTO review_cycles(cycle_id,root_action_id,review_id,review_content_hash,confirmation_review_id,confirmation_content_hash,source_hash,
        finding_set_hash,comparison_version,revision_status,recheck_count) VALUES(?,?,?,?,?,?,?,?,?,'not-generated',0)`)
        .run(id, input.rootActionId, snapshot.sourceReviewId, hash(review.body), input.confirmationReviewId,
          hash(confirmation.body), hash(review.source_content), source.finding_set_hash, source.comparison_version)
      const insert = db.prepare(`INSERT INTO review_findings(cycle_id,finding_id,source_project_id,source_epoch,
        source_id,source_revision,source_content_hash,span_start,span_end,span_unit,excerpt_hash,occurrence,
        category,target_id,kind,problem_text,expected_text,status,evidence_hash,confirmation_item_index)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      for (const row of rows) {
        const status = row.status === 'resolved' ? 'resolved'
          : waivedIds.has(String(row.finding_id)) ? 'author-waived' : 'unverified'
        const evidenceHash = status === 'author-waived' ? hash(confirmation.body) : null
        const itemIndex = status === 'author-waived'
          ? snapshot.items.findIndex(item => item.findingId === row.finding_id) : null
        insert.run(id, row.finding_id, row.source_project_id, row.source_epoch, row.source_id, row.source_revision,
          hash(review.source_content), row.span_start, row.span_end, row.span_unit, row.excerpt_hash, row.occurrence,
          row.category, row.target_id, row.kind, row.problem_text, row.expected_text, status, evidenceHash, itemIndex)
      }
      return { cycleId: id, findingCount: rows.length }
    })()
  }
  /** issue #248：读 cycle 的归属 root（渲染层创建第二轮 cycle 前需要）。 */
  static sourceRoot(cycleId: string, db: Database.Database): { rootActionId: string } {
    if (!nonempty(cycleId)) invalid()
    const row = db.prepare('SELECT root_action_id FROM review_cycles WHERE cycle_id=?').get(cycleId) as
      { root_action_id: string } | undefined
    if (!row || !nonempty(row.root_action_id)) invalid()
    return { rootActionId: row.root_action_id }
  }
  static commitAuthorConfirmation(input: { cycleId: string; confirmationReviewId: number },
    db: Database.Database): AuthorConfirmationBinding {
    if (!db.inTransaction) throw new Error('REVIEW_CYCLE_TRANSACTION_REQUIRED')
    if (!nonempty(input.cycleId) || !integer(input.confirmationReviewId, 1)) invalid()
    return db.transaction((): AuthorConfirmationBinding => {
      const cycle = db.prepare(`SELECT cycle_id,root_action_id,review_id,confirmation_review_id,confirmation_content_hash,
        revision_id,source_hash,revision_status FROM review_cycles WHERE cycle_id=?`).get(input.cycleId) as CycleBindingRow | undefined
      if (!cycle || cycle.revision_status !== 'not-generated' || cycle.revision_id !== null) conflict()
      const confirmation = validateAuthorConfirmation(cycle, input.confirmationReviewId, db)
      if (cycle.confirmation_review_id === input.confirmationReviewId) {
        if (cycle.confirmation_content_hash !== confirmation.contentHash) conflict()
        const waivedFindingCount = bindAuthorWaivers({ cycleId: input.cycleId,
          confirmationContentHash: confirmation.contentHash }, confirmation.snapshot, db, false)
        if (!verifyM03ReviewCycle(db)) conflict()
        return { cycleId: input.cycleId, confirmationReviewId: input.confirmationReviewId,
          confirmationContentHash: confirmation.contentHash, waivedFindingCount, idempotent: true }
      }
      const confirmationOwner = db.prepare('SELECT cycle_id FROM review_cycles WHERE confirmation_review_id=?')
        .pluck().get(input.confirmationReviewId) as string | undefined
      if (confirmationOwner && confirmationOwner !== input.cycleId) conflict()
      if (cycle.confirmation_review_id !== null) {
        const waived = db.prepare(`SELECT * FROM review_findings
          WHERE cycle_id=? AND status='author-waived' LIMIT 1`).get(input.cycleId) as Record<string, unknown> | undefined
        if (waived) {
          const review = db.prepare(`SELECT r.base_draft_id,r.source_draft_version,r.source_content,c.body
            FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=?`).get(cycle.review_id) as ReviewRow | undefined
          if (!review || review.source_content === null) conflict()
          const restore = db.prepare(`UPDATE review_findings SET status=?,evidence_hash=NULL,confirmation_item_index=NULL
            WHERE cycle_id=? AND finding_id=? AND status='author-waived'`)
          for (const item of buildFindings(parseSavedReport(review.body), persistedFinding(waived).source, review.source_content)) {
            restore.run(item.status, input.cycleId, item.findingId)
          }
        }
      }
      const waivedFindingCount = bindAuthorWaivers({ cycleId: input.cycleId,
        confirmationContentHash: confirmation.contentHash }, confirmation.snapshot, db, true)
      const result = db.prepare(`UPDATE review_cycles SET confirmation_review_id=?,confirmation_content_hash=?
        WHERE cycle_id=? AND revision_status='not-generated' AND revision_id IS NULL`)
        .run(input.confirmationReviewId, confirmation.contentHash, input.cycleId)
      if (result.changes !== 1 || !verifyM03ReviewCycle(db)) conflict()
      return { cycleId: input.cycleId, confirmationReviewId: input.confirmationReviewId,
        confirmationContentHash: confirmation.contentHash, waivedFindingCount, idempotent: false }
    })()
  }

  static attachGeneratedRevision(input: AttachGeneratedRevisionInput, db: Database.Database): GeneratedRevisionBinding {
    if (!db.inTransaction) throw new Error('REVIEW_CYCLE_TRANSACTION_REQUIRED')
    if (!nonempty(input.cycleId) || !nonempty(input.rootActionId) || !integer(input.confirmationReviewId, 1)
      || !HASH.test(input.confirmationContentHash) || !integer(input.revisionId, 1)
      || !HASH.test(input.revisionContentHash)) invalid()
    return db.transaction((): GeneratedRevisionBinding => {
      const cycle = db.prepare(`SELECT cycle_id,root_action_id,review_id,confirmation_review_id,confirmation_content_hash,
        revision_id,source_hash,revision_status FROM review_cycles WHERE cycle_id=?`).get(input.cycleId) as CycleBindingRow | undefined
      if (!cycle || cycle.root_action_id !== input.rootActionId) invalid()
      if (cycle.revision_status === 'merge-committed') conflict()
      if (cycle.revision_status === 'generated') {
        if (cycle.confirmation_review_id !== input.confirmationReviewId
          || cycle.confirmation_content_hash !== input.confirmationContentHash || cycle.revision_id !== input.revisionId) conflict()
        const { snapshot } = validateGeneratedBinding(input, cycle, db)
        bindAuthorWaivers({ cycleId: input.cycleId, confirmationContentHash: input.confirmationContentHash }, snapshot, db, false)
        if (!verifyM03ReviewCycle(db)) conflict()
        return { cycleId: input.cycleId, confirmationReviewId: input.confirmationReviewId,
          revisionId: input.revisionId, revisionStatus: 'generated', idempotent: true }
      }
      if (cycle.revision_id !== null || cycle.confirmation_review_id !== null
        && (cycle.confirmation_review_id !== input.confirmationReviewId
          || cycle.confirmation_content_hash !== input.confirmationContentHash)) conflict()
      const revisionOwner = db.prepare('SELECT cycle_id FROM review_cycles WHERE revision_id=?').pluck().get(input.revisionId) as string | undefined
      const confirmationOwner = db.prepare('SELECT cycle_id FROM review_cycles WHERE confirmation_review_id=?')
        .pluck().get(input.confirmationReviewId) as string | undefined
      if (revisionOwner && revisionOwner !== input.cycleId || confirmationOwner && confirmationOwner !== input.cycleId) conflict()
      const { baseDraftId, snapshot } = validateGeneratedBinding(input, cycle, db)
      bindAuthorWaivers({ cycleId: input.cycleId, confirmationContentHash: input.confirmationContentHash }, snapshot, db,
        cycle.confirmation_review_id === null)
      detachDiscardedGeneratedCycles(db, baseDraftId, input.cycleId)
      const result = db.prepare(`UPDATE review_cycles SET confirmation_review_id=?,confirmation_content_hash=?,revision_id=?,
        revision_status='generated' WHERE cycle_id=? AND revision_status='not-generated' AND revision_id IS NULL`)
        .run(input.confirmationReviewId, input.confirmationContentHash, input.revisionId, input.cycleId)
      if (result.changes !== 1 || !verifyM03ReviewCycle(db)) invalid()
      return { cycleId: input.cycleId, confirmationReviewId: input.confirmationReviewId,
        revisionId: input.revisionId, revisionStatus: 'generated', idempotent: false }
    })()
  }

  static commitMergedRevision(input: { revisionId: number; mergedHash: string },
    db: Database.Database): MergeCommittedCycle {
    if (!db.inTransaction) throw new Error('REVIEW_CYCLE_TRANSACTION_REQUIRED')
    if (!input || !integer(input.revisionId, 1) || !HASH.test(input.mergedHash)) invalid()
    return db.transaction((): MergeCommittedCycle => {
      const cycle = db.prepare(`SELECT cycle_id,revision_status,merged_hash FROM review_cycles WHERE revision_id=?`)
        .get(input.revisionId) as { cycle_id: string; revision_status: string; merged_hash: string | null } | undefined
      if (!cycle) return { revisionId: input.revisionId, bound: false, idempotent: true }
      if (!['generated', 'merge-committed'].includes(cycle.revision_status)) conflict()
      const merged = db.prepare(`SELECT r.status,r.base_draft_id,r.merged_to_draft_id,c.body
        FROM revisions r JOIN drafts d ON d.id=r.base_draft_id JOIN contents c ON c.id=d.content_id WHERE r.id=?`)
        .get(input.revisionId) as { status: string; base_draft_id: number; merged_to_draft_id: number | null;
          body: string } | undefined
      if (!merged || merged.status !== 'merged' || merged.merged_to_draft_id !== merged.base_draft_id
        || hash(merged.body) !== input.mergedHash) conflict()
      if (cycle.revision_status === 'merge-committed') {
        if (cycle.merged_hash !== input.mergedHash || !verifyM03ReviewCycle(db)) conflict()
        return { revisionId: input.revisionId, bound: true, cycleId: cycle.cycle_id,
          revisionStatus: 'merge-committed', idempotent: true }
      }
      const result = db.prepare(`UPDATE review_cycles SET revision_status='merge-committed',merged_hash=?
        WHERE cycle_id=? AND revision_id=? AND revision_status='generated' AND merged_hash IS NULL`)
        .run(input.mergedHash, cycle.cycle_id, input.revisionId)
      if (result.changes === 1 && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_cycle_merges'").get()) {
        db.prepare('INSERT INTO review_cycle_merges(cycle_id,body) VALUES(?,?)').run(cycle.cycle_id, merged.body)
      }
      if (result.changes !== 1 || !verifyM03ReviewCycle(db)) conflict()
      return { revisionId: input.revisionId, bound: true, cycleId: cycle.cycle_id,
        revisionStatus: 'merge-committed', idempotent: false }
    })()
  }

  static planRecheck(cycleId: string, db: Database.Database): ReviewCycleRecheckPlan {
    if (!nonempty(cycleId)) invalid()
    const cycle = readRecheckCycle(cycleId, db)
    if (cycle.recheck_count === 1) return { disposition: 'completed', context: null,
      rootActionId: cycle.root_action_id, reviewId: cycle.review_id }
    if (cycle.recheck_count !== 0 || cycle.recheck_attempt_id !== null) conflict()
    const context = recheckContext(cycle, db)
    return { disposition: context.findings.length ? 'required' : 'not-required',
      context: context.findings.length ? context : null, rootActionId: cycle.root_action_id, reviewId: cycle.review_id }
  }

  static commitRecheck(cycleId: string, attemptId: string, db: Database.Database): CommittedReviewCycleRecheck {
    if (!db.inTransaction) throw new Error('REVIEW_CYCLE_TRANSACTION_REQUIRED')
    if (!nonempty(cycleId) || !nonempty(attemptId)) invalid()
    return db.transaction((): CommittedReviewCycleRecheck => {
      const current = readRecheckCycle(cycleId, db)
      if (current.recheck_count === 1) {
        if (current.recheck_attempt_id !== attemptId) conflict()
        return { cycleId, attemptId, recheckCount: 1, idempotent: true }
      }
      const plan = this.planRecheck(cycleId, db)
      if (plan.disposition !== 'required' || !plan.context) conflict()
      const attempt = db.prepare('SELECT root_action_id,usage_receipt_json FROM generation_attempts WHERE attempt_id=?')
        .get(attemptId) as { root_action_id: string; usage_receipt_json: string } | undefined
      let usage: Record<string, unknown> | null = null
      try { usage = record(attempt && JSON.parse(attempt.usage_receipt_json)) } catch { invalid() }
      const receipt = record(usage?.reviewCycleRecheck)
      // issue #246：复核 run 自 1.5.251 起开新 root（审稿 root 的预算/blocked_code
      // 会挡复验重试）——recheck attempt 不再要求落在 plan.rootActionId 下；
      // 谱系由收据内容（reviewCycleRecheck.cycleId/mergedHash/findingSetHash 全等）证明。
      if (!attempt || !receipt
        || (receipt.version !== 1 && receipt.version !== 2)
        || receipt.cycleId !== cycleId || receipt.comparisonVersion !== plan.context.comparisonVersion
        || receipt.mergedHash !== plan.context.mergedHash || receipt.findingSetHash !== plan.context.findingSetHash
        || !Array.isArray(receipt.findings)) conflict()
      const mappings = receipt.findings.map(value => record(value))
      // ⚠️ 这里曾有一条 `mappings.some(m => m?.resolved === true) => conflict()`：v2 政策
      // 不相信模型的正向判断，写入时一律拒收。issue #245 取消了那条降级——它的终点
      // 是一个**不存在**的作者核实入口（`resolved` 只能由复验写，作者手上只有「弃修」），
      // 于是「模型说改好了」这条永远落不了库，定稿提示永远不会消失。
      // 现在正向判断照常写入；可信度由 `evidenceHash` 的锚定与下面的逐条校验把关。
      const expectedTargets = new Map(plan.context.findings.map(finding => [finding.findingId, finding.targetId]))
      if (mappings.some(mapping => !mapping || expectedTargets.get(String(mapping.findingId)) !== mapping.targetId)) conflict()
      const itemIndexes = new Map<number, number>()
      for (const mapping of mappings) {
        if (mapping && integer(mapping.reviewItemIndex)) itemIndexes.set(mapping.reviewItemIndex,
          (itemIndexes.get(mapping.reviewItemIndex) ?? 0) + 1)
      }
      const update = db.prepare(`UPDATE review_findings SET status=?,evidence_hash=?,confirmation_item_index=NULL
        WHERE cycle_id=? AND finding_id=? AND status NOT IN ('resolved','author-waived')`)
      for (const finding of plan.context.findings) {
        if (finding.mustShow) continue // The old finding has no quote and remains unverified in M03.
        const candidates = mappings.filter(mapping => mapping?.findingId === finding.findingId)
        const mapping = candidates.length === 1 ? candidates[0] : null
        const valid = mapping && mapping.targetId === finding.targetId && integer(mapping.reviewItemIndex)
          && itemIndexes.get(mapping.reviewItemIndex as number) === 1
          && HASH.test(String(mapping.evidenceHash)) && typeof mapping.resolved === 'boolean'
        const status = valid ? mapping!.resolved ? 'resolved' : 'unresolved' : 'unknown'
        const result = update.run(status, valid ? mapping!.evidenceHash : null, cycleId, finding.findingId)
        if (result.changes !== 1) conflict()
      }
      const result = db.prepare(`UPDATE review_cycles SET recheck_count=1,recheck_attempt_id=?
        WHERE cycle_id=? AND revision_status='merge-committed' AND recheck_count=0 AND recheck_attempt_id IS NULL`)
        .run(attemptId, cycleId)
      if (result.changes !== 1 || !verifyM03ReviewCycle(db)) conflict()
      return { cycleId, attemptId, recheckCount: 1, idempotent: false }
    })()
  }

  /**
   * issue #247：复验（recheck）完成后仍有已确认未解决的意见时，作者在 revised
   * 状态需要「标记不修改」的出口——但 commitAuthorConfirmation 只接受
   * not-generated 的 cycle（已合并的 cycle 会 conflict），复验后没有任何
   * waiver 更新通道，定稿被拦而两个入口都不可达。
   *
   * 这里给 merge-committed 的 cycle 一个**只刷 waiver 状态**的通道：
   * 按作者最新的确认快照逐条更新 finding 状态——decision=waive 的 AI 项置
   * author-waived（与 bindAuthorWaivers(apply=true) 同款，resolved 仍拒改）；
   * 非 waiver 项恢复原判定状态（unresolved/unverified），让作者可以改主意。
   * cycle 行本身不动（confirmation 绑定是修稿前的历史事实）。
   * 谱系校验：快照必须指向 cycle.review_id 且 sourceDraft 与合并正文一致。
   */
  static updateWaiversAfterRecheck(input: { cycleId: string; confirmationReviewId: number },
    db: Database.Database): { cycleId: string; waivedFindingCount: number; restoredFindingCount: number } {
    if (!db.inTransaction) throw new Error('REVIEW_CYCLE_TRANSACTION_REQUIRED')
    if (!nonempty(input.cycleId) || !integer(input.confirmationReviewId, 1)) invalid()
    return db.transaction((): { cycleId: string; waivedFindingCount: number; restoredFindingCount: number } => {
      const cycle = db.prepare(`SELECT cycle_id,root_action_id,review_id,source_hash,revision_status,merged_hash,
        recheck_count FROM review_cycles WHERE cycle_id=?`).get(input.cycleId) as (CycleBindingRow & { merged_hash: string | null; recheck_count: number }) | undefined
      if (!cycle || cycle.revision_status !== 'merge-committed' || cycle.recheck_count !== 1
        || !cycle.merged_hash || !HASH.test(cycle.merged_hash)) conflict()
      const confirmation = db.prepare(`SELECT r.source_content,c.body FROM reviews r JOIN contents c ON c.id=r.content_id
        WHERE r.id=? AND r.base_draft_id=(SELECT base_draft_id FROM reviews WHERE id=?)`)
        .get(input.confirmationReviewId, cycle.review_id) as { source_content: string | null; body: string } | undefined
      const snapshot = confirmation && parseHumanConfirmedReviewSnapshot(confirmation.body)
      const confirmationContentHash = hash(String(confirmation?.body ?? ''))
      // 谱系口径（issue #247）：复验后的确认快照归属本 cycle（cycleId 一致）、
      // 指向本 cycle 的原始审稿（sourceReviewId）、且基于同一草稿——
      // 不比对快照里的 sourceDraft.content：复验后作者在**合并后正文**上确认，
      // 与原始审稿的源稿快照本来就不同；merged_hash 的权威值在 cycle 行上。
      if (!confirmation || !snapshot?.sourceDraft
        || snapshot.sourceReviewId !== cycle.review_id || snapshot.cycleId !== cycle.cycle_id
        || snapshot.sourceDraft.id !== (db.prepare('SELECT base_draft_id FROM reviews WHERE id=?')
          .pluck().get(cycle.review_id) as number)) invalid()
      const findings = db.prepare(`SELECT finding_id,status FROM review_findings WHERE cycle_id=?`)
        .all(input.cycleId) as Array<{ finding_id: string; status: string }>
      const byId = new Map(findings.map(finding => [finding.finding_id, finding]))
      let waived = 0
      let restored = 0
      for (const item of snapshot.items) {
        if (item.origin !== 'ai' || item.findingId === undefined) continue
        const current = byId.get(item.findingId)
        if (!current) invalid()
        if (item.decision === 'waive') {
          if (current.status === 'author-waived') continue
          if (current.status === 'resolved') conflict()
          // CHECK：author-waived 要求 evidence_hash + confirmation_item_index 非空
          // （与 bindAuthorWaivers 同款指向确认快照）。
          const result = db.prepare(`UPDATE review_findings SET status='author-waived',evidence_hash=?,confirmation_item_index=?
            WHERE cycle_id=? AND finding_id=? AND status<>'resolved'`)
            .run(confirmationContentHash, snapshot.items.indexOf(item), input.cycleId, item.findingId)
          if (result.changes !== 1) conflict()
          waived += 1
        } else if (current.status === 'author-waived') {
          // 作者改主意：从弃修恢复为按证据重验的未决态。
          const result = db.prepare(`UPDATE review_findings SET status='unresolved',evidence_hash=NULL,confirmation_item_index=NULL
            WHERE cycle_id=? AND finding_id=? AND status='author-waived'`)
            .run(input.cycleId, item.findingId)
          if (result.changes !== 1) conflict()
          restored += 1
        }
      }
      // issue #247 收口：**不重绑 cycle.confirmation_***——revision.review_source_id
      // 锚定第一轮确认（verifyM03 :375 不变量），重绑会破坏它。弃修对账改为
      // **waiver 行自证**：evidence_hash = 新确认行的 body hash、
      // confirmation_item_index = 新快照中该项下标；verifyM03 的 author-waived
      // 对账按该 hash 反查确认行解析快照（cycle 绑定路径仍兼容第一轮确认）。
      // 一致性守卫：本轮刷新的每个 finding 都必须能按行内 hash 找回确认行。
      const attestor = db.prepare(`SELECT r.id FROM reviews r JOIN contents c ON c.id=r.content_id WHERE r.id=? AND r.base_draft_id=?`).get(input.confirmationReviewId,
        (db.prepare('SELECT base_draft_id FROM reviews WHERE id=?').pluck().get(cycle.review_id) as number))
      if (!attestor) conflict()
      if (!verifyM03ReviewCycle(db)) conflict()
      return { cycleId: input.cycleId, waivedFindingCount: waived, restoredFindingCount: restored }
    })()
  }

  static reconcileDiscardedRevision(revisionId: number, db: Database.Database): DiscardedRevisionReconciliation {
    if (!db.inTransaction) throw new Error('REVIEW_CYCLE_TRANSACTION_REQUIRED')
    if (!integer(revisionId, 1)) invalid()
    const result = this.reconcileDiscardedRevisions([revisionId], db)
    return { revisionId, detached: result.detached === 1 }
  }

  static reconcileDiscardedRevisions(revisionIds: readonly number[], db: Database.Database): DiscardedRevisionsReconciliation {
    if (!db.inTransaction) throw new Error('REVIEW_CYCLE_TRANSACTION_REQUIRED')
    if (!Array.isArray(revisionIds) || revisionIds.some(revisionId => !integer(revisionId, 1))) invalid()
    const uniqueIds = [...new Set(revisionIds)].sort((left, right) => left - right)
    return db.transaction(() => {
      const detached = reconcileDiscardedRevisionIds(db, uniqueIds)
      if (!verifyM03ReviewCycle(db)) conflict()
      return { revisionIds: uniqueIds, detached }
    })()
  }
}
