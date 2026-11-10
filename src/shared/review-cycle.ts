import { isContentHash, type SourceRef } from './source-ref'
import { parseChapterGoalReview } from './chapter-goal-review'
import type { HumanConfirmedReviewSnapshot } from './human-confirmed-review'
import { extractSingleCompleteJsonObject } from './character-proposal-parser'
import type { ReviewReportVersion } from './review-generation-report'

export type ReviewFindingStatus = 'unverified' | 'unresolved' | 'unknown' | 'resolved' | 'author-waived'
export interface ReviewFinding {
  findingId: string; source: SourceRef; excerptHash: string; occurrence: number
  category: string; targetId: string; kind: 'objective' | 'literary'; status: ReviewFindingStatus
}
export interface ReviewCycle {
  cycleId: string; rootActionId: string; sourceHash: string; findingSetHash: string
  revisionStatus: 'not-generated' | 'generated' | 'merge-committed'
  mergedHash?: string; recheckCount: 0 | 1
}
export interface ReviewCycleFindingProjection {
  findingId: string
  reviewItemIndex: number | null
  category: string
  kind: 'objective' | 'literary'
  status: ReviewFindingStatus
  targetId?: string
}
export interface ReviewCycleProjection {
  cycleId: string
  reviewId: number
  revisionStatus: 'not-generated' | 'generated' | 'merge-committed'
  mergedHash?: string
  recheckCount: 0 | 1
  recheckDisposition?: 'required' | 'not-required' | 'completed'
  findings: ReviewCycleFindingProjection[]
}

export interface ReviewCycleRecheckFinding {
  findingId: string
  targetId: string
  category: string
  kind: 'objective' | 'literary'
  /** Immutable human-readable problem statement from the original saved review. */
  problem: string
  /** Optional original goal semantics that the merged draft must actually satisfy. */
  expected?: string
  sourceSpan?: { start: number; end: number; unit: 'utf16-code-unit' }
  occurrence?: number
  sourceExcerpt?: string
  /** Author-applied explicit goal with no old-draft quote; the original row remains unverified. */
  mustShow?: true
}

export interface ReviewCycleRecheckContext {
  /**
   * 回执/报告的落库版本。⚠️ **不再**用来区分「信不信模型的 resolved 判断」：
   * v2 曾把 resolved 降级成 `unknown`（等一个并不存在的作者核实入口），已在
   * issue #245 取消。现在两版语义一致：证据唯一锚定 + 模型判 resolved = 已解决。
   * 版本号仍保留，因为 M03 校验回执形状时要按它核对字段集。
   */
  version: 1 | 2
  cycleId: string
  comparisonVersion: number
  mergedHash: string
  findingSetHash: string
  /** Present only for unshown mustShow goals, to reject evidence already in the original draft. */
  sourceContent?: string
  findings: readonly ReviewCycleRecheckFinding[]
}

export interface ReviewCycleRecheckModelItem {
  findingId: string
  targetId: string
  resolved: boolean
  evidenceQuote: string
  reason: string
}

export interface ReviewCycleRecheckDecision {
  findingId: string
  targetId: string
  status: 'resolved' | 'unresolved' | 'unknown'
  reviewItemIndex: number
  resolved?: boolean
}

export interface ReviewCycleRecheckReport {
  summary: string
  items: Array<Record<string, unknown>>
  decisions: ReviewCycleRecheckDecision[]
  validModelOutput: boolean
}
export function isNoopRevision(before: string, after: string): boolean {
  const visible = (value: string): string => value.replace(/[\p{White_Space}\p{Cf}]/gu, '')
  return visible(before) === visible(after)
}

/** A narrow projection from the original saved goal and author confirmation, never a fabricated old quote. */
export function unshownMustShowRecheckFindings(rawReport: unknown, snapshot: HumanConfirmedReviewSnapshot | null,
  rows: readonly { findingId: string; kind: string; status: string; targetId: string | null;
    problemText: string; expectedText: string | null }[]): ReviewCycleRecheckFinding[] {
  if (!rawReport || typeof rawReport !== 'object' || Array.isArray(rawReport) || !snapshot) return []
  const report = rawReport as { goalReview?: unknown; items?: unknown }
  const goals = parseChapterGoalReview(report.goalReview)
  if (!goals || !Array.isArray(report.items)) return []
  const reportItems = report.items as unknown[]
  return goals.items.flatMap(goal => {
    if (!/^ch\d+:mustShow:\d+$/u.test(goal.id) || goal.status !== 'unknown' || goal.evidence.length) return []
    const projections = reportItems.filter((item): item is { goalId: string; category: string; description: string } =>
      Boolean(item && typeof item === 'object' && !Array.isArray(item) && (item as { goalId?: unknown }).goalId === goal.id))
    const choices = snapshot.items.filter(item => item.goalId === goal.id && item.origin === 'ai'
      && item.decision === 'apply' && item.findingId)
    if (projections.length !== 1 || choices.length !== 1) return []
    const projection = projections[0]!
    const choice = choices[0]!
    const matches = rows.filter(row => row.findingId === choice.findingId && row.kind === 'objective'
      && row.status === 'unverified' && row.targetId === null
      && row.expectedText === `${goal.text}\n${goal.description}` && row.problemText === projection.description)
    return matches.length === 1 && matches[0]!.findingId === choice.findingId ? [{ findingId: choice.findingId!, targetId: goal.id,
      category: projection.category, kind: 'objective' as const, problem: projection.description,
      expected: `${goal.text}\n${goal.description}`, mustShow: true as const }] : []
  })
}

