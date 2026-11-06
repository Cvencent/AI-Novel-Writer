/**
 * 「一键修复」的**编排**（issue #137 第二层）：生成交给模型，规则只做能断言的。
 *
 * 这一层的分工（用户 2026-11-04 定规：规则做不完整的地方要交模型）：
 *
 * | 步骤 | 谁做 |
 * |---|---|
 * | 哪条提醒属于哪一层、现在能不能改 | **规则**（`preflight-route.ts`） |
 * | 每层能改哪几个字段、输入怎么组装、输出怎么校验、差异怎么算 | **规则**（`preflight-repair.ts`） |
 * | 按建议把字段改出来 | **模型**（本文件的一次调用） |
 * | 采纳哪几处改动 | **作者**（差异面板里点） |
 *
 * ⚠️ 本文件**不落库**：差异由作者确认后，由调用方走**现成写通道**。
 * 自动采纳会让「模型顺手改了无关字段」的事没人发现，而那正是这一层最该防的。
 *
 * ## 本层只覆盖 blueprint / world 两层（刻意）
 *
 * - **角色层不在这里**：`db:character-roster-commit` 要求完整 CAS 载荷
 *   （`expectedRevision` / `schemaVersion` / `operationId` / 全量 `entries`），
 *   而角色名的改动还会牵动别名的有效期。用一个薄服务半实现它，写错的是账本。
 *   角色层已有「去角色名单改」出口（第一层），那里有完整的身份校验。
 * - **细纲层不在这里**：它是按段落（`arcIndex` + revision）替换的，字段口径与另两层不同。
 * - **正文层**只读（只能新版本 + 重新定稿）。
 */

import { ipc } from './ipc-client'
import type { LLMResponse, ProjectSessionContext } from '../shared/ipc-channels'
import { useLLMStore } from '../stores/llm-store'
import type { ConsistencyFinding } from '../shared/consistency-preflight'
import {
  buildRepairPrompt,
  diffRepairPatch,
  parseRepairPatch,
  type RepairFieldDiff,
} from '../shared/preflight-repair'
import type { PreflightLayer } from '../shared/preflight-route'

import {
  buildAppearanceReviewPrompt,
  parseAppearanceReview,
  parseAppearanceUsage,
  type AppearanceContradiction,
  type AppearanceReviewCard,
  type AppearanceReviewChapter,
  type AppearanceUnusedMark,
} from '../shared/appearance-consistency'
import {
  buildProseConflictPrompt,
  parseProseConflictReview,
  proseConflictFindings,
  type BlueprintClaimChapter,
} from '../shared/prose-conflict-review'
import {
  buildDeadlineReviewPrompt,
  deadlineReviewFindings,
  parseDeadlineReview,
  type DeadlineChapter,
} from '../shared/deadline-review'
import {
  buildLossRestatementPrompt,
  lossRestatementReviewFindings,
  parseLossRestatementReview,
  type LossReviewChapter,
} from '../shared/loss-restatement-review'
import {
  blueprintInternalFindings,
  buildBlueprintInternalPrompt,
  parseBlueprintInternalReview,
  type BlueprintInternalChapter,
} from '../shared/blueprint-internal-review'
import {
  buildHandwritingReviewPrompt,
  handwritingReviewFindings,
  parseHandwritingReview,
  type HandwritingChapter,
} from '../shared/handwriting-review'
import {
  buildEvidenceShapePrompt,
  evidenceShapeFindings,
  parseEvidenceShapeReview,
  type EvidenceCastCard,
  type EvidenceChapter,
} from '../shared/evidence-shape-review'
import {
  buildMemoryAnchorPrompt,
  memoryAnchorFindings,
  parseMemoryAnchorReview,
  type MemoryCallbackChapter,
} from '../shared/memory-anchor-review'
import {
  abilityReviewFindings,
  buildAbilityReviewPrompt,
  limitSentencesOf,
  parseAbilityReview,
  type AbilityReviewChapter,
} from '../shared/ability-review'
import {
  buildContentReviewPrompt,
  contentReviewFindings,
  parseContentReview,
  type ContentAxis,
  type ContentReviewChapter,
} from '../shared/content-review'
import {
  buildStyleReviewPrompt,
  parseStyleReview,
  styleIssueFindings,
  type StyleReviewChapter,
} from '../shared/prose-style-review'
import {
  buildSensoryReviewPrompt,
  parseSensoryReview,
  summarizeSensoryVerdicts,
  type SensoryReviewChapter,
  type SensoryVerdictSummary,
} from '../shared/sensory-review'

