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
 * 跨章「断言反转」（issue #52）：同一个短语先在某一章被断定为真，
 * 后面某章又被明确否定——「是叶九的手」→「不是叶九的手」，整章推理架在后一句上。
 *
 * 判据刻意做**窄**：
 * - 短语取「是/正是/就是」后面 2–8 个非标点字符，且**必须含在册角色名**——
 *   把「是不是他」「不是钱的事」这类日常否定挡在外面（#20 的教训：宽词法判据在中文里
 *   会把「同一件事换个说法」当成矛盾，最终只能整案回滚）；
 * - 只在**蓝图与正文**上比对，不在全书写法之间做语义推断：同短语逐字出现才算。
 * 这是证据提示，不是禁止条款：作者可以据此确认反转是否有依据（复核/豁免走既有机制）。
 */
const ASSERTION_PHRASE = /(?:是|正是|就是)([^，。！？；：、\s“”「」]{2,8})/gu
const NEGATED_ASSERTION_PHRASE = /(?:不是|并非|不像是|不像)([^，。！？；：、\s“”「」]{2,8})/gu

/** 取一段文本里「被断定为真的短语」（含在册角色名的才留）。 */
export function blueprintAssertionPhrases(text: string, castNames: readonly string[]): string[] {
  const phrases: string[] = []
  for (const match of String(text ?? '').matchAll(ASSERTION_PHRASE)) {
    const phrase = match[1]!
    if (!castNames.some(name => name && phrase.includes(name))) continue
    phrases.push(phrase)
  }
  return [...new Set(phrases)]
}

/** 取一段文本里被明确否定的短语（同样只留在册角色相关的）。 */
export function negatedAssertionPhrases(text: string, castNames: readonly string[]): string[] {
  const phrases: string[] = []
  for (const match of String(text ?? '').matchAll(NEGATED_ASSERTION_PHRASE)) {
    const phrase = match[1]!
    if (!castNames.some(name => name && phrase.includes(name))) continue
    phrases.push(phrase)
  }
  return [...new Set(phrases)]
}

export interface CrossChapterAssertionInput {
  /** 已定稿（或已生成）的前序章节，按章号升序。 */
  earlier: ReadonlyArray<{ chapterNumber: number; text: string; label?: string }>
  /** 当前章要检查的文本。 */
  current: { chapterNumber: number; text: string }
  castNames: readonly string[]
}

export function findCrossChapterAssertionReversals(input: CrossChapterAssertionInput): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = []
  const negatedHere = negatedAssertionPhrases(input.current.text, input.castNames)
  if (!negatedHere.length) return findings
  for (const earlier of input.earlier) {
    const asserted = blueprintAssertionPhrases(earlier.text, input.castNames)
    for (const phrase of asserted) {
      if (!negatedHere.includes(phrase)) continue
      findings.push({
        stableFactKey: `assertion-reversal:${phrase}:${earlier.chapterNumber}:${input.current.chapterNumber}`,
        severity: 'warning',
        sourceChapter: input.current.chapterNumber,
        evidence: `第${earlier.chapterNumber}章${earlier.label ?? ''}：「是${phrase}」；第${input.current.chapterNumber}章：「不是${phrase}」`,
        issue: {
          zhCN: `同一件事的结论被反转了：第${earlier.chapterNumber}章断定为「是${phrase}」，本章又断定为「不是${phrase}」。若这是有依据的翻案，本章需要写出推翻前一次的核验过程；否则读者会以为是自己记错了。`,
          enUS: `A prior conclusion is reversed: chapter ${earlier.chapterNumber} asserted “${phrase}”, and this chapter asserts it is not. If this is an earned reversal, show the check that overturns the earlier reading; otherwise readers will think they misread.`,
        },
        suggestion: {
          zhCN: `二选一：把本章的否定改成与第${earlier.chapterNumber}章一致的结论，或在正文里写出「为什么上一次读错了」（新的证据、不同的对照物、当时看漏的条件）。反转必须由当章的动作或证据支撑。`,
          enUS: `Either align this chapter with chapter ${earlier.chapterNumber}, or show in the prose why the earlier reading was wrong (new evidence, a different reference, a condition missed then). A reversal must be carried by this chapter's action or evidence.`,
        },
      })
    }
  }
  return findings.slice(0, 4)
}

