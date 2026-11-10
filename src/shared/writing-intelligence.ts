import { extractSingleCompleteJsonObject } from './character-proposal-parser'

export interface SceneCard {
  id: string
  title: string
  goal: string
  conflict: string
  turn: string
  outcome: string
  characters: string[]
  targetWords: number | null
  notes: string
}

export type EditorialRole = 'plot' | 'continuity' | 'character' | 'style' | 'pacing'
export type EditorialFindingSeverity = 'blocking' | 'warning' | 'note'

export interface EditorialFinding {
  severity: EditorialFindingSeverity
  description: string
  evidence?: string
}

export interface EditorialRoleScore {
  role: EditorialRole
  score: number
  summary: string
  findings: EditorialFinding[]
}

export interface EditorialPanelReview {
  version: 1
  roles: EditorialRoleScore[]
  weightedScore: number
  blockingCount: number
  summary: string
}

export const EDITORIAL_ROLE_WEIGHTS: Readonly<Record<EditorialRole, number>> = Object.freeze({
  plot: 0.25,
  continuity: 0.25,
  character: 0.2,
  style: 0.15,
  pacing: 0.15,
})

const EDITORIAL_ROLES = Object.keys(EDITORIAL_ROLE_WEIGHTS) as EditorialRole[]

export interface CharacterVoiceProfile {
  characterId: string
  characterName: string
  summary: string
  sentenceStyle: string
  vocabulary: string
  dialogueHabits: string[]
  emotionalTells: string
  avoid: string[]
  evidence: string[]
}

export interface WritingFact {
  kind: string
  statement: string
  evidence: string
}

export interface CharacterStateCommit {
  characterId: string
  state: Record<string, unknown>
  /**
   * issue #225：true = 这一笔是**待确认候选**（还没落到卡上）。
   * 旧口径所有条目都不带标记，诊断者会把「提出了候选」读成「已回写」——
   * 两套账（commit 账本 vs cs_provenance）从此分叉。
   */
  pending?: boolean
  /** 降级原因（透传自候选）：作者值保护 / legacy 保护 / 本章 0 出场。 */
  reason?: string
}export interface ForeshadowingCommit {
  title: string
  status: string
}

export interface QualityCommit {
  weightedScore: number
  blockingCount: number
}

export interface ChapterCommitInput {
  chapterNumber: number
  draftId: number
  finalizationId: string
  contentHash: string
  facts: WritingFact[]
  characterStates: CharacterStateCommit[]
  foreshadowing: ForeshadowingCommit[]
  quality: QualityCommit
}

export interface DraftQualityReview extends EditorialPanelReview {
  draftId: number
  chapterNumber: number
  contentHash: string
  reviewedAt: string
}

export interface ChapterCommit extends ChapterCommitInput {
  commitId: string
  createdAt: string
}

/**
 * 已定稿但没有事实账本的一章（issue #125）。
 *
 * #62 修的是「定稿后处理报成功却没落库」（根因）；修复之前定稿的章节会**永远缺着**，
 * 而产品不会提示。实测那本 55 章的书里有 11 章缺账，其中 5 章连
 * `summary_snapshots` 都没有——那种章连「从当前投影重建」也补不出来
 * （`commitFinalizedChapter` 会抛 `CHAPTER_COMMIT_CONTINUITY_REQUIRED`）。
 *
 * 所以缺口必须**分档**报出来，不能一律说「可以重建」：
 * - `rebuildable`：有最终化快照 + 摘要快照 → 可无损补齐；
 * - `missing-summary`：有最终化快照但没有摘要快照 → 需要重新跑一次摘要，不能静默当成可补；
 * - `missing-finalization`：连最终化记录都没有 → 只能从当前投影重新生成。
 */
export interface ChapterCommitGap {
  chapterNumber: number
  draftId: number
  status: 'rebuildable' | 'missing-summary' | 'missing-finalization'
}