/**
 * 这次核对用的模型调用：**失败是返回值，不是异常**（issue #203）。
 *
 * 现场：点「核对物证形态」等到 305 秒，通道 504。`generate()` 最后一句是
 * `requireIpcSuccess(response, '模型生成')` —— 它按契约**抛异常**，而下面 13 个 `review*`
 * 函数都只写了 `if (!response.success) return { status: 'failed', … }`（假设不抛）。
 * 异常于是穿过 `review*`、穿过按钮的 `try`，被 `finally` 吞掉 → 进度行消失、卡片没变、
 * 弹层一个字都没多：**失败与「查过了没问题」在界面上长得一模一样**。
 *
 * 这里把两条路都收成一个值：
 * - 抛异常 → `{ error: 异常文案 }`；
 * - 返回 `success: false` → `{ error: 响应里的原因 || 兜底文案 }`。
 *
 * 这样每个 `review*` 的返回类型里那个 `status: 'failed'` 才真的成立，
 * 调用方（11 颗核对按钮）已有的 `if (outcome.status === 'failed') setMessage(...)` 才会跑。
 */
async function askReviewModel(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  session: ProjectSessionContext,
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
): Promise<{ response: LLMResponse } | { error: string }> {
  const fallback = locale === 'en-US' ? 'The model call failed.' : '模型调用失败。'
  let response: LLMResponse
  try {
    response = await useLLMStore.getState().generate(messages, undefined,
      { projectSession: session, purpose: 'generation', responseFormat: { type: 'json_object' } })
  } catch (error) {
    // 异常文案本身就是主进程归类过的原因（超时/504/连接被拒），直接带给作者。
    const message = error instanceof Error ? error.message : String(error ?? '')
    return { error: message.trim() || fallback }
  }
  if (!response.success) return { error: response.error?.trim() || fallback }
  return { response }
}

/** 能做字段级补丁的层（其余层走各自的页面或只能重定稿）。 */
export const FIELD_PATCH_LAYERS: readonly PreflightLayer[] = ['blueprint', 'world']

export function canPatchFields(layer: PreflightLayer): boolean {
  return FIELD_PATCH_LAYERS.includes(layer)
}

/** 一层的修复结果：要么给出差异，要么给出「模型认为不用改」，要么给出失败原因。 */
export type RepairOutcome =
  | { status: 'proposed'; layer: PreflightLayer; chapterNumber: number | null; diffs: RepairFieldDiff[] }
  | { status: 'unchanged'; layer: PreflightLayer; chapterNumber: number | null }
  | { status: 'failed'; layer: PreflightLayer; chapterNumber: number | null; error: string }

/** 读该层现有全文（字段名 → 原文）。读不到返回 null（调用方如实报失败）。 */
async function readLayerText(
  session: ProjectSessionContext,
  layer: PreflightLayer,
  chapterNumber: number | null,
): Promise<Record<string, string> | null> {
  if (layer === 'blueprint') {
    if (chapterNumber === null) return null
    const blueprint = await ipc.invokeWithProjectSession(session, 'db:blueprint-get', chapterNumber, session.projectPath)
    if (!blueprint) return null
    return {
      title: String(blueprint.title ?? ''),
      role: String(blueprint.role ?? ''),
      purpose: String(blueprint.purpose ?? ''),
      keyEvents: String(blueprint.keyEvents ?? ''),
      characters: (blueprint.characters ?? []).join('、'),
      suspenseHook: String(blueprint.suspenseHook ?? ''),
      costsAndTurns: String(blueprint.costsAndTurns ?? ''),
      foreshadowing: String(blueprint.foreshadowing ?? ''),
      userGuidance: String(blueprint.userGuidance ?? ''),
      notes: String(blueprint.notes ?? ''),
    }
  }
  if (layer === 'world') {
    const core = await ipc.invokeWithProjectSession(session, 'db:project-core-get', session.projectPath)
    if (!core) return null
    const record = core as unknown as Record<string, unknown>
    return {
      worldbuilding: String(record.worldbuilding ?? ''),
      premise: String(record.premise ?? ''),
      coreOutline: String(record.coreOutline ?? ''),
      goldenFinger: String(record.goldenFinger ?? ''),
      globalGuidance: String(record.globalGuidance ?? ''),
      writingStyle: String(record.writingStyle ?? ''),
    }
  }
  return null
}

/** 这一条提醒落在哪一章：蓝图层用 `sourceChapter`（判据自己标的），世界观层为 null。 */
export function chapterOfFinding(finding: ConsistencyFinding): number | null {
  return Number.isSafeInteger(finding.sourceChapter) && finding.sourceChapter > 0
    ? finding.sourceChapter
    : null
}

/**
 * 对一层的一批提醒跑**一次**修复生成（一层一次调用，不是一条一次）。
 *
 * 失败一律返回 `failed` 并带原因，**不静默**：作者点了一次「修复」什么都没发生，
 * 比报一条错更糟。
 */
