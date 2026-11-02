import type { FinalizedContinuityProjection } from './finalized-continuity'
import { blueprintKeyEventsOversize } from './blueprint-length'
import { foreshadowingKeywords, type ForeshadowingCommitment } from './foreshadowing-commitments'
import { findAnnihilatedPropRevival, findRepeatPropTermination } from './prop-termination'
import { findRepeatedEntranceShots } from './entrance-shot'
import { findLossRestatement } from './loss-restatement'
import { findAbilityReuseContradictions } from './ability-budget'
import { findDeclaredDigitCountMismatches } from './numbering-consistency'
import {
  designSections,
  findTimelineAnchorConflicts,
  type TimelineSection,
} from './timeline-anchors'
import {
  chapterOpeningOf,
  findDialogueOpenerConvergence as findDialogueOpenerHits,
  openingConvergence,
} from './chapter-opening'
import {
  chapterEndingProfile,
  closingLabelConflicts,
  ultimatumStreak,
  type ChapterEndingProfile,
} from './chapter-ending'

export interface ConsistencyExemption {
  stableFactKey: string
  reason: string
  revoked: boolean
}

/**
 * 预检提醒的「我已知，稍后处理」（issue #79）。
 *
 * 与 `ConsistencyExemption` 分开：那条表示「这是我刻意这么写的」，
 * 这条只表示「我知道，回头再处理」——作者需要一个不污染「刻意安排」台账的口径。
 */
