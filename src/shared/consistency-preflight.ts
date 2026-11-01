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

/** 只读类比对：细纲本章与蓝图角色名单是否互相覆盖（issue #27）。 */
export interface SynopsisChapterCastInput {
  chapterNumber: number
  /** 本章细纲正文（全书细纲的按章投影）。 */
  synopsisChunk: string
  /** 本章蓝图 role 名单。 */
  blueprintCharacters: readonly string[]
  /** characters 表里的在册角色名（retired=0）。 */
  castNames: readonly string[]
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

/** 细纲的出场人物行；「场景与出场人物」是章节契约的固定小节名。 */
const SCENE_ROSTER_LINE = /^\s*\*{0,2}\s*(?:场景与出场人物|出场人物)\s*\*{0,2}\s*[:：]\s*(.+)$/u

/** 去掉「身份·姓名」里的身份前缀（issue #27：细纲写「补网匠·陶有根」，蓝图写「陶有根」）。 */
function castDisplayName(raw: string): string {
  const token = raw.replace(/[。.!！?？；;]+$/u, '').trim()
  const separator = Math.max(token.lastIndexOf('·'), token.lastIndexOf('・'))
  return separator >= 0 ? token.slice(separator + 1).trim() : token
}

/** 解析细纲「场景与出场人物」行里的具名角色；场景/舱口这类非人名条目由调用方按名单过滤。 */
export function synopsisSceneCharacters(synopsisChunk: string): string[] {
  const names = new Set<string>()
  for (const line of synopsisChunk.replace(/\r\n?/gu, '\n').split('\n')) {
    const match = SCENE_ROSTER_LINE.exec(line)
    if (!match) continue
    for (const raw of match[1]!.split(/[、，,；;。．.！!？?／/]/u)) {
      const name = castDisplayName(raw)
      if (name.length >= 2) names.add(name)
    }
  }
  return [...names]
}

/**
 * 细纲本章 ↔ 蓝图角色名单的双向差集（issue #27）。
 *
 * 真实事故：细纲第 1、2 章整章写「补网匠·陶有根失踪」，蓝图却把「陈阿水」排进
 * 第 1 章角色、正文照着蓝图写，陶有根全书 0 出场。两种形态都是「静默换人」，
 * 起草前必须让模型和作者看见：
 * - 细纲点名/多处在写、名单里也在册、蓝图却没排 → 蓝图漏人，不得换成别人；
 * - 蓝图排了、细纲本章整段都没写 → 警惕顶替细纲点名的角色。
 * 只认在册角色（characters 表），场景、舱口这类非人名条目自然落选。
 * 每章最多 4 条，避免提示挤占起草上下文。
 */
export function findSynopsisCastMismatches(input: SynopsisChapterCastInput): ConsistencyFinding[] {
  const cast = new Set(input.castNames.map(name => normalizedKeyPart(castDisplayName(name))))
  const chunk = input.synopsisChunk.replace(/\r\n?/gu, '\n')
  const blueprint = new Map(input.blueprintCharacters.map(name => [normalizedKeyPart(castDisplayName(name)), name]))
  const findings: ConsistencyFinding[] = []
  const seen = new Set<string>()
  const push = (finding: ConsistencyFinding) => {
    if (seen.has(finding.stableFactKey)) return
    seen.add(finding.stableFactKey)
    findings.push(finding)
  }

  const sceneNames = synopsisSceneCharacters(chunk)
  const sceneKeys = new Set(sceneNames.map(name => normalizedKeyPart(name)))
  for (const raw of input.castNames) {
    const name = castDisplayName(raw)
    const key = normalizedKeyPart(name)
    if (!name || !key || blueprint.has(key)) continue
    const occurrences = chunk.split(name).length - 1
    if (occurrences === 0) continue
    // 出场人物行点名，或正文至少两处在写：视为本章的实质角色，而非顺带提及。
    if (!sceneKeys.has(key) && occurrences < 2) continue
    push({
      stableFactKey: `synopsis-cast:missing:${input.chapterNumber}:${key}`,
      severity: 'warning',
      sourceChapter: input.chapterNumber,
      evidence: `细纲第${input.chapterNumber}章写到「${name}」（${occurrences} 处）；蓝图角色：${input.blueprintCharacters.join('、') || '（空）'}`,
      issue: {
        zhCN: `细纲第${input.chapterNumber}章写到「${name}」，但本章蓝图角色名单里没有该角色。起草时不要把这条线换成别的角色。`,
        enUS: `The chapter ${input.chapterNumber} synopsis involves “${name}”, but the chapter blueprint does not schedule that character. Do not reassign this thread to a different character while drafting.`,
      },
      suggestion: {
        zhCN: `确认「${name}」是否出场：出场就补进蓝图角色并落实其动作与后果；只是前情提及时，请在蓝图注明，别让模型用其他角色顶替。`,
        enUS: `Confirm whether “${name}” appears: add them to the blueprint cast and realize their action if they do; if this is only a back-reference, say so in the blueprint instead of letting another character stand in.`,
      },
    })
  }

  for (const [key, raw] of blueprint) {
    const name = castDisplayName(raw)
    if (!cast.has(key) || !name || chunk.includes(name)) continue
    push({
      stableFactKey: `synopsis-cast:unplanned:${input.chapterNumber}:${key}`,
      severity: 'warning',
      sourceChapter: input.chapterNumber,
      evidence: `蓝图第${input.chapterNumber}章角色「${name}」在本章细纲中未出现`,
      issue: {
        zhCN: `本章蓝图把「${name}」列为出场角色，但本章细纲从头到尾没有提到他。起草时不要用他来顶替细纲点名的角色。`,
        enUS: `The blueprint schedules “${name}”, but this chapter's synopsis never mentions them. Do not let them stand in for a character the synopsis does name.`,
      },
      suggestion: {
        zhCN: '核对蓝图角色名单与细纲是否一致；要换角色就先改细纲，不要只改蓝图。',
        enUS: 'Reconcile the blueprint cast with the synopsis; change the synopsis before changing the cast.',
      },
    })
  }

  return findings.slice(0, 4)
}
/**
 * 蓝图角色名单里**不在角色卡名册**的具名角色（issue #42）。
 *
 * 真实事故：第 11 章蓝图与正文一致地引入「任九」（4 次出场、3 句台词，承担本章关键对话），
 * 但 characters 表里没有这个人。后果不是「龙套没建档」这么轻：定稿后的角色状态回写以
 * characters 行为锚点，没卡就没处写；一致性检查器只按名册取角色，他永远在检查盲区；
 * 下一章起草时「上一章谁跟他说过什么」对他是空白，只能临时发挥。
 *
 * 这里只做**可见性**（作者写前就能看到），不自动建卡：自动生成的卡会带着凭空捏造的身份
 * 与定位进入后续所有提示词，那比缺卡更糟。
 */
export interface UnregisteredCastInput {
  chapterNumber: number
  blueprintCharacters: readonly string[]
  /** characters 表里的在册角色名（retired=0）。 */
  castNames: readonly string[]
}

export function findUnregisteredBlueprintCast(input: UnregisteredCastInput): ConsistencyFinding[] {
  const cast = new Set(input.castNames.map(name => normalizedKeyPart(castDisplayName(name))))
  const findings: ConsistencyFinding[] = []
  for (const raw of input.blueprintCharacters) {
    const name = castDisplayName(raw)
    const key = normalizedKeyPart(name)
    if (!name || !key || cast.has(key)) continue
    findings.push({
      stableFactKey: `blueprint-cast:unregistered:${input.chapterNumber}:${key}`,
      severity: 'warning',
      sourceChapter: input.chapterNumber,
      evidence: `第${input.chapterNumber}章蓝图角色「${name}」不在角色卡名册（${input.castNames.join('、') || '空'}）`,
      issue: {
        zhCN: `本章蓝图把「${name}」列为出场角色，但角色卡里没有这个人：定稿后不会为他回写状态，一致性检查也覆盖不到他，下一章起草时对他的记忆是空白。`,
        enUS: `This chapter's blueprint casts “${name}”, who has no character card. No state will be written for them after finalization, consistency checks skip them, and the next chapter starts with no memory of them.`,
      },
      suggestion: {
        zhCN: `要保留这个角色，就在「角色名单」里为「${name}」建卡（姓名 + 定位即可），并把本章标为他的首次出场；只当一次性路人时，请把蓝图与正文里的名字换成无名的身份称呼（如「账房伙计」）。`,
        enUS: `To keep them, add “${name}” to the character roster (name plus role) and mark this chapter as their first appearance. For a walk-on, replace the name in the blueprint and prose with a role label instead.`,
      },
    })
  }
  return findings.slice(0, 4)
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