export async function proposeLayerRepair(
  session: ProjectSessionContext,
  layer: PreflightLayer,
  chapterNumber: number | null,
  findings: readonly ConsistencyFinding[],
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
): Promise<RepairOutcome> {
  const en = locale === 'en-US'
  if (!canPatchFields(layer)) {
    return { status: 'failed', layer, chapterNumber, error: en
      ? 'This layer has no field-level write channel; open its own page instead.'
      : '这一层没有字段级写通道，请到它自己的页面改。' }
  }
  if (findings.length === 0) return { status: 'unchanged', layer, chapterNumber }
  const current = await readLayerText(session, layer, chapterNumber)
  if (!current) {
    return { status: 'failed', layer, chapterNumber, error: en
      ? 'Could not read this layer’s current text.'
      : '读不到这一层的现有文本。' }
  }
  const request = { layer, chapterNumber, current, findings }
  const { system, user } = buildRepairPrompt(request, locale)
  const call = await askReviewModel([{ role: 'system', content: system }, { role: 'user', content: user }], session)
  if ('error' in call) return { status: 'failed', layer, chapterNumber, error: call.error }
  const response = call.response
  const patch = parseRepairPatch(response.content, request)
  if (!patch) {
    return { status: 'failed', layer, chapterNumber, error: en
      ? 'The model did not return a valid field patch (invalid JSON, or it touched fields outside this layer).'
      : '模型返回的不是合法的字段补丁（JSON 不合法，或动了本层之外的字段）。' }
  }
  const diffs = diffRepairPatch(patch, request)
  if (diffs.length === 0) return { status: 'unchanged', layer, chapterNumber }
  return { status: 'proposed', layer, chapterNumber, diffs }
}

/**
 * 作者确认后落库（走**现成写通道**，不新开通道）。
 *
 * - 蓝图层 → `db:stage-review-apply-blueprint`（唯一字段级 merge；内部把 `characters`
 *   字符串按顿号拆回数组）。
 * - 世界观层 → `db:project-core-update`（`Partial<ProjectCoreData>` 逐字段）。
 * - 其余层 → 明确拒绝并给原因（不「顺手找一条相近的通道」）。
 */
export async function applyRepairDiffs(
  session: ProjectSessionContext,
  layer: PreflightLayer,
  chapterNumber: number | null,
  diffs: readonly RepairFieldDiff[],
): Promise<{ success: boolean; error?: string }> {
  if (diffs.length === 0) return { success: true }
  const patch: Record<string, string> = {}
  for (const diff of diffs) patch[diff.field] = diff.after
  if (layer === 'blueprint') {
    if (chapterNumber === null) return { success: false, error: 'BLUEPRINT_CHAPTER_REQUIRED' }
    return ipc.invokeWithProjectSession(session, 'db:stage-review-apply-blueprint', chapterNumber, patch, session.projectPath)
  }
  if (layer === 'world') {
    return ipc.invokeWithProjectSession(session, 'db:project-core-update', patch, session.projectPath)
  }
  return { success: false, error: 'LAYER_NOT_WRITABLE' }
}
/**
 * 角色卡外观与正文的对账（issue #153）——**一次模型调用**，本模块只负责组装与校验。
 *
 * 为什么不能写规则：判断「正文这一处与卡上描述是否相悖」是内容判断，
 * 而任何词表都只对这一本书成立（第一版用 `缺/断/疤/伤` + `小指/虎口` 这类封闭词类，
 * 被用户 2026-11-05 明确否掉）。规则能做的只有：喂什么、要什么形状、答案能不能核对。
 */
export interface AppearanceCheckOutcome {
  status: 'ok' | 'failed'
  contradictions: AppearanceContradiction[]
  /**
   * 卡上有、这几章一次没用到的显眼标志（issue #153 第一部分）。
   * `checkUsage` 没开时恒为空——那是可选的一轴，不混进默认「核对角色外观」。
   */
  unusedMarks: AppearanceUnusedMark[]
  error?: string
}

export async function checkAppearanceAgainstCards(
  session: ProjectSessionContext,
  chapters: readonly AppearanceReviewChapter[],
  cards: readonly AppearanceReviewCard[],
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
  /** 同时统计「卡上的标志这几章用没用」（issue #153 第一部分）。默认关。 */
  checkUsage = false,
): Promise<AppearanceCheckOutcome> {
  const en = locale === 'en-US'
  const request = { chapters, cards, language: locale, checkUsage }
  if (chapters.length === 0 || cards.length === 0) return { status: 'ok', contradictions: [], unusedMarks: [] }
  const { system, user } = buildAppearanceReviewPrompt(request)
  const call = await askReviewModel([{ role: 'system', content: system }, { role: 'user', content: user }], session)
  if ('error' in call) return { status: 'failed', contradictions: [], unusedMarks: [], error: call.error }
  const response = call.response
  const parsed = parseAppearanceReview(response.content, request)
  if (!parsed) {
    return { status: 'failed', contradictions: [], unusedMarks: [], error: en
      ? 'The model did not return a valid contradiction list.'
      : '模型返回的不是合法的「相悖」清单。' }
  }
  // 第二轴单独解析（见 parseAppearanceUsage 的注释）：它失败**不影响**相悖的结论。
  const unusedMarks = checkUsage ? parseAppearanceUsage(response.content, request) ?? [] : []
  return { status: 'ok', contradictions: parsed, unusedMarks }
}