export interface ConsistencyAcknowledgement {
  stableFactKey: string
  acknowledgedAt: string
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
  /**
   * 蓝图里除 `characters` 之外会写人名的字段（keyEvents / purpose / costsAndTurns /
   * suspenseHook / foreshadowing），拼成一段文本（issue #74）。
   *
   * 出场判定必须同时看它：实测样本里叶九在**第 24、25、26、28 章的蓝图描述里都在**
   * （第 24、28 章还是情节支点），只是没被列进 `characters` 数组，于是一条
   * 「已连续 7 章没有进入蓝图」的假警报被报了出来——作者照着它去查，会发现
   * 人明明在。同一口径 #42/#58 已经用过（蓝图描述里出现的人名也是出场）。
   */
  descriptionText?: string
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
    const characterKey = normalizedKeyPart(character.name)
    const appearances = schedules
      // 数组里列了，或描述文本里写了，都算「进了蓝图」（issue #74）。
      // 只读数组会把「描述里有他、数组里没他」这种最常见的漏列报成「整章缺席」。
      .filter(item => item.characters.some(name => normalizedKeyPart(name) === characterKey)
        || normalizedKeyPart(item.descriptionText ?? '').includes(characterKey))
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
        // key **不能带当前章号**（issue #86）：否则它每章都变，作者点了「我已知，稍后处理」
        // （#79 的 ack）也只能静音当章，下一章又是一条新提醒 —— 实测那本书的反派
        // 「陆敬堂」从第 20 章起连报 6 章、谁也关不掉，于是这条**正确**的预警被训练成噪声。
        // 带 `last` 是对的：他一旦真的回来，`last` 变化 → key 变化 → 新的缺席才算新问题。
        stableFactKey: `cast:absent:${normalizedKeyPart(character.name)}:${last}`,
        severity: 'warning', sourceChapter: last, evidence: `${character.name} last scheduled in chapter ${last}`,
        issue: {
          zhCN: `主要角色“${character.name}”已连续 ${input.currentChapter - last} 章没有进入蓝图（上次第${last}章）。请确认支线是否被遗忘。`,
          enUS: `Major character “${character.name}” has been absent from the chapter plan for ${input.currentChapter - last} chapters (last: chapter ${last}). Check whether their thread was forgotten.`,
        },
        suggestion: {
          // 出路要给**两个都可执行**的分支（issue #86 的建议 1，与 #55/#69 同一教训：
          // 只说「确认是否被遗忘」等于没给动作——作者当时按了「带提醒继续写」就往下走了）。
          zhCN: `二选一：①让他回来——安排一次状态推进、远程影响或短暂登场；②他这条线就是收束了——在正文里写明他的退场及其原因（像样本第 18 章对配角邵德昌做的「搬去码头另一头养老，不再提查册的事」那样），别让读者以为作者忘了。两种情况都要落到正文，不要在预检弹层里点「继续」了事。`,
          enUS: `Pick one: (1) bring them back \u2014 schedule a state advance, an off-page consequence, or a brief appearance; (2) their thread really is closed \u2014 write the exit and its cause into the prose (as the sample book did for a supporting character in chapter 18: "moved to the other end of the docks to retire, and stopped bringing up the ledger"), so readers do not think the author forgot. Either way it must land on the page; do not just click "continue" on the preflight notice.`,
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

/**
 * 描述文字里「与在册角色仅一字之差」的名字（issue #58）。
 *
 * `stableFactKey` **不带章号**（issue #69）：原来带章号，于是同一个署名第二次出现时
 * 又报一次，作者又没有「已确认是同一人」的状态可以标记——一本书里只要出现一次
 * 花押/署名，后续每一章都会重复弹同一条，且无法消音。改成按「名字 + 疑似角色」
 * 记账：确认过一次之后全书静音。
 */
export function findNearCastNameFindings(input: NearCastInput): ConsistencyFinding[] {
  return findNearCastNames(input.descriptionText, input.castNames).map(({ name, near }) => ({
    stableFactKey: `blueprint-cast:near-name:${near}:${name}`,
    severity: 'warning' as const,
    sourceChapter: input.chapterNumber,
    evidence: `第${input.chapterNumber}章蓝图的事件描述里出现「${name}」，与在册角色「${near}」仅一字之差`,
    issue: {
      zhCN: `蓝图里出现了与在册角色「${near}」只差一个字的名字「${name}」，但角色名单里没有这个人、也没有声明这是「${near}」的另一种写法。读者无法判断这是同一人的花押/署名，还是另一个人；若之后把它当独立角色用，就会凭空长出一个从未建立的人物。`,
      enUS: `The blueprint names “${name}”, one character away from the cast member “${near}”, yet no one by that name is on the roster and nothing declares it a variant spelling of “${near}”. Readers cannot tell whether it is the same person, and using it later would create a character that was never established.`,
    },
    // 出路必须是产品里**真的存在**的动作（issue #69）：原来第一条写「在角色别名里加上」，
    // 而全仓没有任何加别名的入口（character_aliases 只在自己内部被写：建卡写自身 name、
    // 改名把旧名置为历史别名）。作者照着提示找不到按钮，只剩「带提醒继续写」，提示就等于噪音。
    suggestion: {
      zhCN: `二选一：确认是同一人，就在下方「说明为何属于刻意安排」里写下依据（例如「「${name}」是「${near}」在两章里的署名」）并点「保存安排」——这条提醒之后全书不再重复弹；确实是新角色，就在角色名单里为「${name}」建卡，并把本章标为他的首次出场。`,
      enUS: `Either confirm it is the same person by writing the reason below (for example, ““${name}” is ${near}’s signature in these chapters”) and choosing Save arrangement — that stops this reminder for the rest of the book — or treat it as a new character: add “${name}” to the roster and mark this chapter as their first appearance.`,
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

/**
 * 蓝图「冲突与转折」长成了准正文（issue #64）。
 *
 * 实测这本书写到 25 章后 keyEvents 从均值 253 字涨到 429 字，第 25 章 510 字，
 * 而同章正文只有 630 汉字（蓝图 = 正文的 81%）：里面已经排好台词与动作顺序，
 * 起草只剩扩写，「蓝图 → 正文」这一层就没了。
 *
 * 这里只做**可见性**，不改写、不拦稿：合同层明确「作者指定事件为权威、不得删除」，
 * 一条硬上限会推翻它，也会让事件确实很长的章反复被拒稿。作者看到计数后自己决定
 * 是精简还是保留（本样本后段章节普遍超标，作者很可能确实想要这么长）。
 */
export interface BlueprintKeyEventsLengthInput {
  chapterNumber: number
  keyEvents: string
  /** 本章正文目标字数（蓝图长度口径随它缩放）。 */
  targetWordsPerChapter: number
}

export function findOversizedBlueprintKeyEvents(input: BlueprintKeyEventsLengthInput): ConsistencyFinding[] {
  const oversize = blueprintKeyEventsOversize(input.keyEvents, input.targetWordsPerChapter)
  if (!oversize) return []
  const { units, budget } = oversize
  return [{
    stableFactKey: `blueprint:key-events-length:${input.chapterNumber}`,
    severity: 'warning' as const,
    sourceChapter: input.chapterNumber,
    evidence: `第${input.chapterNumber}章蓝图「冲突与转折」约 ${units} 字（口径：目标 ${budget.target} 字、上限 ${budget.max} 字）`,
    issue: {
      zhCN: `本章「冲突与转折」约 ${units} 字，已经超出蓝图该有的篇幅（目标约 ${budget.target} 字、上限 ${budget.max} 字）。蓝图是提纲，不是正文：写到这个长度通常意味着台词与动作顺序都被排好了，起草时只剩扩写——作者改蓝图等于改正文，两边一旦不一致也没有地方会提示。这段文本还会整段进入后续每次生成的上下文，成本逐章累积。`,
      enUS: `This chapter's “conflict and turn” runs about ${units} characters, well past what a blueprint should hold (target about ${budget.target}, ceiling ${budget.max}). A blueprint is an outline, not prose: at this length the dialogue and action order are usually already fixed, so drafting has nothing left to do — editing the blueprint becomes editing the chapter, and no check would tell you if the two drift apart. The whole passage also enters every later request, so the cost accumulates.`,
    },
    suggestion: {
      zhCN: `精简到「谁做了什么、结果如何、代价是什么」：删掉台词原文、动作顺序与感官细节，那些留给正文；同一件事被拆成好几笔的，合并成一笔。确实放不下就把这段留在正文里，不要在蓝图里预演整场戏。`,
      enUS: `Trim it to who acts, what the outcome is, and what it costs: drop transcribed dialogue, step-by-step action, and sensory detail — those belong to the prose. Merge repeated descriptions of the same event. If the material genuinely does not fit, leave it to the chapter rather than pre-staging the whole scene in the blueprint.`,
    },
  }]
}

/**
 * 蓝图自报的收束类型与正文最后一幕不符（issue #65）。
 *
 * #28 让每章在 keyEvents 末尾标「【收束：类型】」，下一章靠这些标签做「不得重复
 * 上一章落幅」。实测 10 章有 7 章不符（第 25 章标「物件落幅」而正文收在温珩的
 * 警告台词上），于是轮换约束建立在假信息上——标错还比不标更糟，因为它看起来可信。
 *
 * 只核对能可靠判定的三对：对话收束 ↔ 收在台词里、物件落幅/人物动作收束 ↔ 收在叙述里。
 * 「悬念直陈/内心独白/时空切换」不承诺收在台词还是叙述里，硬比一定产生假阳性。
 */
export interface ClosingLabelInput {
  chapterNumber: number
  /** 蓝图 keyEvents 里的收束标注（`closingShotOf` 的结果，未标注传空串）。 */
  label: string
  /** 本章定稿正文。 */
  content: string
}

export function findClosingLabelConflicts(input: readonly ClosingLabelInput[]): ConsistencyFinding[] {
  return input.flatMap(item => {
    if (!item.label.trim() || !item.content.trim()) return []
    const profile = chapterEndingProfile(item.chapterNumber, item.content)
    if (!closingLabelConflicts(item.label, profile)) return []
    const actual = profile.closesOnDialogue ? '收在台词里' : '收在叙述里'
    const actualEn = profile.closesOnDialogue ? 'closes inside a line of dialogue' : 'closes on narration'
    return [{
      stableFactKey: `chapter-ending:label-mismatch:${item.chapterNumber}`,
      severity: 'warning' as const,
      sourceChapter: item.chapterNumber,
      evidence: `第${item.chapterNumber}章蓝图标注「${item.label}」，而正文末句${actual}：${profile.lastSentence.slice(0, 60)}`,
      issue: {
        zhCN: `本章蓝图标注的收束方式是「${item.label}」，但正文最后一幕${actual}。这个标注不是给人看的装饰：下一章生成时会拿它做「不得重复上一章落幅」的判断（issue #28），标错等于把轮换约束建立在假信息上——看起来可信，反而比不标更难发现。`,
        enUS: `This chapter's blueprint declares the closing shot “${item.label}”, but the prose's final beat ${actualEn}. The label is not decoration: the next chapter uses it to avoid repeating the previous closing shot (issue #28), so a wrong label makes that constraint rest on false information — harder to notice than no label at all.`,
      },
      suggestion: {
        zhCN: `按正文实际落幅改标注（正文是权威）：收在台词里就写「对话收束」，收在叙述里就写「物件落幅」或「人物动作收束」。若正文本身想换一种收法，就改正文再改标注，别只改标注。`,
        enUS: `Correct the label to match the prose, which is authoritative: use “dialogue close” when it ends inside a line of speech, otherwise “object close” or “character-action close”. If you wanted a different ending, change the prose first and then the label — never just the label.`,
      },
    }]
  })
}

/**
 * 连续几章都以「通牒式台词」收尾（issue #66）。
 *
 * 与 #28 不是同一条：#28 管画面（同一个角色、同一个姿态），这条管**语用**——
 * 每章都有人用一句话把主角逼到一个二选一。本样本 25 章里末段含对白的 7 章有
 * 6 章是这种收法，且全在第 15 章之后：画面换了、人物换了、钩子文本也不重复，
 * 读者关掉这一章时听到的还是同一个声音。
 */
export interface ChapterEndingStreakInput {
  /** 最近几章的定稿正文（升序或任意顺序，本函数会排序）。 */
  chapters: ReadonlyArray<{ chapterNumber: number; content: string }>
  /** findings 的 sourceChapter 用（通常是当前章）。 */
  currentChapter: number
}

export function findUltimatumStreak(input: ChapterEndingStreakInput): ConsistencyFinding[] {
  const profiles: ChapterEndingProfile[] = input.chapters
    .filter(item => item.content.trim())
    .map(item => chapterEndingProfile(item.chapterNumber, item.content))
  const streak = ultimatumStreak(profiles)
  if (streak.length === 0) return []
  const ranges = `${streak[0]!.chapterNumber}–${streak[streak.length - 1]!.chapterNumber}`
  const sample = streak.slice(-2).map(item => `第${item.chapterNumber}章「${item.lastSentence.slice(0, 40)}」`).join('、')
  return [{
    stableFactKey: `chapter-ending:ultimatum-streak:${streak[streak.length - 1]!.chapterNumber}`,
    severity: 'warning' as const,
    sourceChapter: streak[streak.length - 1]!.chapterNumber,
    evidence: `第 ${ranges} 章连续 ${streak.length} 章都以条件/警告式台词收尾；末两章：${sample}`,
    issue: {
      zhCN: `连续 ${streak.length} 章（第 ${ranges} 章）都以一句「二选一/警告/条件」的台词收尾。画面换了、人物换了、钩子文本也不重复，但读者关掉每一章时听到的是同一个声音——悬念被形式化，压迫感反而变钝。这种收法还会改人物形象：本来靠沉默与动作表态的角色，反复开口撂狠话。`,
      enUS: `${streak.length} chapters in a row (chapters ${ranges}) end on a conditional or threatening line. The setting, the speaker, and the hook text all change, yet every chapter closes on the same voice — which formalises the suspense and blunts it. It also distorts characterisation: someone established as terse and physical starts delivering ultimatums.`,
    },
    suggestion: {
      zhCN: `换一种收法。可用的落幅：物件/动作收尾（把态度写在动作里）、留白（停在未说出口的话上）、切到另一条线、把决定留到下一章开头再生效。若这一章确实需要一句狠话，至少让它不是末句——后面再落一笔别的。`,
      enUS: `Close differently: end on an object or an action that carries the attitude, leave a beat unsaid, cut to another thread, or let the decision land at the start of the next chapter. If this chapter truly needs the hard line, at least do not make it the final sentence — land something else after it.`,
    },
  }]
}

/**
 * 早先承诺的伏笔在本章没有落地（issue #68）。
 *
 * 蓝图 `foreshadowing` 里写明「留待第 15 章揭开」之后，原来没有任何环节回头核对
 * 第 15 章到底写没写（26 章实测 4 条远期承诺 3 条在目标章 0 命中）。判据刻意做得窄：
 * 只问「本章正文里能不能检索到这条承诺的任一实体词」，命中一个就算落地——
 * 目的是把「完全没提」的那几条捞出来，不是判断兑现得好不好。
 */
export interface ForeshadowingDueCheck {
  chapterNumber: number
  /** 本章定稿/起草正文。 */
  content: string
  /** 指向本章的承诺。 */
  commitments: readonly ForeshadowingCommitment[]
}

export function findUndeliveredForeshadowing(input: ForeshadowingDueCheck): ConsistencyFinding[] {
  if (!input.content.trim()) return []
  return input.commitments.flatMap(commitment => {
    const keywords = foreshadowingKeywords(commitment.text)
    // 抽不出检索词就不判：词都抽不出来，说明这段文本不是可核对的承诺。
    if (keywords.length === 0) return []
    if (keywords.some(keyword => input.content.includes(keyword))) return []
    return [{
      stableFactKey: `foreshadowing:undelivered:${commitment.plantsAt}:${input.chapterNumber}`,
      severity: 'warning' as const,
      sourceChapter: input.chapterNumber,
      evidence: `第 ${commitment.plantsAt} 章承诺「${commitment.text.slice(0, 60)}」，第 ${input.chapterNumber} 章正文里检索不到 ${keywords.join('、')}`,
      issue: {
        zhCN: `第 ${commitment.plantsAt} 章的蓝图写下「留待第 ${input.chapterNumber} 章」的伏笔，但本章正文里找不到与它相关的任何实体（${keywords.join('、')}）。读者记着的是没兑现的那一个：承诺过的扣子被别的东西顶替，比一开始就不埋更伤。`,
        enUS: `Chapter ${commitment.plantsAt}'s blueprint promised to pay this off in chapter ${input.chapterNumber}, but the prose contains none of the promise's anchors (${keywords.join(', ')}). Readers remember the thread that never paid off; a promise replaced by something else is worse than no promise at all.`,
      },
      suggestion: {
        zhCN: `二选一：在本章补上这件事（哪怕只是一句带过，也要让人能检索到）；或者把这条伏笔明确降级——回第 ${commitment.plantsAt} 章的蓝图里改写它，说明已经由别的方式了结。不要两头都不动。`,
        enUS: `Either realize it in this chapter (a single clause that makes it findable is enough), or explicitly retire it: edit chapter ${commitment.plantsAt}'s blueprint to say the matter was settled another way. Do not leave both ends untouched.`,
      },
    }]
  })
}

/**
 * 章首句式收敛（issue #71）。
 *
 * 前几轮补的是章末（#28/#65/#66）与正文内部（#32/#33/#49），**章首这一轴一直是空的**。
 * 实测样本 28 章有 19 章以「时间/地点状语 + 主句」开篇，句式一次没变；而产品里
 * 唯一的章首检测（`chapter-shape.ts`）只认 4 条词表模式，这 28 章一个都没认出来，
 * 而且只在生成细纲时打一行日志——正文写作阶段没有任何环节看章首。
 *
 * 判据是结构性的：第一个小句里没有在册角色、也不以人称代词起头，就算场景起手。
 * 不枚举「天蒙蒙亮 / 靠埠前」这类词，换一本书仍然成立。
 */
export interface ChapterOpeningStreakInput {
  /** 最近的定稿正文（含本章），升序或任意顺序。 */
  chapters: ReadonlyArray<{ chapterNumber: number; content: string }>
  castNames: readonly string[]
  /** findings 的 sourceChapter 用（通常是当前章）。 */
  currentChapter: number
}

export function findOpeningShapeConvergence(input: ChapterOpeningStreakInput): ConsistencyFinding[] {
  const openings = input.chapters
    .map(chapter => chapterOpeningOf(chapter.chapterNumber, chapter.content, input.castNames))
  const window = openingConvergence(openings)
  if (window.length === 0) return []
  const range = `${window[0]!.chapterNumber}–${window[window.length - 1]!.chapterNumber}`
  const samples = window.slice(0, 3).map(item => `第${item.chapterNumber}章「${item.clause}」`).join('、')
  return [{
    stableFactKey: `chapter-opening:scene-first:${window[window.length - 1]!.chapterNumber}`,
    severity: 'warning' as const,
    // 证据落在**已定稿的那几章**里，不是正在写的这一章（issue #79）：
    // 写成 currentChapter 会让每条提醒都以「来源：第 N 章」开头，看起来像本章的问题，
    // 而实际上章号集合全在 6–12 章之前。
    sourceChapter: window[window.length - 1]!.chapterNumber,
    evidence: `第 ${range} 章连续 ${window.length} 章都以「时间/地点状语 + 主句」起手：${samples}`,
    issue: {
      zhCN: `最近 ${window.length} 章（第 ${range} 章）的**开篇句**是同一个句式：先给时间或地点状语，主句在后。开篇句是读者每章第一眼看到的东西——连着十几章这样开场，正文还没读进去就先感到腻，连载里这种地方最容易掉收藏。这几章的场景其实各不相同，缺的只是句式轮换。`,
      enUS: `${window.length} chapters in a row (chapters ${range}) open with the same construction: a time or place adverbial first, the main clause after. The opening line is the first thing a reader sees in every chapter; a dozen chapters of the same opening wears thin before the prose even starts. These chapters already use different settings — only the sentence shape is repeating.`,
    },
    suggestion: {
      zhCN: `换一种开篇：直接以动作或对白切入（「跳板还没落稳，周叙就拎着风灯下了船」）、以人物的判断或疑问起手、从一个正在发生的细节冷开场（一件物、一个声音、一句没头没尾的话），或从上一章的余波接进来。不必每章都先交代时间地点——读者能从上下文推出来。`,
      enUS: `Open differently: cut straight into an action or a line of dialogue, start with a character's judgement or question, cold-open on one concrete detail (an object, a sound, a fragment of speech), or pick up the previous chapter's aftermath. Not every chapter needs its time and place established first — readers infer it.`,
    },
  }]
}

/**
 * 同一线索的揭示句式在多章重复（issue #72）。
 *
 * 样本：隐藏主线的每一次推进都用「你爸当年也……」+ 立刻收口，5 章同一句式、
 * 后半句各不相同。`prose-repetition.ts` 的词表只有动作类（没动/没答/蘸水），
 * 审稿的「跨章重复」维度只抓逐字复写，都对这一族 0 命中。
 *
 * 判据同样是结构性的：按对白第一小句的前几字归组，取组内的**最长公共前缀**。
 * 换亲属称谓、换线索，前缀会自己长成新的起手语，不需要改代码。
 */
export function findDialogueOpenerConvergence(input: ChapterOpeningStreakInput): ConsistencyFinding[] {
  const hits = findDialogueOpenerHits(input.chapters)
  if (hits.length === 0) return []
  const [widest] = hits
  return [{
    stableFactKey: `chapter-opening:dialogue-opener:${widest!.opener}`,
    severity: 'warning' as const,
    // 证据章号集合才是读者要去看的地方（issue #79）。
    sourceChapter: widest!.chapters[widest!.chapters.length - 1]!,
    evidence: `第 ${widest!.chapters.join('、')} 章的对白都以「${widest!.opener}」起手（共 ${widest!.chapters.length} 章）；另有 ${Math.max(0, hits.length - 1)} 组同类起手语`,
    issue: {
      zhCN: `有 ${widest!.chapters.length} 章的长辈/对手开口第一句都是「${widest!.opener}……」，后半句各不相同。同一条线索的每一次推进都用同一个动作「抛半句 + 收口」时，读者记不住哪一章知道了什么，只记得「又一次有人提了一句」。线索本身的信息增量被句式替代了。`,
      enUS: `In ${widest!.chapters.length} chapters, the elder or the antagonist opens with the same words — “${widest!.opener}” — with a different tail each time. When every advance of a thread uses the same move (drop half a sentence, then withdraw), readers stop tracking what they learned where and only remember that someone hinted again. The sentence shape replaces the actual information gain.`,
    },
    suggestion: {
      zhCN: `换投放方式：让线索从物证、行动或第三方的反应里露出来（一页账、一个没说出口的动作、别人对他的态度变了），而不是又由同一个长辈开口；也可以让这次把话说完——信息一次给足，比第五次抛半句更有推进力。若确实要保持「说不下去」的感觉，换个场合或换个说话人，别让「长辈开口 = 你爸当年也」成为读者的预判。`,
      enUS: `Deliver the thread a different way: let it surface through an object, an action, or a third party's reaction (a ledger page, an unfinished gesture, a change in how others treat him) rather than the same elder speaking. Or let them finish the sentence this time — one complete revelation advances more than a fifth half-sentence. If the unable-to-say-it beat matters, change the setting or the speaker so that “an elder speaks = another 你爸当年也” does not become the reader's expectation.`,
    },
  }]
}

/**
 * 设定层时间锚点冲突（issue #2）。
 *
 * 实测样本：同一套「故事前提 / 世界观 / 角色图谱」里「父亲落水」既在十年前
 * （前提、周叙角色卡）又在二十年前（说温珩二十年不换那件「父亲落水那夜穿走的」
 * 靛蓝短褂）。三处生成件全部踩中，说明没有任何机制去固定这条时间锚。
 *
 * 危急之处在于它发生在**架构阶段**——正是后续蓝图、正文、角色状态抽取的输入，
 * 会顺着链路往下传；而现有检查只抓「角色外貌/身体状态」这类可枚举属性。
 *
 * 判据是结构性的：同一条名词片段被配上两个不同的时间量。不枚举事件词，
 * 换一本书仍成立。只比**设定层**三段（前提/世界观/角色图谱）——正文里的
 * 「十年前那晚」是回指，混进来只会制造假阳性。
 */
export interface DesignTimelineInput {
  premise: string
  worldbuilding: string
  charactersArch: string
  /** findings 的 sourceChapter 用；架构阶段没有章号，按 1 记账。 */
  chapterNumber?: number
}

export function findDesignTimelineConflicts(input: DesignTimelineInput): ConsistencyFinding[] {
  const sections: TimelineSection[] = designSections(input)
  const conflicts = findTimelineAnchorConflicts(sections)
  const chapter = input.chapterNumber ?? 1
  return conflicts.slice(0, 3).map(conflict => {
    const [low, high] = [conflict.durations[0]!, conflict.durations[conflict.durations.length - 1]!]
    const samples = conflict.durations.join(' / ')
    return {
      stableFactKey: `timeline:design-anchor:${conflict.anchors.join('|')}`,
      severity: 'warning' as const,
      sourceChapter: chapter,
      evidence: `设定层里「${conflict.anchors.join('、')}」被配了两个时间：${samples} 年（出现在「${conflict.sources.join('」「')}」）`,
      issue: {
        zhCN: `同一条设定被写成了两个时间：${conflict.anchors.join('、')}一带在设定里同时是 ${low} 年和 ${high} 年（${conflict.sources.join('、')}）。同一件事不可能既过去 ${low} 年又过去 ${high} 年。设定崩塌是长篇读者最早弃书的理由，而且它发生在架构阶段——会顺着蓝图、正文、角色状态抽取一路传下去，改一处要牵动全部已写章节。`,
        enUS: `One fact is dated twice: the ${conflict.anchors.join(', ')} passage is both ${low} and ${high} years ago across ${conflict.sources.join(', ')}. The same event cannot be both ${low} and ${high} years in the past. Setting contradictions are the earliest reason long-form readers drop a book, and this one sits in the architecture stage — it propagates into blueprints, prose, and character-state extraction, so fixing it later touches every written chapter.`,
      },
      suggestion: {
        zhCN: `先定一个权威年份，再让另外两处服从它：锚是「${conflict.anchors[0]}」。若想让两处都成立，就必须把它们拆成两件事（例如「落水」是 ${low} 年前，而那件短褂在此之前已被穿了 ${high} 年），并把这句话明确写进设定，而不是让读者自己圆。`,
        enUS: `Pick one authoritative date and make the other passages defer to it; the anchor is “${conflict.anchors[0]}”. If both must hold, split them into two distinct facts (for example: the drowning was ${low} years ago, and the garment had already been worn for ${high} years before that) and say so explicitly instead of leaving readers to reconcile it.`,
      },
    }
  })
}

/**
 * 角色名单里的角色没有出现在「人物群像」里（issue #3）。
 *
 * 实测样本：角色名单 6 人，但架构生成的「人物群像」（characters_arch）只有 4 个条目——
 * 少掉的是**两个反派**（沈砚、陆秉文）。这两个人是整条冲突链的施压方，卡片其实齐的
 * （有外貌、有定位），却只在别人的「关系」行里被提一句。
 *
 * 用户在原 issue 里的原话点出了要害：「三处对不上——名单有、卡片有、群像没有」。
 * 群像才是作者在架构阶段真正会读、会改的那份文档。
 *
 * 判据是**按角色的名单完整性**，不解析群像的 Markdown 结构：
 * 对每个在册角色，问「群像里有没有以他名字为主语的独立段落」。
 * 只要名字在群像里出现过，就算有（不要求它在 `##` 标题里——作者可能写成
 * 「## 反派：沈砚」或「## 沈砚」，两种都要算数）。
 *
 * 只报**实质缺人**：名字在群像里完全找不到才算缺。带 `role` 时把定位写进证据，
 * 让作者知道缺的是主角还是反派——本样本缺的正是两位 antagonist。
 */
export interface MissingCastInArchInput {
  charactersArch: string
  cast: ReadonlyArray<{ name: string; role?: string }>
  /** findings 的 sourceChapter 用；架构阶段没有章号，按 1 记账。 */
  chapterNumber?: number
}

/** 群像里是否出现过这个名字（去空白后包含即可，不要求是标题）。 */
function archMentionsCast(charactersArch: string, name: string): boolean {
  const normalized = normalizedKeyPart(castDisplayName(name))
  if (!normalized) return false
  const haystack = normalizedKeyPart(charactersArch)
  return haystack.includes(normalized)
}

export function findMissingCastInArch(input: MissingCastInArchInput): ConsistencyFinding[] {
  const arch = String(input.charactersArch ?? '')
  // 群像为空时整份文档都还没写，报「每个人都缺」没有意义：
  // 那是「还没生成」而不是「漏了人」。交给架构生成自己的流程。
  if (!arch.trim()) return []
  const chapter = input.chapterNumber ?? 1
  const seen = new Set<string>()
  return input.cast.flatMap(entry => {
    const name = castDisplayName(entry.name)
    const key = normalizedKeyPart(name)
    if (!name || !key || seen.has(key)) return []
    seen.add(key)
    if (archMentionsCast(arch, name)) return []
    const role = String(entry.role ?? '').trim()
    return [{
      stableFactKey: `architecture:cast-missing-in-arch:${key}`,
      severity: 'warning' as const,
      sourceChapter: chapter,
      evidence: `角色名单里有${role ? `「${name}」（${role}）` : `「${name}」`}，但「人物群像」里找不到这个名字`,
      issue: {
        zhCN: `角色名单里有${role ? `「${name}」（${role}）` : `「${name}」`}，但架构生成的「人物群像」里没有这个人的条目。名单有、卡片有可能、群像没有——而群像才是作者在架构阶段真正会读会改的那份。缺一个施压方（反派）尤其要命：他在正文里没有动机、没有口癖、没有行为锚点，每章只能临场发挥，跨章漂移与一致性检查的盲区都由此而来。`,
        enUS: `“${name}”${role ? ` (${role})` : ''} is on the character roster but has no entry in the generated character group portrait — the document authors actually read and edit at the architecture stage. Missing an antagonist is the worst case: without motivation, speech habits, or behavioural anchors, they are improvised in every chapter, which is where cross-chapter drift and consistency blind spots come from.`,
      },
      suggestion: {
        zhCN: `在「人物群像」里为「${name}」补一段（哪怕三五行：他要什么、他挡在谁前面、他说话的调子）。他已经在正文或关系行里出现过的话，照已写的内容回填，不要另起一套设定。`,
        enUS: `Add a paragraph for “${name}” to the character group portrait — three to five lines is enough: what they want, whom they block, how they talk. If they already appear in the prose or in a relationship line, backfill from what was written instead of inventing a new version.`,
      },
    }]
  }).slice(0, 6)
}

/**
 * 同一件物证被终结两次（issue #73）。
 *
 * 实测样本：主线唯一的物证「三个结」在第 27 章被「一个一个解开」，
 * 第 29 章又「露出底下压死的三个结」再剪一遍，两次都被写成同一件事的后果。
 *
 * 蓝图层的【同章道具不得自相矛盾】（#19）只管**同一章内**，跨章的
 * 「已经没了的东西又被取出」从来没人看。这里补上。
 *
 * 判据是结构性的：对同一个名词，问它是否在**不同的章**里各自被一个终结动作处理过。
 * 不枚举剧情，换一件物证照样成立。
 */
export interface RepeatPropTerminationInput {
  chapters: ReadonlyArray<{ chapterNumber: number; content: string }>
  /** findings 的 sourceChapter 用（通常是当前章）。 */
  currentChapter: number
}

export function findRepeatPropTerminationFindings(input: RepeatPropTerminationInput): ConsistencyFinding[] {
  return findRepeatPropTermination(input.chapters).map(hit => ({
    stableFactKey: `prop:repeat-termination:${hit.prop}`,
    severity: 'warning' as const,
    sourceChapter: hit.chapters[hit.chapters.length - 1]!,
    evidence: `「${hit.prop}」在第 ${hit.chapters.join('、')} 章各被处理掉一次：${hit.excerpts[0]?.slice(0, 50) ?? ''}`,
    issue: {
      zhCN: `同一件物证「${hit.prop}」在第 ${hit.chapters.join('、')} 章各被终结过一次（毁掉／交出／收走）。已经没了的东西在后面的章里又被取出来处理一遍，读者读到的是同一件事被做了两次——而且这两次通常还各自被写成同一件后果的因，等于那件后果也废了。`,
      enUS: `The same prop “${hit.prop}” is disposed of once in each of chapters ${hit.chapters.join(', ')} (destroyed, handed over, or taken away). Something already gone cannot be produced and disposed of again; readers see the same beat happen twice, and both are usually written as the cause of the same consequence — which voids that consequence too.`,
    },
    suggestion: {
      zhCN: `二选一：把后一次改成**仍旧不存在**的写法（它已经不在了，这一章该处理的是「找不到」或「缺少它」的后果），或者说明它中间是怎么回来的（谁还回来、付出什么代价）。别让同一件东西被处理两遍。`,
      enUS: `Either make the later chapter reflect that it is gone (its absence is the thing to dramatize), or show explicitly how it came back — who returned it, at what price. Do not let one object be disposed of twice.`,
    },
  }))
}

/**
 * 同一笔遗忘被跨章重新宣告（issue #75）。
 *
 * 金手指代价是「每溯读一次，墨吞掉一段记忆」，而同一笔缺失被跨章宣告三遍，
 * 每次都当新损失写——代价因此变成可重复计价。蓝图合同的「代价必须留账」（#36）
 * 只管章内，`prose-repetition` 的词表是动作词，都对遗忘句 0 命中。
 *
 * 判据结构性：找「记得 + 缺失」同处出现的句子，再取不同章缺失句里的**公共子串**
 * 作为「同一件东西」。#75 的关键是**没有承接词**——带「仍然没想起来」的章不算重述。
 */
export interface LossRestatementInput {
  chapters: ReadonlyArray<{ chapterNumber: number; content: string }>
  /** findings 的 sourceChapter 用（通常是当前章）。 */
  currentChapter: number
}

export function findLossRestatementFindings(input: LossRestatementInput): ConsistencyFinding[] {
  return findLossRestatement(input.chapters).map(hit => ({
    stableFactKey: `continuity:loss-restatement:${hit.referent}`,
    severity: 'warning' as const,
    sourceChapter: hit.chapters[hit.chapters.length - 1]!,
    evidence: `「${hit.referent}」的缺失在第 ${hit.chapters.join('、')} 章各被当新损失宣告一次：${hit.excerpt.slice(0, 50)}`,
    issue: {
      zhCN: `同一笔记忆缺失（「${hit.referent}」）在第 ${hit.chapters.join('、')} 章各被宣告了一次，每次读起来都像刚发生的损失。金手指的代价是这本书张力的来源，同一笔被反复宣告，读者学到的是「这个代价可以重复计价」——后面再写「他又忘了一件事」就没有分量了。`,
      enUS: `The same memory loss (“${hit.referent}”) is announced once in each of chapters ${hit.chapters.join(', ')}, each time reading like a fresh loss. When a power's cost is repeatedly re-charged for the same thing, readers learn that the cost is repeatable — and later "he forgot something again" beats land with no weight.`,
    },
    suggestion: {
      zhCN: `后续章再提这件事时，要么写成**延续**（带上「仍然没想起来」「还是空的」这类承接词，读者读到的是他一直没想起来），要么写成**新的获取尝试**（再溯读一次、求人提醒、换个法子查）并把这次尝试的代价落账。不要每次都用「他记得 X，Y 空着」重新宣告一遍。`,
      enUS: `When later chapters revisit this, write it as **continuation** (use carry-over wording such as “still has not remembered”), or as a **new attempt to recover it** (re-reading, asking someone, another route) and record that attempt's cost. Do not re-announce it each time with “he remembers X, but Y is blank”.`,
    },
  }))
}

/**
 * 已被写死的物证又自己回来了（issue #78）。
 *
 * 实测样本：主角唯一的溯读工具「空白票根」在第 21 章被写碎、第 22 章正文自己承认
 * 「票根昨夜泡碎了，他读不了」，第 23–27 章对它的下落一个字都没有，
 * 第 28、30 章又「从怀里摸出空白票根」压上去读——没有任何取得动作。
 *
 * 与 #73 互补：那条管「同一件东西被终结两次」，这条管「只有一次终结、但后面自行复活」。
 */
export interface PropRevivalInput {
  chapters: ReadonlyArray<{ chapterNumber: number; content: string }>
  /** findings 的 sourceChapter 用（通常是当前章）。 */
  currentChapter: number
  /**
   * 在册角色名（issue #80）：人不是道具。不传时抽取器会把主角名当成
   * 「被写没了又复活」的物证（真实书稿上 4/4 假阳性，其中 1 条是主角名）。
   */
  castNames?: readonly string[]
}

export function findPropRevivalFindings(input: PropRevivalInput): ConsistencyFinding[] {
  return findAnnihilatedPropRevival(input.chapters, { castNames: input.castNames }).map(hit => ({
    stableFactKey: `prop:revival:${hit.prop}`,
    severity: 'warning' as const,
    sourceChapter: hit.appearedAt[hit.appearedAt.length - 1]!,
    evidence: `「${hit.prop}」在第 ${hit.annihilatedAt} 章被写没了（${hit.annihilationExcerpt.slice(0, 40)}），`
      + `第 ${hit.appearedAt.join('、')} 章又以可取用形态出现（${hit.appearanceExcerpt.slice(0, 40)}），中间没有重新获得的动作`,
    issue: {
      zhCN: `物证「${hit.prop}」在第 ${hit.annihilatedAt} 章被不可逆地写没了，第 ${hit.appearedAt.join('、')} 章又直接拿出来用，中间没有任何「重新获得」的动作（新领、向谁讨一张、用什么代价换回来）。读者记得住「它没了」这件事——尤其当作者用一整段甚至一个独立短句把它写死的时候——后面又见它回到怀里，是长篇里最容易让人弃书的那类矛盾。`,
      enUS: `The prop “${hit.prop}” was irreversibly destroyed in chapter ${hit.annihilatedAt} and is used again in chapter ${hit.appearedAt.join(', ')} with no acquisition step in between (no new one, no asking someone, no price paid). Readers remember that it was gone — especially when the text made a point of it — and seeing it back in hand is the kind of contradiction that makes people drop a long serial.`,
    },
    suggestion: {
      zhCN: `二选一：写出它怎么回来的（谁给的、用什么换的、剩下的一角），并把这次取得写成正文动作；或者改后面的章——它已经不在了，那几章该处理的是**缺少它**的后果（用什么替代、因此失去了什么）。`,
      enUS: `Either show how it came back (who provided it, what was traded, a surviving fragment) as an on-page action, or rewrite the later chapters: it is gone, so what those chapters should dramatise is the consequence of not having it.`,
    },
  }))
}

/**
 * 人物登场句的跨章同构（issue #81）。
 *
 * 「同一套写法」的三组检测分别只看**章首**（#71/#72）、**章末**（#65/#66）、
 * **正文核心戏**（#32/#33），而人物「怎么登场」那一段落在章中间——三组都看不到。
 * 实测样本温珩出场 30 章，11 章的首次出现段直接带同一套穿戴，其中两对是逐字复写
 * （22 字、13 字）。登场句是每场戏的开机键，同构比收尾收敛更伤。
 *
 * 判据**无词表**（本仓在 #30/#43/#70/#80 反复吃过词表过拟合的亏）：不比「有哪些穿戴词」，
 * 而是问同一角色的登场段在不同章里字面有多像——去标点后取最长公共子串。
 */
export interface EntranceShotInput {
  chapters: ReadonlyArray<{ chapterNumber: number; content: string }>
  castNames: readonly string[]
  /** findings 的 sourceChapter 用（通常是当前章）。 */
  currentChapter: number
}

export function findEntranceShotFindings(input: EntranceShotInput): ConsistencyFinding[] {
  return findRepeatedEntranceShots(input.chapters, { castNames: input.castNames }).map(hit => ({
    stableFactKey: `entrance:repeat:${hit.character}`,
    severity: 'warning' as const,
    // 证据落在**最后命中那一章**（issue #79 的口径：不写成正在写的章）。
    sourceChapter: hit.chapters[hit.chapters.length - 1]!,
    evidence: `「${hit.character}」在第 ${hit.chapters.join('、')} 章的登场段逐字重合 ${hit.commonSubstring.length} 字：「${hit.commonSubstring.slice(0, 40)}」`,
    issue: {
      zhCN: `「${hit.character}」在第 ${hit.chapters.join('、')} 章的登场段几乎逐字相同（去标点后重合 ${hit.commonSubstring.length} 字：「${hit.commonSubstring.slice(0, 30)}」）。人物登场是读者每章重建画面的锚点，同一个角色几十章里都用同一句「站在某处、穿着某样」交代，画面就不再提供信息，读者会跳过这一段。它比章末收敛更伤——收尾每章只出现一次，登场句是**每场戏的开机键**。`,
      enUS: `“${hit.character}” enters almost word for word the same way in chapters ${hit.chapters.join(', ')} (${hit.commonSubstring.length} identical characters after stripping punctuation). An entrance is how readers rebuild the scene each chapter; the same line about standing somewhere in the same clothes stops carrying information and gets skipped. It hurts more than a repeated closing shot — the entrance is the start button of every scene.`,
    },
    suggestion: {
      zhCN: `换这次登场要交代的东西：他累不累、衣服干没干、手里拿着什么、跟谁站在一起、是先出声还是先动手。**同一个角色连续几章的首次出现不得用同一套姿态＋穿戴交代**。样本里已有一章写成「肩上搭着那件洗白的短褂」，说明换得动——被换掉的十几个字正是本可以写信息的地方。`,
      enUS: `Change what the entrance tells us: whether they are tired, whether the clothes are dry, what is in their hands, who they stand beside, whether they speak or act first. A character's first appearance must not repeat the same posture-plus-clothing formula in adjacent chapters. One chapter in the sample already manages it — the freed-up words are exactly where new information could go.`,
    },
  }))
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

// --- 以下三项由审稿路径移到 shared（issue #83）：写前预检与审稿共用同一份实现 ---

/**
 * 能力／资源上限的自相矛盾 → 一致性发现（issue #51）。
 *
 * 只报能直接机器判的那一类：**同一章内先声明资源用尽、随后又成功使用**。
 * 跨章的「还剩几次」需要一个结构化消耗账字段（本轮未做，见 issue 评论）。
 */
export function abilityBudgetFindings(chapter: { chapterNumber: number; content: string }): ConsistencyFinding[] {
  return findAbilityReuseContradictions(chapter.content).map(contradiction => ({
    stableFactKey: `ability-budget:reuse:${chapter.chapterNumber}:${contradiction.index}`,
    severity: 'warning' as const,
    sourceChapter: chapter.chapterNumber,
    evidence: `第${chapter.chapterNumber}章：「${contradiction.declaration}」→ 随后「${contradiction.reuse}」`,
    issue: {
      zhCN: `能力的上限被自己作废了：这里刚声明资源已经用尽（「${contradiction.declaration.slice(0, 40)}…」），紧接着又成功用了一次。读者据此会认为这套限制不作数，前面的取舍也就不成立。`,
      enUS: `A stated limit is voided inside the same passage: the text declares the resource exhausted, then the ability succeeds again a few lines later. Readers conclude the constraint does not hold, which voids every earlier trade-off built on it.`,
    },
    suggestion: {
      zhCN: '三选一：把用尽声明挪到这次使用之后；写出恢复条件（换班次、补水、换物件）并说明为什么这次还能读；或删掉这次使用。别让两句留在同一段里自相抵消。',
      enUS: 'Pick one: move the exhaustion statement after this use; write the recovery condition (new shift, refill, another object) and why this read is still possible; or drop this use. Do not leave both claims in the same passage canceling each other.',
    },
  }))
}

/**
 * 跨章「断言反转」→ 一致性发现（issue #52）。
 *
 * 真实事故：第 16 章正文断定「笔压没抖一下……叶九的手」，第 19 章正文又断定「不是叶九的手」，
 * 而第 19 章整章推理（「温珩的名字是被添上去的」）立在后一句上。定稿后本章只读，
 * 这类冲突只能靠后面的章节打补丁，越补越绕——所以要在写这一章时就摆出来。
 *
 * 判据刻意窄（见 findCrossChapterAssertionReversals 的注释）：短语必须含在册角色名、
 * 逐字相同、且方向是「前章断言 → 本章否定」。这是证据提示，不是禁止条款。
 */
export function assertionReversalFindings(
  earlier: ReadonlyArray<{ chapterNumber: number; content: string }>,
  current: { chapterNumber: number; content: string },
  castNames: readonly string[],
): ConsistencyFinding[] {
  if (!castNames.length) return []
  return findCrossChapterAssertionReversals({
    castNames,
    earlier: earlier.map(item => ({ chapterNumber: item.chapterNumber, text: item.content, label: '正文' })),
    current: { chapterNumber: current.chapterNumber, text: current.content },
  })
}

/**
 * 贯穿性编号的自相矛盾 → 一致性发现（issue #47）。
 *
 * 只报能直接机器判的一类：**声明 N 位、紧随其后的编号不是 N 位**。
 * 真实事故里第 16 章标称「编号五位」却只写出四位（零三一七），
 * 而那一章的推理链正架在这个编号上。
 *
 * 刻意不做的：比较全书编号「形式是否一致」。编号是开放集合，
 * 「丁段一四」与「零三一七」是否同一体系，字符层判不出来（#20 的教训）。
 */
export function numberingFindings(chapter: { chapterNumber: number; content: string }): ConsistencyFinding[] {
  return findDeclaredDigitCountMismatches(chapter.content).map(mismatch => ({
    stableFactKey: `numbering:digits:${chapter.chapterNumber}:${mismatch.index}`,
    severity: 'warning' as const,
    sourceChapter: chapter.chapterNumber,
    evidence: `第${chapter.chapterNumber}章：「${mismatch.evidence}」——声明 ${mismatch.declaredDigits} 位，实际写出 ${mismatch.actualDigits} 位`,
    issue: {
      zhCN: `编号的位数自相矛盾：这里声明「${mismatch.declaredDigits} 位」，紧随其后的编号却是 ${mismatch.actualDigits} 位。读者对账时无法判断这串数字属于哪一套编码。`,
      enUS: `The stated digit count contradicts the number itself: this line declares ${mismatch.declaredDigits} digits, but the number that follows has ${mismatch.actualDigits}. Readers cannot tell which code system the number belongs to.`,
    },
    suggestion: {
      zhCN: `二者改成一致：要么把声明改成 ${mismatch.actualDigits} 位，要么把编号补/删到 ${mismatch.declaredDigits} 位。若多处编号写法不同，建议在设定层先定一处权威编码规则（位数、是否带段号）。`,
      enUS: `Make the two agree: either state ${mismatch.actualDigits} digits, or adjust the number to ${mismatch.declaredDigits} digits. If several forms are in use, define one authoritative code rule (digit count, prefix scheme) in the settings first.`,
    },
  }))
}