export interface CharacterVoiceProfileRecord extends CharacterVoiceProfile {
  sourceDraftId: number
  contentHash: string
  updatedAt: string
}
export interface UsageCostInput {
  promptTokens: number | null
  completionTokens: number | null
  inputPerMillion: number | null | undefined
  outputPerMillion: number | null | undefined
}

function parseJsonPayload(content: string): unknown {
  try {
    const extracted = extractSingleCompleteJsonObject(content, true)
    if (extracted !== null) {
      try { return JSON.parse(extracted) } catch { /* fall through to direct parse */ }
    }
  } catch { /* fall through to direct parse */ }
  const trimmed = content.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  try {
    return JSON.parse(trimmed)
  } catch (error) {
    // issue #245 现场：编辑部评审在运行侧页显示的是**裸的**
    // `SyntaxError: Expected ':' after property name in JSON at position 1102`。
    // 这是模型漏写键名（真库实测：把 `"role": "continuity",` 写成了 `"continuity",`）。
    //
    // 结构错误的详情要能被程序判定（重试/降级），而不是让 V8 的英文语法消息
    // 直接冒到作者的运行卡片里。这里统一收成领域错误码，并把解析位置留在消息里
    // 供日志定位——作者看到的是「模型返回的结构不完整」，而不是一句 JS 内部报错。
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`WRITING_INTELLIGENCE_JSON_INVALID:${detail}`)
  }
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`WRITING_INTELLIGENCE_TEXT_REQUIRED:${field}`)
  const normalized = value.trim()
  if (!normalized || normalized.length > max) throw new Error(`WRITING_INTELLIGENCE_TEXT_INVALID:${field}`)
  return normalized
}

function optionalText(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string' || value.trim().length > max) throw new Error(`WRITING_INTELLIGENCE_TEXT_INVALID:${field}`)
  return value.trim()
}

/**
 * 字符串列表字段的解析。
 *
 * **超上限时截断，不整份丢弃**（issue #67）：这些字段都是「多给几条更好」的形态
 * （evidence 引文、dialogueHabits、avoid、scenes.characters）。原来的实现在超限时
 * 直接 throw，于是模型给「周叙」写了 7 条引文（上限 5）就把**整份 4 个角色的声音
 * 档案**全部作废、一条不落库——作者等 40 秒、烧 1.3 万 prompt token，换回一行
 * 内部错误码，而且重试必然复现（输入没变，模型还会这么写）。
 *
 * 提示词里从来没有写过这个上限，模型无从知道；即使写了，让一次超限毁掉全部成果
 * 也是错的取舍。真正该硬拒的只有「一条都没有」（由各调用点自己判）。
 *
 * 超过 `maxLength` 的单条仍然抛错：那是单条内容畸形（例如把整段正文塞进来），
 * 不是「多写了几条」，截断它反而会产出半个引文。
 */
function stringList(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`WRITING_INTELLIGENCE_LIST_INVALID:${field}`)
  const withinLimit = value.slice(0, maxItems)
  const parsed = withinLimit.map((item, index) => text(item, `${field}[${index}]`, maxLength))
  if (value.length > maxItems) {
    // 不静默：调用方与日志能看到这次截断过多少条（便于把上限写进提示词）。
    console.warn(`[writing-intelligence] ${field}: ${value.length} items, truncated to ${maxItems}`)
  }
  return parsed
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`WRITING_INTELLIGENCE_INTEGER_INVALID:${field}`)
  return Number(value)
}

