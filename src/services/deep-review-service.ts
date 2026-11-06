/**
 * 定稿审稿的「深度检查」编排（issue #229 ①②）。
 *
 * 用户定规：模型判据的正确家是**定稿时的审稿**——上一章写完时默认做、可勾选，
 * 不该挂在写新一章的预检里（「上一章的作业摊在下一章的门口」）。
 *
 * 分工：
 *
 * | 步骤 | 谁做 |
 * |---|---|
 * | 哪些维度要做（勾选持久化）、章节怎么取 | **规则**（本文件 + `deep-review-dimensions.ts`） |
 * | 每个维度的提示词、JSON 校验、引文可定位 | **规则**（`preflight-repair.ts` 的 `reviewXxx`，与预检按钮同一实现——合并不是降级） |
 * | 「这一处是不是真矛盾」 | **模型** |
 * | 采纳 | **作者**（findings 并进审稿报告，走已有的「按 N 项意见修稿」通道） |
 *
 * ⚠️ 每个维度一次模型调用（60–100 秒级）；被勾选几个就跑几次，**串行**——
 * 并发会把本机网关的限流顶爆（实测同一通道 3 并发即 429）。
 */

import type { ProjectSessionContext } from '../shared/ipc-channels'
import type { ConsistencyFinding } from '../shared/consistency-preflight'
import { ipc } from './ipc-client'
import { isProjectSessionCurrent } from '../components/project-session-gate'
import {
  DEEP_REVIEW_DIMENSIONS,
  DEEP_REVIEW_PREFS_REL,
  deepReviewSelectionFromDisabled,
  type DeepReviewDimensionKey,
} from '../shared/deep-review-dimensions'
import {
  checkAppearanceAgainstCards,
  reviewAbilityLimits,
  reviewBlueprintAgainstProse,
  reviewBlueprintInternals,
  reviewDateConflicts,
  reviewDeadlines,
  reviewEvidenceShapes,
  reviewHandwritingTraits,
  reviewLossRestatements,
  reviewMemoryAnchors,
  reviewProseContent,
  reviewProseStyle,
  reviewSensoryChannels,
} from './preflight-repair'
import { CONTENT_AXES_FOR_BUTTON } from '../shared/content-review'
import { useLocaleStore } from '../stores/locale-store'

export interface DeepCheckChapter {
  chapterNumber: number
  content: string
}

export interface DeepCheckCard {
  name: string
  appearance: string
  notes: string
}

export interface DeepCheckClaim {
  chapterNumber: number
  claims: string
}

/** 深度检查的一次执行输入：审稿侧给本章正文与既有材料；全部可空维度自动跳过。 */
export interface DeepCheckInput {
  session: ProjectSessionContext
  /** 被审稿的本章（唯一「未定稿」的输入；其余维度看已定稿正文）。 */
  chapter: DeepCheckChapter
  /** 已定稿正文（大多数维度的取数范围）。 */
  finalizedChapters: readonly DeepCheckChapter[]
  /** 角色卡（appearance 维度用；空则该维度跳过）。 */
  cards: readonly DeepCheckCard[]
  /** 蓝图断言（blueprintFacts 维度用；空则该维度跳过）。 */
  claims: readonly DeepCheckClaim[]
  /** 世界观全文（ability 维度的第一类用；空串时只查第二类「先说用尽后又用」。）。 */
  worldbuilding: string
  /** 要跑的维度键（作者勾选后剩下的）。 */
  keys: readonly DeepReviewDimensionKey[]
  /** 进度回调（写进运行日志，作者能看到跑到哪一维）。 */
  onProgress?: (message: string) => void
  /** 是否已被取消（每维开跑前检查一次）。 */
  cancelled?: () => boolean
}

export interface DeepCheckResult {
  /** 每个跑过的维度一行：键、状态、findings 数。 */
  lines: string[]
  findings: ConsistencyFinding[]
  /** 失败的维度（模型错误等）；不中断其余维度。 */
  failures: Array<{ key: DeepReviewDimensionKey; error: string }>
}