/**
 * 把「卡上有、正文没用」转成一致性发现（issue #153 第一部分）。
 *
 * ⚠️ 这是**提示**，不是缺陷：这一章可能真的不需要写到他的金戒指。
 * 所以文案必须给出「接受它」的读法（「这次不需要写」与「写忘了」是两件事），
 * 并且 key 只锚在**角色 + 那条标志**上（不带章号）：同一个人不会被逐章重报一遍
 * （与 #160/#86 同一条纪律）。章号集合放在 evidence 里，作者照样能定位。
 */
export function appearanceUnusedMarkFindings(
  marks: readonly AppearanceUnusedMark[],
): ConsistencyFinding[] {
  return marks.map(item => ({
    stableFactKey: `character:appearance-unused:${item.characterName}:${item.mark}`,
    severity: 'warning' as const,
    sourceChapter: item.chapters[item.chapters.length - 1]!,
    evidence: `「${item.characterName}」在第 ${item.chapters.join('、')} 章出场，卡上的「${item.mark}」一次没写到`,
    issue: {
      zhCN: `角色卡把「${item.mark}」当作「${item.characterName}」的显眼标志，但他在第 ${item.chapters.join('、')} 章出场时一次都没写到这里。${item.explanation ? `（${item.explanation}）` : ''}读者认人靠的往往正是这一半——衣服和手里的东西每场都用得上，身体标志却不会自己出现；只写前者，人物会慢慢变成「道具架」。`,
      enUS: `The card treats “${item.mark}” as a distinctive mark of ${item.characterName}, but it never appears in chapters ${item.chapters.join(', ')} where they are present.${item.explanation ? ` (${item.explanation})` : ''} Readers recognize people by exactly this half — clothing and props are needed in every scene, body marks are not, so writing only the former turns characters into prop racks.`,
    },
    suggestion: {
      zhCN: `这一次不需要写它也完全可以——但如果好几章都只写衣着与随身物，可以择一处让他自己动到这个标志（抬手、按住、缩回），一句话就够，不要另起一段描写。另一条路是承认这条标志不再是识别点，把它从卡上删掉（卡上留着却从不出现，后面的判据还会继续按它核对）。`,
      enUS: `It is fine for this chapter to skip it. But if several chapters rely only on clothing and props, let the mark come into play once in a gesture (raised, pressed, withdrawn) — one clause, no separate description. Alternatively, if the mark no longer identifies them, remove it from the card; otherwise later checks will keep matching against it.`,
    },
  }))
}

/** 把模型判出来的相悖转成一致性发现（供预检/审稿同一出口展示）。 */
export function appearanceContradictionFindings(
  contradictions: readonly AppearanceContradiction[],
): ConsistencyFinding[] {
  return contradictions.map(item => ({
    // 章号 + 角色是既成事实；**引文**也进 key 的尾部（同一章同一人可能有多处），
    // 但不带当前章号——否则提醒永远关不掉（#86/#89/#98/#108）。
    stableFactKey: `character:appearance-contradiction:${item.chapterNumber}:${item.characterName}`,
    severity: 'warning' as const,
    sourceChapter: item.chapterNumber,
    evidence: `第${item.chapterNumber}章：「${item.quote}」`,
    issue: {
      zhCN: `正文与角色卡对不上：「${item.characterName}」的这一处描写与卡上冲突——${item.explanation || '正文与卡上的描述不能同时成立。'}`,
      enUS: `The prose disagrees with the character card: this description of “${item.characterName}” cannot hold together with the card — ${item.explanation || 'the two cannot both be true.'}`,
    },
    suggestion: {
      zhCN: `二选一：把正文这一处改成与角色卡一致；或者若正文才是本意，就改角色卡（并在后面统一）。改完顺带核一下前后章有没有只写「缺半截的小指」这种不交代左右的写法——那种写法会让这个错被埋掉。`,
      enUS: `Either make this sentence agree with the card, or update the card if the prose is right (and keep later chapters consistent). Also check whether neighbouring chapters only say "the missing fingertip" without a side — that phrasing hides the error.`,
    },
  }))
}

/**
 * 感官通道覆盖（issue #151 的规则修正）——**一次模型调用**，规则只负责喂与校验。
 *
 * 旧实现用气味/味觉/拟声三张词表去数；用户 2026-11-05 明确否掉那整类做法
 * （「不能去设计词表，也不能用任何的短语匹配，内容类的全部让模型判断」）。
 * 判断「这一段有没有写气味」需要理解内容，只能交模型；规则能做的是：
 * 喂哪几章、要什么 JSON 形状、答案里的章号是否合法。
 */
export interface SensoryReviewOutcome {
  status: 'ok' | 'failed'
  summary: SensoryVerdictSummary | null
  error?: string
}