/**
 * 蓝图 keyEvents 等描述性文字里出现的「与在册角色仅一字之差」的名字（issue #58）。
 *
 * 真实事故：第 21 章蓝图在 key_events 里凭空写出「柯阅」，并当场解释成在册角色「柯明远」；
 * 正文照抄，整章探案结论（谁在封存前翻过账）都架在这两个汉字上。
 * #42 的「未登记角色」检查只看 `characters` 数组，**盖不到写在事件描述里的人名**：
 * 第 21 章的 characters 全是名册内的人，于是这条检查报 0。
 *
 * 判据刻意做窄（与 #20 的教训一致）：
 * - 只取 `「…」`／`“…”`／`『…』` 引号内的 **2–6 字纯汉字**词；
 * - 必须与**某个在册角色名首字相同**、且长度相同或相差 1、逐字比较**至多一处不同**；
 * - 命中的词本身**不在名册**、也不等于名册里任何名字。
 * 命中即给一条 warning，让作者决定「这是同一人的写法（去补别名）」还是「新角色（去建档）」。
 * 这是证据提示，不阻断生成，也不自动改蓝图。
 */
const QUOTED_NAME = /[「『“"]([一-龥]{2,6})[」』”"]/gu

export interface NearNameCandidate {
  /** 描述文字里出现的名字（如「柯阅」）。 */
  name: string
  /** 与之相近的在册角色名（如「柯明远」）。 */
  near: string
}

function nearDiffCount(left: string, right: string): number {
  if (left === right) return 0
  if (Math.abs(left.length - right.length) > 1) return Number.POSITIVE_INFINITY
  let edits = 0
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      i += 1
      j += 1
      continue
    }
    edits += 1
    if (edits > 1) return Number.POSITIVE_INFINITY
    if (left.length === right.length) {
      i += 1
      j += 1
    } else if (left.length > right.length) {
      i += 1
    } else {
      j += 1
    }
  }
  edits += (left.length - i) + (right.length - j)
  return edits
}

/**
 * 找出描述文字里「像是在册角色的另一种写法、却不在名册」的引号内名字。
 *
 * 两条**都窄**的判据（issue 给的建议是「编辑距离 ≤1 且首字相同」，但那一条其实抓不到
 * 它自己的样本：「柯阅」→「柯明远」要删一个字 + 换一个字，距离是 2）：
 *  ① 与某个在册名字首字相同、长度相同或相差 1、逐字比较至多一处不同（「柯明元」≈「柯明远」）；
 *  ② 姓氏与某个在册角色相同、且该姓氏在名册里**只出现过一次**，候选本身又不在名册
 *     （「柯阅」≈「柯明远」：全书只有一个姓柯的人，引号里又出现另一个姓柯的名字）。
 * 两条都要求候选是 2–3 个纯汉字且不在名册里，因此「三十三张」「靛蓝短褂」「底册」这类引号内名词不会命中。
 */
export function findNearCastNames(text: string, castNames: readonly string[]): NearNameCandidate[] {
  const names = castNames.map(name => castDisplayName(name)).filter(name => name.length >= 2)
  const exact = new Set(names)
  const surnameCounts = new Map<string, number>()
  for (const name of names) surnameCounts.set(name[0]!, (surnameCounts.get(name[0]!) ?? 0) + 1)
  const uniqueSurnameOwner = new Map<string, string>()
  for (const name of names) if (surnameCounts.get(name[0]!) === 1) uniqueSurnameOwner.set(name[0]!, name)

  const found = new Map<string, string>()
  for (const match of String(text ?? '').matchAll(QUOTED_NAME)) {
    const candidate = match[1]!
    if (!candidate || candidate.length > 3 || exact.has(candidate) || found.has(candidate)) continue
    for (const name of names) {
      if (candidate[0] !== name[0]) continue
      if (nearDiffCount(candidate, name) <= 1) {
        found.set(candidate, name)
        break
      }
      if (uniqueSurnameOwner.get(candidate[0]!) === name && name.length !== candidate.length) {
        found.set(candidate, name)
        break
      }
    }
  }
  return [...found].map(([name, near]) => ({ name, near }))
}