/** 读持久化的勾选；没有文件/坏 JSON → 全勾。 */
export async function readDeepReviewSelection(
  session: ProjectSessionContext,
): Promise<Record<DeepReviewDimensionKey, boolean>> {
  const existing = await ipc.invokeWithProjectSession(
    session, 'fs:read-json', `${session.projectPath}/${DEEP_REVIEW_PREFS_REL}`, session.projectPath,
  ).catch(() => null)
  const disabled = existing?.success && existing.data ? (existing.data as { disabled?: unknown }).disabled : null
  return deepReviewSelectionFromDisabled(disabled)
}

/** 保存勾选（只记取消的键）。 */
export async function writeDeepReviewSelection(
  session: ProjectSessionContext,
  selection: Record<DeepReviewDimensionKey, boolean>,
): Promise<void> {
  const disabled = DEEP_REVIEW_DIMENSIONS
    .map(dimension => dimension.key)
    .filter(key => selection[key] === false)
  await ipc.invokeWithProjectSession(
    session, 'fs:write-json', `${session.projectPath}/${DEEP_REVIEW_PREFS_REL}`,
    { version: 1, disabled }, session.projectPath,
  )
}

const dimensionLabel = (key: DeepReviewDimensionKey, locale: 'zh-CN' | 'en-US'): string => {
  const dimension = DEEP_REVIEW_DIMENSIONS.find(item => item.key === key)!
  return locale === 'en-US' ? dimension.en : dimension.zh
}

/**
 * 按勾选逐维跑模型核对，findings 汇总返回。
 *
 * ⚠️ 单维失败**不中断**其余维度（一次网络抖动不该让整份深度检查作废）；
 * 失败明细在 `result.failures`，由调用方写进日志。
 */