export async function reviewSensoryChannels(
  session: ProjectSessionContext,
  chapters: readonly SensoryReviewChapter[],
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
): Promise<SensoryReviewOutcome> {
  const en = locale === 'en-US'
  const request = { chapters, language: locale }
  if (chapters.length === 0) return { status: 'ok', summary: null }
  const { system, user } = buildSensoryReviewPrompt(request)
  const call = await askReviewModel([{ role: 'system', content: system }, { role: 'user', content: user }], session)
  if ('error' in call) return { status: 'failed', summary: null, error: call.error }
  const response = call.response
  const verdicts = parseSensoryReview(response.content, request)
  if (!verdicts) {
    return { status: 'failed', summary: null, error: en
      ? 'The model did not return a valid per-chapter verdict list.'
      : '模型返回的不是合法的逐章判断清单。' }
  }
  return { status: 'ok', summary: summarizeSensoryVerdicts(verdicts) }
}

/** 把汇总转成一致性发现（只在这段**确实**稀疏时报）。 */
export function sensoryVerdictFindings(summary: SensoryVerdictSummary | null): ConsistencyFinding[] {
  if (!summary || !summary.sparse || summary.smellChapters.length === 0 && summary.silentChapters.length === 0) return []
  const first = Math.min(...summary.silentChapters.concat(summary.smellChapters))
  const last = Math.max(...summary.silentChapters.concat(summary.smellChapters))
  const silent = summary.silentChapters
  return [{
    // 取这一段的首章（不带末章号）：这一段随新章滚动，带末章会让 ack 永远对不上（#86/#89/#98/#108）。
    stableFactKey: `prose-flavor:sensory:${first}`,
    severity: 'warning' as const,
    sourceChapter: last,
    evidence: `模型逐章判断：第${first}–${last}章共 ${summary.total} 章，只有 ${summary.smellChapters.length} 章写了气味`
      + `（${Math.round(summary.smellShare * 100)}%）；味觉 ${summary.tasteChapters.length} 章、环境音 ${summary.soundChapters.length} 章；`
      + `三类全无的章：${silent.length ? silent.map(n => `第${n}章`).join('、') : '无'}`,
    issue: {
      zhCN: `感官通道几乎只剩视觉与触觉：最近 ${summary.total} 章里只有 ${summary.smellChapters.length} 章写过气味（${Math.round(summary.smellShare * 100)}%），味觉 ${summary.tasteChapters.length} 章、环境音 ${summary.soundChapters.length} 章，三类全无的有 ${silent.length} 章。起草与精修模板都要求「通过五感细节强化环境描写」，但没有一层核对它——于是逐章退化成最擅长的通道。`,
      enUS: `The sensory channels have collapsed into sight and touch: of the last ${summary.total} chapters only ${summary.smellChapters.length} use any smell (${Math.round(summary.smellShare * 100)}%), ${summary.tasteChapters.length} use taste, ${summary.soundChapters.length} use ambient sound, and ${silent.length} use none of the three. Both templates ask for sensory detail, but nothing checks it.`,
    },
    suggestion: {
      zhCN: `在列出的那几章里各补一处**当场闻到的气味**（不必长）：要写清是什么东西发出的、在什么动作之后闻到的；不要写「闻到一股难以形容的味道」这类空话。改的是少数几章，不用每章都补。`,
      enUS: `Add one on-the-spot smell to a few of the chapters listed: say what the thing is and what action raised the smell. Rewrite only a few chapters, not all of them.`,
    },
  }]
}

/**
 * 文风**内容**判据（比喻堆叠 / 生理套话 / 段尾总结 / 意象过载）——一次模型调用。
 *
 * 旧实现是三张短语表（`仿佛|犹如`、`喉结|攥拳`、`他知道，`…）。用户 2026-11-05：
 * 内容判断不许词表、不许短语匹配 → 全部交模型；规则只喂数据、校验形状与引文定位。
 */
export interface StyleReviewOutcome {
  status: 'ok' | 'failed'
  findings: ConsistencyFinding[]
  error?: string
}

export async function reviewProseStyle(
  session: ProjectSessionContext,
  chapters: readonly StyleReviewChapter[],
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
): Promise<StyleReviewOutcome> {
  const en = locale === 'en-US'
  const request = { chapters, language: locale }
  if (chapters.length === 0) return { status: 'ok', findings: [] }
  const { system, user } = buildStyleReviewPrompt(request)
  const call = await askReviewModel([{ role: 'system', content: system }, { role: 'user', content: user }], session)
  if ('error' in call) return { status: 'failed', findings: [], error: call.error }
  const response = call.response
  const issues = parseStyleReview(response.content, request)
  if (!issues) {
    return { status: 'failed', findings: [], error: en
      ? 'The model did not return a valid style-issue list.'
      : '模型返回的不是合法的文风问题清单。' }
  }
  return { status: 'ok', findings: styleIssueFindings(issues) }
}

/**
 * 跨章重复 / 道具链 / 陈旧时长——一次模型调用，只问 caller 选定的轴。
 */
export interface ContentReviewOutcome {
  status: 'ok' | 'failed'
  findings: ConsistencyFinding[]
  error?: string
}