function countOccurrences(text: string, excerpt: string): number {
  if (!excerpt) return 0
  let count = 0
  for (let offset = 0; offset <= text.length;) {
    const found = text.indexOf(excerpt, offset)
    if (found < 0) break
    count += 1
    offset = found + Math.max(1, excerpt.length)
  }
  return count
}

const objectiveText = (value: string): string => value.replace(/[^\p{L}\p{N}]/gu, '')

/** Deterministic admission only: unchanged or ambiguous evidence never spends a model request. */
export function classifyFindingEvidenceChange(source: string, merged: string,
  finding: ReviewCycleRecheckFinding): 'changed' | 'unchanged' | 'ambiguous' {
  if (finding.mustShow) return objectiveText(source) === objectiveText(merged) ? 'unchanged' : 'changed'
  const span = finding.sourceSpan
  const occurrence = finding.occurrence
  if (!span || span.unit !== 'utf16-code-unit' || !Number.isSafeInteger(span.start) || span.start < 0
    || !Number.isSafeInteger(span.end) || span.end <= span.start || span.end > source.length
    || !Number.isSafeInteger(occurrence) || occurrence === undefined || occurrence < 1) return 'ambiguous'
  const excerpt = source.slice(span.start, span.end)
  if (!excerpt || countOccurrences(source, excerpt) < occurrence) return 'ambiguous'
  if (isNoopRevision(source, merged)) return 'unchanged'
  if (finding.kind === 'objective') {
    const objectiveExcerpt = objectiveText(excerpt)
    return objectiveExcerpt && objectiveText(merged).includes(objectiveExcerpt) ? 'unchanged' : 'changed'
  }
  return merged.includes(excerpt) ? 'unchanged' : 'changed'
}

function parseRecheckItems(content: string, reportVersion: ReviewReportVersion): { summary: string; items: ReviewCycleRecheckModelItem[] } | null {
  try {
    const trimmed = content.trim()
    const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed)
    const parsed = JSON.parse(reportVersion === 1 ? fenced?.[1]?.trim() ?? trimmed
      : extractSingleCompleteJsonObject(content, true)) as Record<string, unknown>
    if (!parsed || Array.isArray(parsed) || Object.keys(parsed).some(key => !['summary', 'items'].includes(key))
      || typeof parsed.summary !== 'string' || !parsed.summary.trim() || !Array.isArray(parsed.items)) return null
    const items: ReviewCycleRecheckModelItem[] = []
    for (const item of parsed.items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null
      const row = item as Record<string, unknown>
      if (Object.keys(row).some(key => !['findingId', 'targetId', 'resolved', 'evidenceQuote', 'reason'].includes(key))
        || typeof row.findingId !== 'string' || !row.findingId.trim()
        || typeof row.targetId !== 'string' || !row.targetId.trim()
        || typeof row.resolved !== 'boolean' || typeof row.evidenceQuote !== 'string' || !row.evidenceQuote.trim()
        || typeof row.reason !== 'string' || !row.reason.trim()) return null
      items.push({ findingId: row.findingId, targetId: row.targetId, resolved: row.resolved,
        evidenceQuote: row.evidenceQuote, reason: row.reason })
    }
    return { summary: parsed.summary.trim(), items }
  } catch { return null }
}

