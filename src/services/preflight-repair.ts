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