export function parseScenePlanResponse(content: string): SceneCard[] {
  const payload = parseJsonPayload(content)
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { scenes?: unknown }).scenes)
      ? (payload as { scenes: unknown[] }).scenes
      : null
  if (!rows || rows.length < 1 || rows.length > 12) throw new Error('WRITING_INTELLIGENCE_SCENES_INVALID')
  const seen = new Set<string>()
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`WRITING_INTELLIGENCE_SCENE_INVALID:${index}`)
    const value = row as Record<string, unknown>
    const id = value.id === undefined ? `scene-${index + 1}` : text(value.id, `scenes[${index}].id`, 80)
    if (seen.has(id)) throw new Error('WRITING_INTELLIGENCE_SCENE_ID_DUPLICATE')
    seen.add(id)
    const targetWords = value.targetWords === undefined || value.targetWords === null
      ? null
      : positiveInteger(value.targetWords, `scenes[${index}].targetWords`)
    return {
      id,
      title: text(value.title, `scenes[${index}].title`, 100),
      goal: text(value.goal, `scenes[${index}].goal`, 500),
      conflict: text(value.conflict, `scenes[${index}].conflict`, 500),
      turn: text(value.turn, `scenes[${index}].turn`, 500),
      outcome: text(value.outcome, `scenes[${index}].outcome`, 500),
      characters: stringList(value.characters, `scenes[${index}].characters`, 20, 80),
      targetWords,
      notes: optionalText(value.notes, `scenes[${index}].notes`, 1000),
    }
  })
}

export function parseEditorialPanelResponse(content: string): EditorialPanelReview {
  const payload = parseJsonPayload(content)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('WRITING_INTELLIGENCE_EDITORIAL_INVALID')
  const root = payload as Record<string, unknown>
  if (!Array.isArray(root.roles) || root.roles.length !== EDITORIAL_ROLES.length) throw new Error('WRITING_INTELLIGENCE_EDITORIAL_ROLES_REQUIRED')
  const roles: EditorialRoleScore[] = root.roles.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`WRITING_INTELLIGENCE_EDITORIAL_ROLE_INVALID:${index}`)
    const value = row as Record<string, unknown>
    const role = text(value.role, `roles[${index}].role`, 40) as EditorialRole
    if (!EDITORIAL_ROLES.includes(role)) throw new Error('WRITING_INTELLIGENCE_EDITORIAL_ROLE_UNKNOWN')
    if (typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < 0 || value.score > 100) {
      throw new Error('WRITING_INTELLIGENCE_EDITORIAL_SCORE_INVALID')
    }
    if (!Array.isArray(value.findings) || value.findings.length > 8) throw new Error('WRITING_INTELLIGENCE_EDITORIAL_FINDINGS_INVALID')
    const findings: EditorialFinding[] = value.findings.map((finding, findingIndex) => {
      if (!finding || typeof finding !== 'object' || Array.isArray(finding)) throw new Error('WRITING_INTELLIGENCE_EDITORIAL_FINDING_INVALID')
      const item = finding as Record<string, unknown>
      const severity = text(item.severity, `roles[${index}].findings[${findingIndex}].severity`, 20)
      if (!['blocking', 'warning', 'note'].includes(severity)) throw new Error('WRITING_INTELLIGENCE_EDITORIAL_SEVERITY_INVALID')
      return {
        severity: severity as EditorialFindingSeverity,
        description: text(item.description, `roles[${index}].findings[${findingIndex}].description`, 300),
        ...(item.evidence === undefined ? {} : { evidence: text(item.evidence, `roles[${index}].findings[${findingIndex}].evidence`, 240) }),
      }
    })
    return { role, score: Math.round(value.score * 100) / 100, summary: text(value.summary, `roles[${index}].summary`, 300), findings }
  })
  const unique = new Set(roles.map(item => item.role))
  if (unique.size !== EDITORIAL_ROLES.length || roles.some(item => !unique.has(item.role))) throw new Error('WRITING_INTELLIGENCE_EDITORIAL_ROLE_DUPLICATE')
  const weightedScore = Math.round(roles.reduce((sum, item) => sum + item.score * EDITORIAL_ROLE_WEIGHTS[item.role], 0) * 100) / 100
  const blockingCount = roles.reduce((sum, item) => sum + item.findings.filter(finding => finding.severity === 'blocking').length, 0)
  return {
    version: 1,
    roles,
    weightedScore,
    blockingCount,
    summary: text(root.summary, 'summary', 500),
  }
}

