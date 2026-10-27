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
}

export interface ForeshadowingCommit {
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
  return JSON.parse(trimmed)
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

function stringList(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`WRITING_INTELLIGENCE_LIST_INVALID:${field}`)
  return value.map((item, index) => text(item, `${field}[${index}]`, maxLength))
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
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`WRITING_INTELLIGENCE_VOICE_INVALID:${index}`)
    const value = row as Record<string, unknown>
    const characterName = text(value.characterName, `profiles[${index}].characterName`, 100)
    const providedId = value.characterId === undefined ? '' : text(value.characterId, `profiles[${index}].characterId`, 120)
    const matches = allowedCharacters.filter(character => providedId ? character.characterId === providedId : character.name === characterName)
    if (matches.length !== 1 || matches[0]!.name !== characterName) throw new Error('WRITING_INTELLIGENCE_VOICE_CHARACTER_MISMATCH')
    const character = matches[0]!
    if (seen.has(character.characterId)) throw new Error('WRITING_INTELLIGENCE_VOICE_DUPLICATE')
    seen.add(character.characterId)
    const evidence = stringList(value.evidence, `profiles[${index}].evidence`, 5, 240)
    if (evidence.length === 0 || evidence.some(quote => sourceContent.split(quote).length !== 2)) {
      throw new Error('WRITING_INTELLIGENCE_VOICE_EVIDENCE_INVALID')
    }
    return {
      characterId: character.characterId,
      characterName,
      summary: text(value.summary, `profiles[${index}].summary`, 300),
      sentenceStyle: text(value.sentenceStyle, `profiles[${index}].sentenceStyle`, 240),
      vocabulary: text(value.vocabulary, `profiles[${index}].vocabulary`, 240),
      dialogueHabits: stringList(value.dialogueHabits, `profiles[${index}].dialogueHabits`, 8, 160),
      emotionalTells: text(value.emotionalTells, `profiles[${index}].emotionalTells`, 240),
      avoid: stringList(value.avoid, `profiles[${index}].avoid`, 8, 160),
      evidence,
    }
  })
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