export interface NearCastInput {
  chapterNumber: number
  /** 蓝图里除 characters 之外会写人名的字段（keyEvents / purpose / foreshadowing / costsAndTurns…）。 */
  descriptionText: string
  castNames: readonly string[]
}

export function findNearCastNameFindings(input: NearCastInput): ConsistencyFinding[] {
  return findNearCastNames(input.descriptionText, input.castNames).map(({ name, near }) => ({
    stableFactKey: `blueprint-cast:near-name:${input.chapterNumber}:${name}`,
    severity: 'warning' as const,
    sourceChapter: input.chapterNumber,
    evidence: `第${input.chapterNumber}章蓝图的事件描述里出现「${name}」，与在册角色「${near}」仅一字之差`,
    issue: {
      zhCN: `蓝图里出现了与在册角色「${near}」只差一个字的名字「${name}」，但角色名单里没有这个人、也没有声明这是「${near}」的另一种写法。读者无法判断这是同一人的花押/署名，还是另一个人；若之后把它当独立角色用，就会凭空长出一个从未建立的人物。`,
      enUS: `The blueprint names “${name}”, one character away from the cast member “${near}”, yet no one by that name is on the roster and nothing declares it a variant spelling of “${near}”. Readers cannot tell whether it is the same person, and using it later would create a character that was never established.`,
    },
    suggestion: {
      zhCN: `二选一：确认是同一人，就在角色别名里给「${near}」加上「${name}」（并说明依据，例如署名/花押）；确实是新角色，就在角色名单里为「${name}」建卡，并把本章标为他的首次出场。`,
      enUS: `Either confirm it is the same person — add “${name}” as an alias of “${near}” with the reason (a signature, a seal) — or treat it as a new character: add “${name}” to the roster and mark this chapter as their first appearance.`,
    },
  }))
}

/**
 * 在册角色缺外貌锚点（issue #40）。
 *
 * 真实事故：AI 新建的「邵德昌」在第 8、9 章各有戏（茶棚谈判、带人堵舱口），
 * 但 `create_character` 只要求名字（其余字段后补），创建后没有任何一步回填，
 * 角色卡 `appearance` 一直为空。后果：
 * - 起草时每个角色的 `appearance` 都会进提示（`generate-draft` 的 characterProfiles），
 *   空值等于把这个角色交给模型每次即兴——同一配角两章之间长相漂移；
 * - 一致性检查只对有锚点的角色做跨章冲突判断，没锚点的角色永远漏过。
 *
 * 这里只做**可见性**（作者在名单/写前提示里看到“该补了”），不自动生成外貌：
 * 凭空捏造的外貌会进入后续所有提示词，且与作者心里的形象冲突——那比留空更难发现。
 */
export interface AppearanceGapInput {
  cast: ReadonlyArray<{ name: string; role?: string; appearance?: string }>
  /** 本章要写的章号（findings 的 sourceChapter 用）。 */
  chapterNumber: number
}

export function findAppearanceGaps(input: AppearanceGapInput): ConsistencyFinding[] {
  return input.cast
    .filter(entry => entry.name.trim() && !String(entry.appearance ?? '').trim())
    .map(entry => ({
      stableFactKey: `character:appearance-gap:${entry.name.trim()}`,
      severity: 'warning' as const,
      sourceChapter: input.chapterNumber,
      evidence: `角色「${entry.name.trim()}」的角色卡没有外貌字段`,
      issue: {
        zhCN: `角色卡「${entry.name.trim()}」没有外貌：写正文时没有可依据的固定锚点，每章的长相只能即兴，跨章漂移与一致性检查盲区都由此而来。`,
        enUS: `“${entry.name.trim()}” has no appearance on their card, so there is no fixed anchor when drafting; their looks are improvised per chapter, and consistency checks cannot cover them.`,
      },
      suggestion: {
        zhCN: `在「角色名单」里给「${entry.name.trim()}」补一段外貌（一两句即可：身形、惯常衣着、显眼标志），之后各章沿用；他已在正文出场时，可照已写过的描写回填，不要另起一套外形。`,
        enUS: `Add an appearance line for “${entry.name.trim()}” on the character roster (one or two sentences: build, usual clothing, a distinctive mark) and reuse it; if they already appeared, backfill from what the prose described instead of inventing a new look.`,
      },
    }))
    .slice(0, 6)
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