/** 归一化空白后判断引文是否真的出自正文（issue #67）。 */
function quoteFoundInProse(quote: string, sourceContent: string): boolean {
  if (sourceContent.includes(quote)) return true
  // 模型常把正文里的换行/多空格改写成单空格；归一化后仍能找到就算逐字证据。
  const collapse = (value: string) => value.replace(/\s+/gu, ' ').trim()
  return collapse(sourceContent).includes(collapse(quote))
}

/**
 * 角色声音档案解析（issue #67）。
 *
 * 旧实现有两处「一处不合规、整份作废」：`evidence` 超 5 条直接抛错（整批 4 个角色
 * 一起丢），以及「引文必须在正文里**恰好**出现一次」的强校验（出现两次就作废，
 * 而重复的引文同样是逐字证据）。实测作者等 40 秒、烧 1.3 万 prompt token，换回一行
 * 内部错误码，且重试必然复现。
 *
 * 现在的取舍：**能救的救，救不了的只丢那一个角色**。
 * - 引文逐条筛：不在正文里的去掉，保留可核对的那些；
 * - 一个角色连一条可核对引文都没有 → 跳过它（记 warn），其余照常；
 * - 全部角色都跳过才抛错——那时确实没有可保存的内容，需要作者看到原因。
 */
export function parseVoiceProfilesResponse(
  content: string,
  allowedCharacters: readonly { characterId: string; name: string }[],
  sourceContent: string,
): CharacterVoiceProfile[] {
  const payload = parseJsonPayload(content)
  const rows = payload && typeof payload === 'object' && !Array.isArray(payload) && Array.isArray((payload as { profiles?: unknown }).profiles)
    ? (payload as { profiles: unknown[] }).profiles
    : null
  if (!rows || rows.length < 1 || rows.length > 20) throw new Error('WRITING_INTELLIGENCE_VOICE_PROFILES_INVALID')
  const seen = new Set<string>()
  const profiles: CharacterVoiceProfile[] = []
  const skipped: string[] = []
  rows.forEach((row, index) => {
    try {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`WRITING_INTELLIGENCE_VOICE_INVALID:${index}`)
      const value = row as Record<string, unknown>
      const characterName = text(value.characterName, `profiles[${index}].characterName`, 100)
      const providedId = value.characterId === undefined ? '' : text(value.characterId, `profiles[${index}].characterId`, 120)
      const matches = allowedCharacters.filter(character => providedId ? character.characterId === providedId : character.name === characterName)
      if (matches.length !== 1 || matches[0]!.name !== characterName) throw new Error('WRITING_INTELLIGENCE_VOICE_CHARACTER_MISMATCH')
      const character = matches[0]!
      if (seen.has(character.characterId)) throw new Error('WRITING_INTELLIGENCE_VOICE_DUPLICATE')
      // 引文逐条筛：留下真的能在正文里找到的（归一化空白后比对，重复出现也算数）。
      const evidence = stringList(value.evidence, `profiles[${index}].evidence`, 5, 240)
        .filter(quote => quoteFoundInProse(quote, sourceContent))
      if (evidence.length === 0) throw new Error('WRITING_INTELLIGENCE_VOICE_EVIDENCE_INVALID')
      seen.add(character.characterId)
      profiles.push({
        characterId: character.characterId,
        characterName,
        summary: text(value.summary, `profiles[${index}].summary`, 300),
        sentenceStyle: text(value.sentenceStyle, `profiles[${index}].sentenceStyle`, 240),
        vocabulary: text(value.vocabulary, `profiles[${index}].vocabulary`, 240),
        dialogueHabits: stringList(value.dialogueHabits, `profiles[${index}].dialogueHabits`, 8, 160),
        emotionalTells: text(value.emotionalTells, `profiles[${index}].emotionalTells`, 240),
        avoid: stringList(value.avoid, `profiles[${index}].avoid`, 8, 160),
        evidence,
      })
    } catch (error) {
      // 单个角色不合规不再毁掉整批（issue #67）：记下原因，继续解析其余角色。
      skipped.push(`${String((error as Error)?.message ?? error)}`)
    }
  })
  if (skipped.length > 0) console.warn(`[writing-intelligence] voice profiles skipped: ${skipped.join(', ')}`)
  if (profiles.length === 0) throw new Error(`WRITING_INTELLIGENCE_VOICE_PROFILES_INVALID:${skipped.join('|') || 'no-profiles'}`)
  return profiles
}

function jsonSafeArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`WRITING_INTELLIGENCE_ARRAY_REQUIRED:${field}`)
  try { return JSON.parse(JSON.stringify(value)) as unknown[] } catch { throw new Error(`WRITING_INTELLIGENCE_JSON_INVALID:${field}`) }
}

export function validateChapterCommitInput(input: ChapterCommitInput): ChapterCommitInput {
  if (!input || typeof input !== 'object') throw new Error('WRITING_INTELLIGENCE_COMMIT_INVALID')
  positiveInteger(input.chapterNumber, 'chapterNumber')
  positiveInteger(input.draftId, 'draftId')
  const finalizationId = text(input.finalizationId, 'finalizationId', 200)
  if (!/^[a-f0-9]{64}$/iu.test(String(input.contentHash ?? ''))) throw new Error('WRITING_INTELLIGENCE_COMMIT_HASH_INVALID')
  const facts = jsonSafeArray(input.facts, 'facts') as WritingFact[]
  const characterStates = jsonSafeArray(input.characterStates, 'characterStates') as CharacterStateCommit[]
  const foreshadowing = jsonSafeArray(input.foreshadowing, 'foreshadowing') as ForeshadowingCommit[]
  if (facts.some((fact, index) => !fact || typeof fact !== 'object'
    || !text(fact.kind, `facts[${index}].kind`, 80)
    || !text(fact.statement, `facts[${index}].statement`, 600)
    || !text(fact.evidence, `facts[${index}].evidence`, 400))) throw new Error('WRITING_INTELLIGENCE_COMMIT_FACT_INVALID')
  if (characterStates.some((state, index) => !state || typeof state !== 'object'
    || !text(state.characterId, `characterStates[${index}].characterId`, 120)
    || !state.state || typeof state.state !== 'object' || Array.isArray(state.state))) throw new Error('WRITING_INTELLIGENCE_COMMIT_STATE_INVALID')
  if (foreshadowing.some((item, index) => !item || typeof item !== 'object'
    || !text(item.title, `foreshadowing[${index}].title`, 200)
    || !text(item.status, `foreshadowing[${index}].status`, 40))) throw new Error('WRITING_INTELLIGENCE_COMMIT_FORESHADOWING_INVALID')
  if (!input.quality || typeof input.quality !== 'object'
    || typeof input.quality.weightedScore !== 'number' || !Number.isFinite(input.quality.weightedScore)
    || input.quality.weightedScore < 0 || input.quality.weightedScore > 100
    || !Number.isSafeInteger(input.quality.blockingCount) || input.quality.blockingCount < 0) {
    throw new Error('WRITING_INTELLIGENCE_COMMIT_QUALITY_INVALID')
  }
  return structuredClone({ ...input, finalizationId, facts, characterStates, foreshadowing })
}

export function estimateUsageCost(input: UsageCostInput): number | null {
  if (input.promptTokens === null || input.completionTokens === null
    || input.inputPerMillion === null || input.inputPerMillion === undefined
    || input.outputPerMillion === null || input.outputPerMillion === undefined
    || !Number.isFinite(input.promptTokens) || !Number.isFinite(input.completionTokens)
    || !Number.isFinite(input.inputPerMillion) || !Number.isFinite(input.outputPerMillion)
    || input.promptTokens < 0 || input.completionTokens < 0
    || input.inputPerMillion < 0 || input.outputPerMillion < 0) return null
  return (input.promptTokens / 1_000_000) * input.inputPerMillion
    + (input.completionTokens / 1_000_000) * input.outputPerMillion
}