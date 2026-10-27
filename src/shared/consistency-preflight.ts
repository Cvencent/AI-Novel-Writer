import type { FinalizedContinuityProjection } from './finalized-continuity'

export interface ConsistencyExemption {
  stableFactKey: string
  reason: string
  revoked: boolean
}

export interface ConsistencyFinding {
  stableFactKey: string
  severity: 'warning'
  sourceChapter: number
  evidence: string
  issue: { zhCN: string; enUS: string }
  suggestion: { zhCN: string; enUS: string }
}

export interface ReviewLike {
  summary?: string
  items?: Array<Record<string, unknown>>
  [key: string]: unknown
}

export interface BlueprintForPreflight {
  chapterNumber: number
  title: string
  role: string
  purpose: string
  keyEvents: string
  characters: string[]
  suspenseHook: string
  costsAndTurns?: string
  foreshadowing?: string
  userGuidance: string
  notes: string
}

function normalizedKeyPart(value: string): string {
  return value.trim().replace(/\s+/gu, ' ')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function isExplicitTerminalSubject(statement: string, entity: string): boolean {
  const subject = escapeRegExp(entity)
  const divider = String.raw`[\s|:：,，、—-]*`
  const chinese = new RegExp(
    `${subject}${divider}(?:(?:已经|已|被确认(?:为)?|被证实(?:为)?)${divider})?(?:死亡|身亡|牺牲|去世)`,
    'u',
  )
  const english = new RegExp(
    String.raw`${subject}[\s|:,-]+(?:(?:is|was|has(?: been)?)\s+)?(?:dead|died|deceased)\b`,
    'iu',
  )
  return chinese.test(statement) || english.test(statement)
}

export function continuityStableFactKey(fact: {
  category: string
  sourceChapter: number
  entities: string[]
  statement: string
}): string {
  const identity = [
    fact.category,
    fact.sourceChapter,
    fact.entities.map(normalizedKeyPart).sort().join(','),
    normalizedKeyPart(fact.statement),
  ].join(':')
  let hash = 0xcbf29ce484222325n
  for (const character of identity) {
    hash ^= BigInt(character.codePointAt(0) ?? 0)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `fact:${hash.toString(16).padStart(16, '0')}`
}

/**
 * Low-cost, deterministic preflight. The first rule is intentionally narrow:
 * a structured terminal character state conflicts with scheduling that same
 * character to appear in the current blueprint.
 * Findings are evidence, never a writing prohibition.
 */
export function findBlueprintContinuityRisks(
  projections: readonly FinalizedContinuityProjection[],
  blueprint: BlueprintForPreflight,
  exemptions: readonly ConsistencyExemption[],
): ConsistencyFinding[] {
  const activeExemptions = new Set(
    exemptions.filter(exemption => !exemption.revoked).map(exemption => exemption.stableFactKey),
  )
  const characters = new Set(blueprint.characters.map(normalizedKeyPart))

  return projections.flatMap(projection => (
    projection.sourceStatus === 'current' ? (projection.facts ?? []) : []
  ).flatMap((fact) => {
    if (fact.category !== 'character-state') return []
    const stableFactKey = continuityStableFactKey(fact)
    if (activeExemptions.has(stableFactKey)) return []
    const subject = fact.entities
      .map(normalizedKeyPart)
      .find(entity => characters.has(entity) && isExplicitTerminalSubject(fact.statement, entity))
    if (!subject) return []
    return [{
      stableFactKey,
      severity: 'warning' as const,
      sourceChapter: fact.sourceChapter,
      evidence: fact.evidence,
      issue: {
        zhCN: `定稿正文绑定的派生索引提示“${subject}”处于死亡终态，但当前蓝图仍将其列为出场角色。请对照原文确认语义。`,
        enUS: `A derived index bound to finalized prose marks “${subject}” as dead, but the current blueprint still schedules the character to appear. Confirm the meaning against the prose.`,
      },
      suggestion: {
        zhCN: '调整蓝图，或说明这是回忆、幻象等刻意安排。',
        enUS: 'Adjust the blueprint, or record an intentional device such as a flashback or vision.',
      },
    }]
  }))
}

export interface CastContinuityFact {
  name: string
  role: string
  motivation?: string
}

export interface BlueprintContinuitySchedule {
  chapterNumber: number
  characters: readonly string[]
}

export interface NarrativeThreadContinuityRisk {
  title: string
  status: string
  dormantChapters: number
  overdue: boolean
  authorIntent?: string
}

export function findExpandedContinuityRisks(input: {
  currentChapter: number
  blueprints: readonly BlueprintContinuitySchedule[]
  cast: readonly CastContinuityFact[]
  threads: readonly NarrativeThreadContinuityRisk[]
}): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = []
  const seen = new Set<string>()
  const push = (finding: ConsistencyFinding) => {
    if (seen.has(finding.stableFactKey)) return
    seen.add(finding.stableFactKey)
    findings.push(finding)
  }
  const schedules = input.blueprints.filter(item => item.chapterNumber > 0 && item.chapterNumber <= input.currentChapter)
  for (const character of input.cast) {
    if (!['protagonist', 'antagonist'].includes(character.role)) continue
    const appearances = schedules
      .filter(item => item.characters.some(name => normalizedKeyPart(name) === normalizedKeyPart(character.name)))
      .map(item => item.chapterNumber)
      .sort((left, right) => left - right)
    const last = appearances.at(-1)
    if (last === undefined) {
      push({
        stableFactKey: `cast:never-appeared:${normalizedKeyPart(character.name)}`,
        severity: 'warning', sourceChapter: input.currentChapter, evidence: `${character.name} / ${character.role}`,
        issue: {
          zhCN: `主要角色“${character.name}”截至第${input.currentChapter}章仍未在任何蓝图或已发生章节中登场。请确认是否遗漏了主线人物。`,
          enUS: `Major character “${character.name}” has not appeared in any blueprint through chapter ${input.currentChapter}. Check whether a main-cast character is missing from the plan.`,
        },
        suggestion: {
          zhCN: '补一场有作用的登场，或调整角色定位；不要把主角/反派长期留在名单外。',
          enUS: 'Add a purposeful appearance or adjust the character role; do not leave a protagonist or antagonist off-page indefinitely.',
        },
      })
    } else if (input.currentChapter - last > 5) {
      push({
        stableFactKey: `cast:absent:${normalizedKeyPart(character.name)}:${last}:${input.currentChapter}`,
        severity: 'warning', sourceChapter: last, evidence: `${character.name} last scheduled in chapter ${last}`,
        issue: {
          zhCN: `主要角色“${character.name}”已连续 ${input.currentChapter - last} 章没有进入蓝图（上次第${last}章）。请确认支线是否被遗忘。`,
          enUS: `Major character “${character.name}” has been absent from the chapter plan for ${input.currentChapter - last} chapters (last: chapter ${last}). Check whether their thread was forgotten.`,
        },
        suggestion: {
          zhCN: '安排一次状态推进、远程影响或短暂登场，避免人物线断档。',
          enUS: 'Schedule a state advance, off-page consequence, or brief appearance so the character thread does not disappear.',
        },
      })
    }
    if (!normalizedKeyPart(character.motivation ?? '')) {
      push({
        stableFactKey: `cast:thin:${normalizedKeyPart(character.name)}`,
        severity: 'warning', sourceChapter: input.currentChapter, evidence: `${character.name} motivation is empty`,
        issue: {
          zhCN: `主要角色“${character.name}”没有填写动机。长期写作时模型容易把他工具化。`,
          enUS: `Major character “${character.name}” has no motivation. Long-form drafting will tend to use them as a plot tool.`,
        },
        suggestion: {
          zhCN: '补充一个可被场景检验的欲望、恐惧或底线。',
          enUS: 'Add a desire, fear, or boundary that scenes can test.',
        },
      })
    }
  }
  for (const thread of input.threads) {
    if (!['planned', 'planted', 'progressing'].includes(thread.status)) continue
    if (thread.overdue) {
      push({
        stableFactKey: `thread:overdue:${normalizedKeyPart(thread.title)}`,
        severity: 'warning', sourceChapter: input.currentChapter, evidence: thread.authorIntent || thread.title,
        issue: {
          zhCN: `叙事线索“${thread.title}”已逾期仍未解决。${thread.authorIntent ? `作者意图：${thread.authorIntent}` : ''}`,
          enUS: `Narrative thread “${thread.title}” is overdue and unresolved.${thread.authorIntent ? ` Author intent: ${thread.authorIntent}` : ''}`,
        },
        suggestion: {
          zhCN: '在本章或下一章安排推进/回收，或明确标记放弃。',
          enUS: 'Advance or resolve it in this or the next chapter, or explicitly abandon it.',
        },
      })
    } else if (thread.dormantChapters >= 3) {
      push({
        stableFactKey: `thread:dormant:${normalizedKeyPart(thread.title)}:${thread.dormantChapters}`,
        severity: 'warning', sourceChapter: input.currentChapter, evidence: thread.authorIntent || thread.title,
        issue: {
          zhCN: `叙事线索“${thread.title}”已停摆 ${thread.dormantChapters} 章，没有推进。`,
          enUS: `Narrative thread “${thread.title}” has been dormant for ${thread.dormantChapters} chapters.`,
        },
        suggestion: {
          zhCN: '给一个可定位的推进、误导或阶段回收，避免线索失温。',
          enUS: 'Add a locatable advance, misdirection, or partial payoff so the thread does not go cold.',
        },
      })
    }
  }
  return findings
}
export function mergeConsistencyFindingsIntoReview(
  review: ReviewLike,
  findings: readonly ConsistencyFinding[],
  locale: 'zh-CN' | 'en-US',
): ReviewLike & { items: Array<Record<string, unknown>> } {
  const mapped = findings.map(finding => ({
    category: locale === 'en-US' ? 'Deterministic continuity preflight' : '确定性一致性预检',
    severity: finding.severity,
    description: locale === 'en-US' ? finding.issue.enUS : finding.issue.zhCN,
    quote: finding.evidence,
    stableFactKey: finding.stableFactKey,
    sourceChapter: finding.sourceChapter,
  }))
  return { ...review, items: [...(Array.isArray(review.items) ? review.items : []), ...mapped] }
}