/** 入参 reportVersion 只决定怎么解析（v1 认围栏、v2 抽完整对象）；语义裁决两版一致（issue #245）。 */
export function buildReviewCycleRecheckReport(content: string, merged: string,
  context: ReviewCycleRecheckContext, uiLocale: 'zh-CN' | 'en-US', reportVersion: ReviewReportVersion = 2): ReviewCycleRecheckReport {
  const parsed = parseRecheckItems(content, reportVersion)
  const counts = new Map<string, number>()
  for (const item of parsed?.items ?? []) counts.set(item.findingId, (counts.get(item.findingId) ?? 0) + 1)
  const items: Array<Record<string, unknown>> = []
  const decisions: ReviewCycleRecheckDecision[] = []
  for (const finding of context.findings) {
    const candidate = counts.get(finding.findingId) === 1
      ? parsed?.items.find(item => item.findingId === finding.findingId) : undefined
    const evidenceCount = candidate ? countOccurrences(merged, candidate.evidenceQuote) : 0
    const valid = candidate?.targetId === finding.targetId && evidenceCount === 1
      && (!finding.mustShow || typeof context.sourceContent === 'string'
        && !objectiveText(context.sourceContent).includes(objectiveText(candidate.evidenceQuote)))
    const reviewItemIndex = items.length
    if (!valid || !candidate) {
      items.push({ category: finding.category, severity: 'unknown', findingId: finding.findingId,
        targetId: finding.targetId, description: uiLocale === 'en-US'
          ? 'The recheck did not provide unique, verifiable evidence.' : '复核未提供唯一且可验证的新证据。' })
      decisions.push({ findingId: finding.findingId, targetId: finding.targetId, status: 'unknown', reviewItemIndex })
      continue
    }
    /**
     * v2 曾经把「模型判了 resolved」一律降级成 `unknown`，等作者核实 —— 但那个
     * 「核实」**从来没有入口**：`resolved` 只能由复验写，全仓没有第二条写它的路径，
     * 作者手上只有「弃修」。
     *
     * 现场（`源起` 第 2 章，issue #245）：作者点审稿 → 只有 1 条 AI 发现（比喻连接词
     * 3 处超配额）→ 勾选按它修稿 → 合并成功 → 定稿却仍报「这条还没确定」。
     * 真库回执里模型写得很清楚：「原句已改为具象动作描写…比喻连接词已降至 2 处，
     * 满足指标」，`resolved=true`，证据唯一可定位——它**判对了**，却被降级吞掉，
     * 于是这条提示永远不会消失。作者越照做越窝火。
     *
     * 现在的口径：证据锚定（引用逐字且全篇只出现一次，已在上面 `valid` 里校验过）
     * + 模型判 resolved = 已解决。挑剔模型的语义判断没有接地面，而锚定这一关
     * 已经挡掉了「瞎编引文」这个主要失效形态：编的句子在合并后正文里找不到，
     * `evidenceCount !== 1`，走的是上面那条 `unknown` 分支。
     *
     * 保留 `unknown` 的两种真实情况不变：**没有**唯一可验证的证据（上一段），
     * 或整个复核输出不合规（`parsed` 为 null）。
     */
    items.push({ category: finding.category, severity: candidate.resolved ? 'pass' : 'warning',
      findingId: finding.findingId, targetId: finding.targetId, description: candidate.reason,
      quote: candidate.evidenceQuote, resolved: candidate.resolved })
    decisions.push({ findingId: finding.findingId, targetId: finding.targetId,
      status: candidate.resolved ? 'resolved' : 'unresolved', reviewItemIndex, resolved: candidate.resolved })
  }
  return { summary: parsed?.summary.trim() || (uiLocale === 'en-US'
    ? 'The recheck output was invalid; affected findings remain unknown.' : '复核输出无效；受影响项目保持待核实。'),
    items, decisions, validModelOutput: Boolean(parsed) }
}
export function findingAnchorKey(finding: ReviewFinding): string {
  const span = finding.source.span
  if (!isContentHash(finding.source.contentHash) || !isContentHash(finding.excerptHash) || !finding.source.span
    || !span || span.unit !== 'utf16-code-unit' || !Number.isSafeInteger(span.start) || span.start < 0
    || !Number.isSafeInteger(span.end) || span.end <= span.start
    || !finding.source.projectId || !finding.source.epoch || !finding.source.sourceId
    || !Number.isSafeInteger(finding.source.revision) || finding.source.revision < 0
    || !Number.isSafeInteger(finding.occurrence) || finding.occurrence < 1 || !finding.category || !finding.targetId) throw new Error('UNVERIFIED_FINDING')
  return JSON.stringify([finding.source.contentHash, finding.source.span, finding.occurrence, finding.excerptHash, finding.category, finding.targetId])
}
export function decideFindingStatus(input: {
  uniqueAnchor: boolean; relevantHunkChanged: boolean; noop: boolean
  authorWaived: boolean; mergedHash: string; findingSetHash: string
  recheck?: { mergedHash: string; findingSetHash: string; newEvidenceHash: string; targetId: string; resolved: boolean }
  targetId: string
}): ReviewFindingStatus {
  if (!isContentHash(input.mergedHash) || !isContentHash(input.findingSetHash) || !input.targetId.trim()) return 'unknown'
  if (input.authorWaived) return 'author-waived'
  if (!input.uniqueAnchor) return 'unverified'
  if (input.noop || !input.relevantHunkChanged) return 'unresolved'
  const check = input.recheck
  if (!check || !isContentHash(check.newEvidenceHash) || check.mergedHash !== input.mergedHash
    || check.findingSetHash !== input.findingSetHash || check.targetId !== input.targetId) return 'unknown'
  return check.resolved ? 'resolved' : 'unresolved'
}
export function assertSingleRecheck(cycle: ReviewCycle): void {
  if (cycle.recheckCount !== 0 || cycle.revisionStatus !== 'merge-committed' || !cycle.mergedHash || !isContentHash(cycle.mergedHash)) throw new Error('RECHECK_NOT_ALLOWED')
}