export async function reviewProseContent(
  session: ProjectSessionContext,
  chapters: readonly ContentReviewChapter[],
  axes: readonly ContentAxis[],
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
): Promise<ContentReviewOutcome> {
  const en = locale === 'en-US'
  const request = { chapters, axes, language: locale }
  if (chapters.length === 0 || axes.length === 0) return { status: 'ok', findings: [] }
  const { system, user } = buildContentReviewPrompt(request)
  const call = await askReviewModel([{ role: 'system', content: system }, { role: 'user', content: user }], session)
  if ('error' in call) return { status: 'failed', findings: [], error: call.error }
  const response = call.response
  const issues = parseContentReview(response.content, request)
  if (!issues) {
    return { status: 'failed', findings: [], error: en
      ? 'The model did not return a valid content-issue list.'
      : '模型返回的不是合法的重复写法清单。' }
  }
  return { status: 'ok', findings: contentReviewFindings(issues) }
}

/** 能力限制被绕过（#100）——一次模型调用，限制句由世界观提供，判断交模型。 */
export interface AbilityReviewOutcome {
  status: 'ok' | 'failed'
  findings: ConsistencyFinding[]
  error?: string
}

export async function reviewAbilityLimits(
  session: ProjectSessionContext,
  worldbuilding: string,
  chapters: readonly AbilityReviewChapter[],
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
): Promise<AbilityReviewOutcome> {
  const en = locale === 'en-US'
  const limits = limitSentencesOf(worldbuilding)
  if (limits.length === 0 || chapters.length === 0) return { status: 'ok', findings: [] }
  const request = { limits, chapters, language: locale }
  const { system, user } = buildAbilityReviewPrompt(request)
  const call = await askReviewModel([{ role: 'system', content: system }, { role: 'user', content: user }], session)
  if ('error' in call) return { status: 'failed', findings: [], error: call.error }
  const response = call.response
  const issues = parseAbilityReview(response.content, request)
  if (!issues) {
    return { status: 'failed', findings: [], error: en
      ? 'The model did not return a valid limit-violation list.'
      : '模型返回的不是合法的「限制被绕过」清单。' }
  }
  return { status: 'ok', findings: abilityReviewFindings(issues) }
}

/**
 * 记忆回指锚点（issue #167）——一次模型调用。
 *
 * 现场：第 78 章「他记得温珩摆手让他别停」，而全书「摆手」只出现这一次。
 * 规则只负责：取出含记忆动词的句子、把前文正文作为检索范围喂进去、校验引文可定位；
 * 「所指的事在前文有没有发生」交模型（那是内容判断）。
 */
export interface MemoryAnchorOutcome {
  status: 'ok' | 'failed'
  findings: ConsistencyFinding[]
  /**
   * 这次**没有可核对的回指句**，因此一次模型调用都没发（issue #175）。
   *
   * 现场：81 个写作时点里 51 个（63%）章节没有含记忆动词的句子，函数在这里提前返回，
   * 而界面把空结果与「模型真的没找到」共用同一句文案 —— 作者以为「查过了、没问题」。
   */
  skipped?: 'no-callbacks' | 'no-earlier-chapters'
  error?: string
}

export async function reviewMemoryAnchors(
  session: ProjectSessionContext,
  chapters: readonly MemoryCallbackChapter[],
  earlierChapters: readonly MemoryCallbackChapter[],
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
): Promise<MemoryAnchorOutcome> {
  const en = locale === 'en-US'
  if (chapters.length === 0 || earlierChapters.length === 0) {
    return { status: 'ok', findings: [], skipped: 'no-earlier-chapters' }
  }
  const request = { chapters, earlierChapters, language: locale }
  const { system, user, callbacks } = buildMemoryAnchorPrompt(request)
  // issue #175：没有回指句就**不发请求**，但要让调用方知道「没发」而不是「发了没找到」。
  if (callbacks.length === 0) return { status: 'ok', findings: [], skipped: 'no-callbacks' }
  const call = await askReviewModel([{ role: 'system', content: system }, { role: 'user', content: user }], session)
  if ('error' in call) return { status: 'failed', findings: [], error: call.error }
  const response = call.response
  // issue #184：把**模型实际看到的那一份**候选池交给解析器（而不是让它重算一份）。
  const issues = parseMemoryAnchorReview(response.content, request, callbacks)
  if (!issues) {
    return { status: 'failed', findings: [], error: en
      ? 'The model did not return a valid memory-anchor list.'
      : '模型返回的不是合法的「回忆无锚点」清单。' }
  }
  return { status: 'ok', findings: memoryAnchorFindings(issues) }
}

/**
 * 蓝图把某件事写成「一向如此」，而已定稿正文明写「没有发生」（issue #157）——一次模型调用。
 *
 * 现场：第 25 章蓝图 `foreshadowing` 写「码头老位置**每日一停**」，
 * 而第 24 章已定稿正文写「脚底下没慢，也**没停**」。前者是对过去整段时期的追认，
 * 等于把后者抹掉，且中间没有任何转折。
 *
 * 规则只负责：把蓝图的既有事实字段与前文正文摆在一起、校验两侧引文可定位；
 * 「这条说法在前文里是不是被明确否定了」交模型（那是内容判断）。
 * ⚠️ 不走「频率词表 + 否定词匹配」那条路（用户 2026-11-05 定规禁止）。
 */
