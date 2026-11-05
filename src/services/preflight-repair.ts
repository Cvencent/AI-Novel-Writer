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
import type { ProjectSessionContext } from '../shared/ipc-channels'
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
  type AppearanceContradiction,
  type AppearanceReviewCard,
  type AppearanceReviewChapter,
} from '../shared/appearance-consistency'
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
  const response = await useLLMStore.getState().generate(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    undefined,
    { projectSession: session, purpose: 'generation', responseFormat: { type: 'json_object' } },
  )
  if (!response.success) {
    return { status: 'failed', layer, chapterNumber, error: response.error || (en ? 'The model call failed.' : '模型调用失败。') }
  }
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
  error?: string
}

export async function checkAppearanceAgainstCards(
  session: ProjectSessionContext,
  chapters: readonly AppearanceReviewChapter[],
  cards: readonly AppearanceReviewCard[],
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
): Promise<AppearanceCheckOutcome> {
  const en = locale === 'en-US'
  const request = { chapters, cards, language: locale }
  if (chapters.length === 0 || cards.length === 0) return { status: 'ok', contradictions: [] }
  const { system, user } = buildAppearanceReviewPrompt(request)
  const response = await useLLMStore.getState().generate(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    undefined,
    { projectSession: session, purpose: 'generation', responseFormat: { type: 'json_object' } },
  )
  if (!response.success) {
    return { status: 'failed', contradictions: [], error: response.error || (en ? 'The model call failed.' : '模型调用失败。') }
  }
  const parsed = parseAppearanceReview(response.content, request)
  if (!parsed) {
    return { status: 'failed', contradictions: [], error: en
      ? 'The model did not return a valid contradiction list.'
      : '模型返回的不是合法的「相悖」清单。' }
  }
  return { status: 'ok', contradictions: parsed }
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
  const response = await useLLMStore.getState().generate(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    undefined,
    { projectSession: session, purpose: 'generation', responseFormat: { type: 'json_object' } },
  )
  if (!response.success) {
    return { status: 'failed', summary: null, error: response.error || (en ? 'The model call failed.' : '模型调用失败。') }
  }
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
  const response = await useLLMStore.getState().generate(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    undefined,
    { projectSession: session, purpose: 'generation', responseFormat: { type: 'json_object' } },
  )
  if (!response.success) {
    return { status: 'failed', findings: [], error: response.error || (en ? 'The model call failed.' : '模型调用失败。') }
  }
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
  const response = await useLLMStore.getState().generate(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    undefined,
    { projectSession: session, purpose: 'generation', responseFormat: { type: 'json_object' } },
  )
  if (!response.success) {
    return { status: 'failed', findings: [], error: response.error || (en ? 'The model call failed.' : '模型调用失败。') }
  }
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
  const response = await useLLMStore.getState().generate(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    undefined,
    { projectSession: session, purpose: 'generation', responseFormat: { type: 'json_object' } },
  )
  if (!response.success) {
    return { status: 'failed', findings: [], error: response.error || (en ? 'The model call failed.' : '模型调用失败。') }
  }
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
  error?: string
}

export async function reviewMemoryAnchors(
  session: ProjectSessionContext,
  chapters: readonly MemoryCallbackChapter[],
  earlierChapters: readonly MemoryCallbackChapter[],
  locale: 'zh-CN' | 'en-US' = 'zh-CN',
): Promise<MemoryAnchorOutcome> {
  const en = locale === 'en-US'
  if (chapters.length === 0 || earlierChapters.length === 0) return { status: 'ok', findings: [] }
  const request = { chapters, earlierChapters, language: locale }
  const { system, user, callbacks } = buildMemoryAnchorPrompt(request)
  if (callbacks.length === 0) return { status: 'ok', findings: [] }
  const response = await useLLMStore.getState().generate(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    undefined,
    { projectSession: session, purpose: 'generation', responseFormat: { type: 'json_object' } },
  )
  if (!response.success) {
    return { status: 'failed', findings: [], error: response.error || (en ? 'The model call failed.' : '模型调用失败。') }
  }
  const issues = parseMemoryAnchorReview(response.content, request)
  if (!issues) {
    return { status: 'failed', findings: [], error: en
      ? 'The model did not return a valid memory-anchor list.'
      : '模型返回的不是合法的「回忆无锚点」清单。' }
  }
  return { status: 'ok', findings: memoryAnchorFindings(issues) }
}