export async function runDeepReviewChecks(input: DeepCheckInput): Promise<DeepCheckResult> {
  const text = useLocaleStore.getState().text
  const locale = useLocaleStore.getState().locale
  const lines: string[] = []
  const findings: ConsistencyFinding[] = []
  const failures: DeepCheckResult['failures'] = []
  const finalized = input.finalizedChapters

  for (const key of input.keys) {
    if (input.cancelled?.()) break
    const label = dimensionLabel(key, locale)
    input.onProgress?.(text(`深度检查 · ${label}…`, `Deep check · ${label}…`))
    try {
      let count: number | null = null
      switch (key) {
        case 'appearance': {
          if (input.cards.length === 0) { lines.push(text(`· ${label}：角色卡里还没有外观描述，跳过。`, `· ${label}: no character card describes an appearance, skipped.`)); break }
          const outcome = await checkAppearanceAgainstCards(input.session, finalized, input.cards, locale)
          if (outcome.status === 'failed') { failures.push({ key, error: outcome.error ?? '' }); break }
          lines.push(text(`· ${label}：${outcome.contradictions.length} 处相悖、${outcome.unusedMarks.length} 条卡上标志未用。`, `· ${label}: ${outcome.contradictions.length} contradiction(s), ${outcome.unusedMarks.length} unused card mark(s).`))
          break
        }
        case 'ability': {
          const outcome = await reviewAbilityLimits(input.session, input.worldbuilding, finalized, locale)
          if (outcome.status === 'failed') { failures.push({ key, error: outcome.error ?? '' }); break }
          count = outcome.findings.length
          findings.push(...outcome.findings)
          break
        }
        case 'style': {
          const outcome = await reviewProseStyle(input.session, finalized, locale)
          if (outcome.status === 'failed') { failures.push({ key, error: outcome.error ?? '' }); break }
          count = outcome.findings.length
          findings.push(...outcome.findings)
          break
        }
        case 'content': {
          const outcome = await reviewProseContent(input.session, finalized, CONTENT_AXES_FOR_BUTTON, locale)
          if (outcome.status === 'failed') { failures.push({ key, error: outcome.error ?? '' }); break }
          count = outcome.findings.length
          findings.push(...outcome.findings)
          break
        }
        case 'sensory': {
          const outcome = await reviewSensoryChannels(input.session, finalized, locale)
          if (outcome.status === 'failed') { failures.push({ key, error: outcome.error ?? '' }); break }
          lines.push(text(`· ${label}：${outcome.summary ? '完成。' : '没有可核对的内容。'}`, `· ${label}: ${outcome.summary ? 'done.' : 'nothing to check.'}`))
          break
        }
        case 'memory': {
          // 本章是「回忆的出处」，已定稿章是锚点池——审稿视角正好与预检相反。
          const outcome = await reviewMemoryAnchors(input.session, [input.chapter], finalized, locale)
          if (outcome.status === 'failed') { failures.push({ key, error: outcome.error ?? '' }); break }
          count = outcome.findings.length
          findings.push(...outcome.findings)
          break
        }
        case 'blueprintFacts': {
          if (input.claims.length === 0) { lines.push(text(`· ${label}：本章没有蓝图断言，跳过。`, `· ${label}: no blueprint claims for this chapter, skipped.`)); break }
          const outcome = await reviewBlueprintAgainstProse(input.session, input.claims, finalized, locale)
          if (outcome.status === 'failed') { failures.push({ key, error: outcome.error ?? '' }); break }
          count = outcome.findings.length
          findings.push(...outcome.findings)
          break
        }
        case 'evidence': {
          const outcome = await reviewEvidenceShapes(input.session, [...finalized, input.chapter], input.cards, locale)
          if (outcome.status === 'failed') { failures.push({ key, error: outcome.error ?? '' }); break }
          count = outcome.findings.length
          findings.push(...outcome.findings)
          break
        }
        case 'handwriting': {
          const castNames = input.cards.map(card => card.name)
          const outcome = await reviewHandwritingTraits(input.session, [...finalized, input.chapter], castNames, locale)
          if (outcome.status === 'failed') { failures.push({ key, error: outcome.error ?? '' }); break }
          count = outcome.findings.length
          findings.push(...outcome.findings)
          break
        }
        case 'blueprintInternal': {
          const outcome = await reviewBlueprintInternals(input.session, input.claims.map(claim => ({ chapterNumber: claim.chapterNumber, text: claim.claims })), locale)
          if (outcome.status === 'failed') { failures.push({ key, error: outcome.error ?? '' }); break }
          count = outcome.findings.length
          findings.push(...outcome.findings)
          break
        }
        case 'lossRestatement': {
          const outcome = await reviewLossRestatements(input.session, [...finalized, input.chapter], locale)
          if (outcome.status === 'failed') { failures.push({ key, error: outcome.error ?? '' }); break }
          count = outcome.findings.length
          findings.push(...outcome.findings)
          break
        }
        case 'deadline': {
          const outcome = await reviewDeadlines(input.session, [...finalized, input.chapter], locale)
          if (outcome.status === 'failed') { failures.push({ key, error: outcome.error ?? '' }); break }
          count = outcome.findings.length
          findings.push(...outcome.findings)
          break
        }
        case 'dateConflict': {
          const outcome = await reviewDateConflicts(input.session, [...finalized, input.chapter], locale)
          if (outcome.status === 'failed') { failures.push({ key, error: outcome.error ?? '' }); break }
          count = outcome.findings.length
          findings.push(...outcome.findings)
          break
        }
      }
      if (count !== null) lines.push(text(`· ${label}：${count} 条发现。`, `· ${label}: ${count} finding(s).`))
    } catch (error) {
      failures.push({ key, error: error instanceof Error ? error.message : String(error) })
    }
    void input.session
    void isProjectSessionCurrent
  }
  return { lines, findings, failures }
}