export interface ProseConflictOutcome {
  status: 'ok' | 'failed'
  findings: ConsistencyFinding[]
  error?: string
}

export async function reviewBlueprintAgainstProse(
  session: ProjectSessionContext,
  claims: readonly BlueprintClaimChapter[],
  earlierChapters: readonly { chapterNumber: number, content: string }[],
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
): Promise<ProseConflictOutcome> {
  const en = locale === 'en-US'
  const usableClaims = claims.filter(chapter => String(chapter.claims ?? '').trim())
  if (usableClaims.length === 0 || earlierChapters.length === 0) return { status: 'ok', findings: [] }
  const request = { claims: usableClaims, earlierChapters, language: locale }
  const { system, user } = buildProseConflictPrompt(request)
  const call = await askReviewModel([{ role: 'system', content: system }, { role: 'user', content: user }], session)
  if ('error' in call) return { status: 'failed', findings: [], error: call.error }
  const response = call.response
  const issues = parseProseConflictReview(response.content, request)
  if (!issues) {
    return { status: 'failed', findings: [], error: en
      ? 'The model did not return a valid blueprint-vs-prose list.'
      : '模型返回的不是合法的「蓝图与正文相反」清单。' }
  }
  return { status: 'ok', findings: proseConflictFindings(issues) }
}

/**
 * 被当成证据的物件：跨章形态是否一致、成因是否物理成立（issue #156）——一次模型调用。
 *
 * 现场：第 73 章「半个红指印，**圆圆的**」→ 第 74 章「**缺口齐整**，缺了半节的**拇指**按的」，
 * 而叶九缺的是**右小指**（第 45 章他自己用拇指压过页面）。第 74 章的「缺口对上」
 * 与第 75 章凭它放人，全建立在这条不成立的推理上。
 *
 * 规则只负责：把最近若干章与角色卡的身体描述一起喂进去、要求**两处引文都逐字可定位**；
 * 「这两章是不是同一件物证」「这个形态与成因能不能同时成立」交模型。
 * ⚠️ 不走「印/痕迹词表 × 部位词表 × 按印词表」那条路（用户 2026-11-05 定规禁止）。
 */
export interface EvidenceShapeOutcome {
  status: 'ok' | 'failed'
  findings: ConsistencyFinding[]
  error?: string
}

export async function reviewEvidenceShapes(
  session: ProjectSessionContext,
  chapters: readonly EvidenceChapter[],
  cards: readonly EvidenceCastCard[],
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
): Promise<EvidenceShapeOutcome> {
  const en = locale === 'en-US'
  const request = { chapters, cards, language: locale }
  // 没有正文就没有可核对的东西；只有一章时仍可能判「这一章内的成因不成立」。
  if (chapters.length === 0) return { status: 'ok', findings: [] }
  const { system, user } = buildEvidenceShapePrompt(request)
  const call = await askReviewModel([{ role: 'system', content: system }, { role: 'user', content: user }], session)
  if ('error' in call) return { status: 'failed', findings: [], error: call.error }
  const response = call.response
  const issues = parseEvidenceShapeReview(response.content, request)
  if (!issues) {
    return { status: 'failed', findings: [], error: en
      ? 'The model did not return a valid evidence-shape list.'
      : '模型返回的不是合法的「物证形态」清单。' }
  }
  return { status: 'ok', findings: evidenceShapeFindings(issues) }
}

/**
 * 同一个书写者的笔迹被写成两套互斥特征（issue #97 的现场，issue #163 的迁移）——一次模型调用。
 *
 * 旧实现用四张书写质量词表（稳匀/急促/重笔/轻笔）加归属句正则判，按用户 2026-11-05 的定规
 * （内容判断不许词表、不许短语匹配）改由模型判。规则只负责：喂哪几章与名册、
 * 校验两处引文都能逐字定位、把答案收窄成清单。
 */
export interface HandwritingReviewOutcome {
  status: 'ok' | 'failed'
  findings: ConsistencyFinding[]
  error?: string
}

export async function reviewHandwritingTraits(
  session: ProjectSessionContext,
  chapters: readonly HandwritingChapter[],
  castNames: readonly string[],
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
): Promise<HandwritingReviewOutcome> {
  const en = locale === 'en-US'
  const request = { chapters, castNames, language: locale }
  if (chapters.length === 0) return { status: 'ok', findings: [] }
  const { system, user } = buildHandwritingReviewPrompt(request)
  const call = await askReviewModel([{ role: 'system', content: system }, { role: 'user', content: user }], session)
  if ('error' in call) return { status: 'failed', findings: [], error: call.error }
  const response = call.response
  const issues = parseHandwritingReview(response.content, request)
  if (!issues) {
    return { status: 'failed', findings: [], error: en
      ? 'The model did not return a valid handwriting-conflict list.'
      : '模型返回的不是合法的「笔迹自相矛盾」清单。' }
  }
  return { status: 'ok', findings: handwritingReviewFindings(issues) }
}

/**
 * 同一章蓝图**内部**自相矛盾（issue #172）——一次模型调用。
 *
 * 现场：第 79 章 `notes` 同一条目先写「收完压一道」，后写「温珩的结要压三道」，
 * 正文照抄两处，而全章落幅正是「他打不成温珩的结法」。
 *
 * 规则只负责把蓝图原文整段喂进去、校验两处引文都能在该章蓝图里逐字定位；
 * 「这两句说的是不是同一件事、值是不是互斥」交模型（那是内容判断）。
 */
export interface BlueprintInternalOutcome {
  status: 'ok' | 'failed'
  findings: ConsistencyFinding[]
  error?: string
}

export async function reviewBlueprintInternals(
  session: ProjectSessionContext,
  chapters: readonly BlueprintInternalChapter[],
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
): Promise<BlueprintInternalOutcome> {
  const en = locale === 'en-US'
  const usable = chapters.filter(chapter => String(chapter.text ?? '').trim())
  if (usable.length === 0) return { status: 'ok', findings: [] }
  const request = { chapters: usable, language: locale }
  const { system, user } = buildBlueprintInternalPrompt(request)
  const call = await askReviewModel([{ role: 'system', content: system }, { role: 'user', content: user }], session)
  if ('error' in call) return { status: 'failed', findings: [], error: call.error }
  const response = call.response
  const issues = parseBlueprintInternalReview(response.content, request)
  if (!issues) {
    return { status: 'failed', findings: [], error: en
      ? 'The model did not return a valid intra-plan conflict list.'
      : '模型返回的不是合法的「蓝图内部自相矛盾」清单。' }
  }
  return { status: 'ok', findings: blueprintInternalFindings(issues) }
}

/**
 * 同一笔遗忘被跨章重新宣告（issue #75 的现场，issue #163 的迁移）——一次模型调用。
 *
 * 旧实现是五张题材措辞表（记得/空了/空壳/被水洇/仍然没…），只对这本书的写法成立。
 * 按用户 2026-11-05 的定规改由模型判；规则只负责喂哪些章、校验引文与章号。
 */
export interface LossRestatementOutcome {
  status: 'ok' | 'failed'
  findings: ConsistencyFinding[]
  error?: string
}

export async function reviewLossRestatements(
  session: ProjectSessionContext,
  chapters: readonly LossReviewChapter[],
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
): Promise<LossRestatementOutcome> {
  const en = locale === 'en-US'
  const usable = chapters.filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
  // 少于两章谈不上「跨章重述」。
  if (usable.length < 2) return { status: 'ok', findings: [] }
  const request = { chapters: usable, language: locale }
  const { system, user } = buildLossRestatementPrompt(request)
  const call = await askReviewModel([{ role: 'system', content: system }, { role: 'user', content: user }], session)
  if ('error' in call) return { status: 'failed', findings: [], error: call.error }
  const response = call.response
  const issues = parseLossRestatementReview(response.content, request)
  if (!issues) {
    return { status: 'failed', findings: [], error: en
      ? 'The model did not return a valid loss-restatement list.'
      : '模型返回的不是合法的「同一笔损失被重复宣告」清单。' }
  }
  return { status: 'ok', findings: lossRestatementReviewFindings(issues) }
}

/**
 * 「期限宣告了却从不结算」（issue #101 的现场，issue #163 的迁移）——一次模型调用。
 *
 * 旧实现是四张题材措辞表（天亮前/日落前/明早… + 不许/别想/扣下… + 期限已过/逾期…），
 * 只对这本书的写法成立。按用户 2026-11-05 的定规改由模型判；
 * 规则只负责任意取候选宣告句、校验引文与章号。
 */
export interface DeadlineReviewOutcome {
  status: 'ok' | 'failed'
  findings: ConsistencyFinding[]
  error?: string
}

export async function reviewDeadlines(
  session: ProjectSessionContext,
  chapters: readonly DeadlineChapter[],
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
): Promise<DeadlineReviewOutcome> {
  const en = locale === 'en-US'
  const usable = chapters.filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
  if (usable.length < 2) return { status: 'ok', findings: [] }
  const request = { chapters: usable, language: locale }
  const { system, user } = buildDeadlineReviewPrompt(request)
  const call = await askReviewModel([{ role: 'system', content: system }, { role: 'user', content: user }], session)
  if ('error' in call) return { status: 'failed', findings: [], error: call.error }
  const response = call.response
  const issues = parseDeadlineReview(response.content, request)
  if (!issues) {
    return { status: 'failed', findings: [], error: en
      ? 'The model did not return a valid unsettled-deadline list.'
      : '模型返回的不是合法的「期限未结算」清单。' }
  }
  return { status: 'ok', findings: deadlineReviewFindings(issues) }
}
