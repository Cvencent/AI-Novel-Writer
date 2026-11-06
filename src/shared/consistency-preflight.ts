import type { FinalizedContinuityProjection } from './finalized-continuity'
import { blueprintKeyEventsOversize } from './blueprint-length'
import { foreshadowingKeywords, selectDiscriminatingKeywords, type ForeshadowingCommitment } from './foreshadowing-commitments'
import { findRepeatedEntranceShots } from './entrance-shot'
// 段落起手主语（issue #94）：与 #81 同族但读的是**每一段的第一个词**。
// 物件过手动作的固定化（issue #95）：折好→塞进某处 这一套三拍。
import { findAbilityReuseContradictions } from './ability-budget'
import { findDeclaredDigitCountMismatches } from './numbering-consistency'
// 自报「N 个字」与紧随其后的实体不符（issue #131）：与 #47 同族，另一个量词形态。
import { findDeclaredCharacterCountMismatches } from './declared-character-count'
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
  LANDING_MIN_HITS,
  chapterEndingProfile,
  closingLabelConflicts,
  pendingLandingConvergence,
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
  /**
   * 给作者看的可读标题（issue #120）。
   *
   * 存储层只有键与时间（`consistency_acknowledgements` 两列），所以标题由
   * `readConsistencyPreflight` 在内存里补：优先用「这一轮仍然命中的那条 finding」的原文，
   * 配不上时用封闭目录（`acknowledgement-title.ts`）译出人话并注明「已不再报出」。
   * 界面**不再**渲染 `stableFactKey` 本身。
   */
  title?: { zhCN: string; enUS: string }
}

export interface ConsistencyFinding {
  stableFactKey: string
  severity: 'warning'
  sourceChapter: number
  evidence: string
  issue: { zhCN: string; enUS: string }
  suggestion: { zhCN: string; enUS: string }
  /**
   * 这条提醒**能一键落库的动作**（issue #160）。
   *
   * 现场：预检文案写着「就在角色名单里为「徐汐」建卡（姓名 + 定位即可）」，可弹层里
   * 只有「保存安排 / 我已知」，`建卡` 两个字一次都点不到——文案指向一个动作，界面上却没有它。
   * 那条提醒于是从第 64 章一路重报到第 70 章，谁都没做成。
   *
   * ⚠️ 只放**机械可执行**的动作（这里只有「按这个名字建一张空卡」），不放需要判断的内容：
   * 卡的正文（身份、动机、外貌）仍然只能由作者或模型写。
   */
  action?: { kind: 'create-character'; name: string }
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
  /**
   * 该角色在**已定稿正文**里出现过的章数（issue #107）。
   *
   * 缺席监控原来只查 `role ∈ {protagonist, antagonist}`，而承担情感与秘密重量、
   * 甚至被设定层排了收束弧光的角色常常是 `supporting` —— 实测那本书在册七人之一、
   * 「隐藏主线的记忆载体」全叔被当众架走后**连续 15 章正文与蓝图 0 次**，
   * 而预检一次没报（消融：只把他的 role 改成 antagonist，同一份数据立刻报出）。
   *
   * 有了这个计数，纳入条件就可以从「role 白名单」改成「读者记住过他」——
   * 凡在已定稿正文里出场 ≥ `CAST_ABSENCE_MIN_PROSE_CHAPTERS` 章的角色都纳入。
   * 调用方从已定稿正文统计（与蓝图判定用的是同一份 `chapters` 数据）。
   */
  seenChapters?: number
}

/**
 * 角色缺席监控的阈值与分档（issue #107）。
 *
 * 原来的口径把「角色重要性」等同于「role 是不是 antagonist」，与实际写法脱节：
 * 反派全部被查、配角整类跳过。现在改成 two-part：
 *   - **纳入**：role 是主角/反派，**或**已定稿出场 ≥ `MONITORED_PROSE_CHAPTERS` 章；
 *   - **阈值分档**：主角/反派 > `ABSENT_CHAPTERS_MAIN` 章即报（与原来一致，不动既有口径）；
 *     配角/龙套要 > `ABSENT_CHAPTERS_SIDE` 章才报 —— 放宽是为了避免把配角变成
 *     「每章一条」的噪声（#30 的教训：噪声会让作者连新问题一起跳过）。
 */
export const MONITORED_PROSE_CHAPTERS = 5
export const ABSENT_CHAPTERS_MAIN = 5
export const ABSENT_CHAPTERS_SIDE = 8

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
    // 纳入条件（issue #107）：主角/反派一律查；配角/龙套只要在**已定稿正文**里
    // 出场够多（读者记住过他）也查——原来这里是 `['protagonist','antagonist'].includes()`
    // 硬白名单，于是「隐藏主线的记忆载体」全叔被架走后消失 15 章一次都没报。
    const isMainRole = character.role === 'protagonist' || character.role === 'antagonist'
    const seenChapters = Number.isSafeInteger(character.seenChapters) ? character.seenChapters! : 0
    if (!isMainRole && seenChapters < MONITORED_PROSE_CHAPTERS) continue
    // 阈值分档：配角放宽，避免把「本来就偶尔出场」的人变成每章一条的噪声。
    const absenceThreshold = isMainRole ? ABSENT_CHAPTERS_MAIN : ABSENT_CHAPTERS_SIDE
    const characterKey = normalizedKeyPart(character.name)
    const appearances = schedules
      // 数组里列了，或描述文本里写了，都算「进了蓝图」（issue #74）。
      // 只读数组会把「描述里有他、数组里没他」这种最常见的漏列报成「整章缺席」。
      .filter(item => item.characters.some(name => normalizedKeyPart(name) === characterKey)
        || normalizedKeyPart(item.descriptionText ?? '').includes(characterKey))
      .map(item => item.chapterNumber)
      .sort((left, right) => left - right)
    const last = appearances.at(-1)
    // 角色的中文/英文定位标签（issue #107）：文案原来一律写「主要角色」，而配角被纳入后
    // 这个词会让作者以为判据把配角当成了主角——按 role 取对应称谓。
    const roleLabelZh = ({ protagonist: '主角', antagonist: '反派', supporting: '配角', minor: '角色' } as Record<string, string>)[character.role] ?? '角色'
    const roleLabelEn = ({ protagonist: 'Protagonist', antagonist: 'Antagonist', supporting: 'Supporting character', minor: 'Character' } as Record<string, string>)[character.role] ?? 'Character'
    if (last === undefined) {
      push({
        stableFactKey: `cast:never-appeared:${normalizedKeyPart(character.name)}`,
        severity: 'warning', sourceChapter: input.currentChapter, evidence: `${character.name}（${roleLabelZh}）从未进入蓝图`,
        issue: {
          zhCN: `${roleLabelZh}“${character.name}”截至第${input.currentChapter}章仍未在任何蓝图或已发生章节中登场。请确认是否遗漏了这条人物线。`,
          enUS: `${roleLabelEn} “${character.name}” has not appeared in any blueprint through chapter ${input.currentChapter}. Check whether this character line is missing from the plan.`,
        },
        suggestion: {
          zhCN: '补一场有作用的登场，或调整角色定位；不要让在册人物长期留在名单外。',
          enUS: 'Add a purposeful appearance or adjust the character role; do not leave a listed character off-page indefinitely.',
        },
      })
    } else if (input.currentChapter - last > absenceThreshold) {
      push({
        // key **不能带当前章号**（issue #86）：否则它每章都变，作者点了「我已知，稍后处理」
        // （#79 的 ack）也只能静音当章，下一章又是一条新提醒 —— 实测那本书的反派
        // 「陆敬堂」从第 20 章起连报 6 章、谁也关不掉，于是这条**正确**的预警被训练成噪声。
        // 带 `last` 是对的：他一旦真的回来，`last` 变化 → key 变化 → 新的缺席才算新问题。
        stableFactKey: `cast:absent:${normalizedKeyPart(character.name)}:${last}`,
        severity: 'warning', sourceChapter: last, evidence: `${character.name} 上次进入蓝图：第 ${last} 章`,
        issue: {
          zhCN: `${roleLabelZh}“${character.name}”已连续 ${input.currentChapter - last} 章没有进入蓝图（上次第${last}章）。请确认这条人物线是否被遗忘。`,
          enUS: `${roleLabelEn} “${character.name}” has been absent from the chapter plan for ${input.currentChapter - last} chapters (last: chapter ${last}). Check whether their thread was forgotten.`,
        },
        suggestion: {
          // 出路要给**两个都可执行**的分支（issue #86 的建议 1，与 #55/#69 同一教训：
          // 只说「确认是否被遗忘」等于没给动作——作者当时按了「带提醒继续写」就往下走了）。
          zhCN: `二选一：①让他回来——安排一次状态推进、远程影响或短暂登场；②他这条线就是收束了——在正文里写明他的退场及其原因（例如写明他搬走了、调离了、或者不再管这件事），别让读者以为作者忘了。两种情况都要落到正文，不要在预检弹层里点「继续」了事。`,
          enUS: `Pick one: (1) bring them back \u2014 schedule a state advance, an off-page consequence, or a brief appearance; (2) their thread really is closed \u2014 write the exit and its cause into the prose (for example, say outright that they moved away, were reassigned, or stopped pursuing the matter), so readers do not think the author forgot. Either way it must land on the page; do not just click “continue” on the preflight notice.`,
        },
      })
    }
    // 「没填动机」只对主角/反派报（issue #107 的边界）：纳入范围放宽到配角后，
    // 若把这条也跟着放宽，AI 建卡时「只填名字」的配角会一次涌出一批动机提醒，
    // 而配角往往已在正文里立住（本条要求出场 ≥5 章）——那属于 #40 的卡片完整性，
    // 不是本条要救的「人物线断档」。保持原口径，避免把新纳入的配角变成噪声源。
    if (isMainRole && !normalizedKeyPart(character.motivation ?? '')) {
      push({
        stableFactKey: `cast:thin:${normalizedKeyPart(character.name)}`,
        severity: 'warning', sourceChapter: input.currentChapter, evidence: `${character.name} 的动机一栏是空的`,
        issue: {
          zhCN: `${roleLabelZh}“${character.name}”没有填写动机。长期写作时模型容易把他工具化。`,
          enUS: `${roleLabelEn} “${character.name}” has no motivation. Long-form drafting will tend to use them as a plot tool.`,
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
 *
 * ## issue #160：发现是自动的，补建却是跨页手动的，且逐章重报
 *
 * 现场那本书第 64 章起多了一个承重配角（8 章、32 次、9 段台词、一条主线伏笔的承重点），
 * 角色卡里始终没有她。三层其实**都知道了**：蓝图 6 章把她写进出场名单、这条判据 6 章各报
 * 一条、正文里她一直在说话——但**没有任何一层能把它变成一次写入**：
 *
 * - key 带章号 → 6 章 6 个 key，「我已知」只能逐条挂起，角色本身依旧不存在；
 * - 文案写着「就在角色名单里建卡」，而弹层里 `建卡` 两个字**一次都点不到**；
 * - 从第 64 章一路重报到第 70 章，没有任何一处告诉作者「这条一直没做」。
 *
 * 三处都改了：
 *   1. **按名字合并**，key 去掉章号（`blueprint-cast:unregistered:<名字>`）——同一个人
 *      全书只有一条提醒，ack/豁免也就只挂一个键（与 #86/#89/#98/#108 的键稳定性同一条规矩）；
 *   2. 判据自己带**动作**（`action.create-character`），界面据此给按钮，一键按名建卡；
 *   3. 算**承重程度**（进了几章蓝图、正文里有几段台词），承重的排在前面并写明
 *      「已经报了 N 章都没建」——轻的（只出现一章、没台词）仍走「换成身份称呼」那条路。
 *
 * ⚠️ 「承重」只数**结构量**（章数、引号内出现的次数），不判这个人重不重要——那是内容判断，
 * 归模型与作者。「有台词的台词」由引号这一**形式**标记界定，与 `quote-style.ts` 同一口径。
 */
export interface UnregisteredCastSchedule {
  chapterNumber: number
  characters: readonly string[]
}

export interface UnregisteredCastInput {
  /** 全部蓝图（每章一条）：同名角色跨章合并，不再按章重报。 */
  schedules: readonly UnregisteredCastSchedule[]
  /** characters 表里的在册角色名（retired=0）。 */
  castNames: readonly string[]
  /** 已定稿正文：只用来数「这个名字在几段引号台词里被说过」。 */
  prose?: readonly { chapterNumber: number; content: string }[]
}

/** 承重门槛：进 ≥3 章蓝图，或至少 2 段引号台词（issue #160 建议 ②）。 */
export const UNREGISTERED_CAST_HEAVY_CHAPTERS = 3
export const UNREGISTERED_CAST_HEAVY_DIALOGUE_LINES = 2

/** 引号对（形式类，与 `quote-style.ts` 同一族）：只用来数「这句是不是台词」。 */
const QUOTED_SPAN = /「[^」]*」|『[^』]*』|“[^”]*”|”[^”\n]*”/gu

/**
 * 这个名字牵涉几段引号台词（按段计数，不按字数）。
 *
 * 两处都算：**台词内容里出现她的名字**（「徐汐。徐哥是我哥。」）、
 * 以及**同一段里提名了她**（徐汐说：「有个人开口前……」→ 引号本身不含名字）。
 * 段落 = 一次说话的回合（正文按空行/换行分段），所以「同一段里几句引号」算她的几句。
 *
 * ⚠️ 这是**结构**判定（引号这一形式 + 同段共现），不判「这句是不是她说的」——
 * 那需要听语气，归模型。这里只用它量「这个人占了多少篇幅」，供承重/轻量分档。
 */
export function quotedLineCount(content: string, name: string): number {
  const source = String(content ?? '')
  if (!source.includes(name)) return 0
  let count = 0
  for (const paragraph of source.split(/\n+/u)) {
    if (!paragraph.includes(name)) continue
    count += [...paragraph.matchAll(QUOTED_SPAN)].length
  }
  return count
}

export function findUnregisteredBlueprintCast(input: UnregisteredCastInput): ConsistencyFinding[] {
  const cast = new Set(input.castNames.map(name => normalizedKeyPart(castDisplayName(name))))
  const byName = new Map<string, { name: string; chapters: number[] }>()
  for (const schedule of input.schedules) {
    if (!Number.isSafeInteger(schedule.chapterNumber)) continue
    for (const raw of schedule.characters ?? []) {
      const name = castDisplayName(raw)
      const key = normalizedKeyPart(name)
      if (!name || !key || cast.has(key)) continue
      const entry = byName.get(key) ?? { name, chapters: [] }
      if (!entry.chapters.includes(schedule.chapterNumber)) entry.chapters.push(schedule.chapterNumber)
      byName.set(key, entry)
    }
  }

  const findings: Array<{ finding: ConsistencyFinding, heavy: boolean, chapters: number, dialogueLines: number }> = []
  for (const [key, entry] of byName) {
    const chapters = [...entry.chapters].sort((left, right) => left - right)
    const dialogueLines = (input.prose ?? []).reduce(
      (total, row) => total + quotedLineCount(String(row.content ?? ''), entry.name), 0)
    const heavy = chapters.length >= UNREGISTERED_CAST_HEAVY_CHAPTERS
      || dialogueLines >= UNREGISTERED_CAST_HEAVY_DIALOGUE_LINES
    // 章号只进 sourceChapter，**不进 key**（#160）：key 一旦带章号，同一个人就变成 N 条提醒。
    const firstChapter = chapters[0]!
    const lastChapter = chapters[chapters.length - 1]!
    const span = chapters.length === 1
      ? `第${firstChapter}章`
      : `第${firstChapter}–${lastChapter}章（共 ${chapters.length} 章）`
    const weight = dialogueLines > 0 ? `、正文 ${dialogueLines} 段台词` : ''
    findings.push({ heavy, chapters: chapters.length, dialogueLines, finding: {
      stableFactKey: `blueprint-cast:unregistered:${key}`,
      severity: 'warning',
      sourceChapter: lastChapter,
      evidence: `「${entry.name}」进了${span}的蓝图出场名单${weight}，角色卡名册里没有这个人（名册：${input.castNames.join('、') || '空'}）`,
      issue: {
        zhCN: heavy
          ? `「${entry.name}」在${span}里持续出场${weight}，但角色卡里始终没有这个人：定稿后不会为她回写状态、一致性检查也覆盖不到她，下一章起草时对她的记忆是空白。这条从第${firstChapter}章起就在报，一直没有消解——再挂起下去，她的处境只能靠模型自己记。`
          : `本章蓝图把「${entry.name}」列为出场角色，但角色卡里没有这个人：定稿后不会为他回写状态，一致性检查也覆盖不到他，下一章起草时对他的记忆是空白。`,
        enUS: heavy
          ? `“${entry.name}” appears in ${chapters.length} blueprint chapter(s)${weight} but has no character card. No state will be written after finalization, consistency checks skip them, and the next chapter starts with no memory of them. This has been reported since Chapter ${firstChapter} without being resolved.`
          : `This chapter's blueprint casts “${entry.name}”, who has no character card. No state will be written for them after finalization, consistency checks skip them, and the next chapter starts with no memory of them.`,
      },
      suggestion: {
        zhCN: heavy
          ? `这个人已经在承担主线，别再挂起：点「为「${entry.name}」建卡」先落一张空卡（姓名 + 定位），再把她的身世、称呼变化与在第${firstChapter}章的首次出场补进卡里。卡本身的内容仍要你或模型来写——判据不替她编身份，只负责让这张卡存在。`
          : `要保留这个角色，就点「为「${entry.name}」建卡」（姓名 + 定位即可），并把本章标为他的首次出场；只当一次性路人时，请把蓝图与正文里的名字换成无名的身份称呼（如「账房伙计」）。`,
        enUS: heavy
          ? `This character already carries the plot, so stop deferring: use “Create a card for ${entry.name}” to write a blank card (name + role), then fill in their background, how they are addressed, and their first appearance in Chapter ${firstChapter}. The card's content is yours or the model's to write — the check only makes sure the card exists.`
          : `To keep them, use “Create a card for ${entry.name}” (name plus role) and mark this chapter as their first appearance. For a walk-on, replace the name in the blueprint and prose with a role label instead.`,
      },
      action: { kind: 'create-character', name: entry.name },
    } })
  }
  /**
   * 承重的先出，且**承重之间按分量排**（issue #160 建议 ② + #204）。
   *
   * 原来只按「承重 / 轻量」两档排、同档保持插入顺序（= 名字首次出现的章号顺序），
   * 再 `slice(0, 4)`。合并 notes 表之后这条规则会**把最重的那个人挤掉**：
   * 实测这本书里演了 8 章 58 段台词的那位排在最后（第 82 章才首次出现），
   * 被三个 6 章的路人+一个 2 章的路人挡在外面 —— 而那正是 #204 要看见的人。
   * 现在同档内按「出场章数 → 台词段数」降序，重量大的不会因为出现得晚就被切掉。
   */
  return findings
    .sort((left, right) => Number(right.heavy) - Number(left.heavy)
      || right.chapters - left.chapters
      || right.dialogueLines - left.dialogueLines)
    .slice(0, 4)
    .map(item => item.finding)
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
        zhCN: `本章蓝图标注的收束方式是「${item.label}」，但正文最后一幕${actual}。这个标注不是给人看的装饰：下一章生成时会拿它做「不得重复上一章落幅」的判断，标错等于把轮换约束建立在假信息上——看起来可信，反而比不标更难发现。`,
        enUS: `This chapter's blueprint declares the closing shot “${item.label}”, but the prose's final beat ${actualEn}. The label is not decoration: the next chapter uses it to avoid repeating the previous closing shot, so a wrong label makes that constraint rest on false information — harder to notice than no label at all.`,
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
 * 末句落点收敛：连续多章收在「一件物 + 未完结标记 + 句首不出现人」上（issue #111 / #197）。
 *
 * 与 #66 是两条不同的轴，而且样本不重叠：#66 管**语用**（末句是不是通牒式台词），
 * 本条管**形态**（末句是不是一条无人称的未完结叙述句）。本书 #66 集中在 ch15–27、
 * 本条集中在 ch36–47——`chapterEndingProfile` 那两个字段对命中的 6 章取同一个值，
 * 一个字都区分不出来。
 *
 * 判据（结构性，见 `chapter-ending.ts` 的 `endingLandingOf`）：不是台词 + 句首不出现人 + 含未完结标记。
 *
 * ⚠️ issue #197：原来这里（和类名 `subjectless-pending`）写的是「**没有人**」，而判据实际
 * 只保证「**句首**不是人」——第 80 章末句「袖里的绳圈折着…全叔把针拔出来」物起手、人收尾，
 * 就被这张标签说了谎。现在 `endingLandingOf` 已经能认这种写法（`endsOnPerson`），
 * 文案也改成「句首不出现人」，不再声称「没有人」。类名保留 `subjectless-pending`
 * 只是为了不改既有 stableFactKey（改 key 会让所有历史 ack 失效）。
 * 物每次都换（墨盒／舵轮／茶碗盖／名单／灯壳里的一卷），**句式一次没换**。
 * 窗口与阈值（W=10 / K=4）由语料标定：本书后段 10 章 4–6 章命中、前段 35 章仅 2 章。
 */
export function findPendingLandingConvergence(input: {
  chapters: ReadonlyArray<{ chapterNumber: number; content: string }>
  castNames: readonly string[]
  currentChapter: number
}): ConsistencyFinding[] {
  const hit = pendingLandingConvergence(input.chapters.map(chapter => ({
    chapterNumber: chapter.chapterNumber,
    content: chapter.content,
    castNames: input.castNames,
  })))
  if (!hit) return []
  const windowChapters = hit.window.map(item => item.chapterNumber)
  const ranges = `${windowChapters[0]}–${windowChapters[windowChapters.length - 1]}`
  const hitChapters = hit.hits.map(item => item.chapterNumber)
  const share = Math.round(hitChapters.length / hit.window.length * 100)
  /**
   * 证据要**把每一条都举出来**（issue #197）。
   *
   * 原来 `slice(-3)` 静默截断：4 条命中只展示最后 3 条，被砍掉的正好是第 80 章那一条
   * （唯一句中有人物落点的、也就是被判错的那一条）。于是作者看到的 3 条全像是真的，
   * 而 issue 里那行「命中章：80、82、85、88」列的是 4 个章号——**说 4 章、只举 3 条**，
   * 两边不一致本身就会让作者以为是 3 章（#98 是同一族教训：采样把反例切掉了）。
   *
   * 这里**全举**，不做字符预算：窗口固定 10 章、每条末句再截到 30 字，
   * 上限就是 ~400 字，不需要截断；也免得 #171 那种「按顺序丢句」把最后几条悄悄吞掉。
   */
  const samples = hit.hits.map(item => `第${item.chapterNumber}章「${item.lastSentence.slice(0, 30)}」`).join('、')
  /**
   * 临界要说出来（issue #197 建议 ③ 里能做的那一小半）。
   *
   * W=10 / K=4 是在另一本书上标定的，在本书上余量可能只有 1 章——「刚好达线」和
   * 「明显收敛」在作者眼里是两件事：前者说明这条提醒本身很脆（下一章换个落点就消失），
   * 后者才是「这一段的收束确实单一」。不改阈值（按本书密度动态标定需要真实分布，
   * 不是这一轮能定的），但把「刚好达线」写明白。
   */
  const borderline = hitChapters.length === LANDING_MIN_HITS
  return [{
    // key 锚在「哪一种落点收敛」上，**不带章号**（#86/#89/#98/#108 的教训：
    // 末章号随窗口滚动会让 key 每章都变，作者点「我已知」永远关不掉）。
    stableFactKey: 'chapter-ending:subjectless-pending',
    severity: 'warning' as const,
    // 证据落在**已定稿的那几章**里，不是正在写的这一章（issue #79）。
    sourceChapter: windowChapters[windowChapters.length - 1]!,
    evidence: `最近 ${hit.window.length} 章（第 ${ranges} 章）里 ${hitChapters.length} 章（${share}%）末句都是「一件物 + 未完结标记 + 句首不出现人」${borderline ? '（刚好达到判断线，再有一章换个落点这条就不成立）' : ''}：${samples}`,
    issue: {
      zhCN: `最近 ${hit.window.length} 章（第 ${ranges} 章）里有 **${hitChapters.length} 章（${share}%）** 的**最后一句话**是同一个骨架：先定格一件东西，再给它一个「还没结束」的状态，句首不出现人（命中章：${hitChapters.join('、')}）。物每次都换（上面证据里逐条列着是哪几件），但读者合上每一章时听到的节拍是同一个。章末是读者决定「要不要点下一章」的地方：连着这么多章用同一种形式收束，悬念的形式感会盖过内容本身。`,
      enUS: `${hitChapters.length} of the last ${hit.window.length} chapters (chapters ${ranges}) — ${share}% — close on the same skeleton: park an object, give it an unfinished state, and let no person lead the sentence (chapters ${hitChapters.join(', ')}). The object changes every time (the evidence above lists which ones) — but the beat the reader hears at the end of each chapter is identical. The closing line is where a reader decides whether to tap the next chapter; a dozen chapters closing on the same form makes the shape of suspense eclipse its content.`,
    },
    suggestion: {
      zhCN: `换几种落点交替使用：①**落在人身上**——让视角人物在末句做一个动作或判断（例如「他按平封皮，起身往门外走」），把态度写进主体；②**落在台词上**——用一句没说完或没回答的话收（但别写成二选一的胁迫式台词）；③**落在画面上但不带否定**——定格场景，不给「还/仍/只剩/不掉」这类未完结标记（「灯影把库门那道水痕照得发亮」）；④**切断**——直接把决定留到下一章开头再生效。规则是：最近十章的末句落点不得连续落在同一类上。`,
      enUS: `Alternate the landing: (1) land on a person — end with the viewpoint character making a move or a judgement, putting the attitude in the subject; (2) land on a line of speech — close on something unsaid or unanswered (but avoid the two-way/threat shape); (3) land on an image without negation — freeze the scene and drop the “still / only left / cannot” marker; (4) cut away — let the decision take effect at the start of the next chapter. Rule: the last-sentence landing must not fall in the same class across ten chapters in a row.`,
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
  /**
   * 已知正文样本（写前预检传全部定稿章）：用来**量出**检索词的可区分度（issue #88）。
   *
   * 不给就退回整段比对（旧行为）——那会把「短褂头一行父亲的名字」这种带定语的短语
   * 拿去 `includes`，正文字面不可能出现，于是恒定报未送达。
   */
  corpus?: readonly string[]
}

export function findUndeliveredForeshadowing(input: ForeshadowingDueCheck): ConsistencyFinding[] {
  if (!input.content.trim()) return []
  const corpus = input.corpus ?? []
  return input.commitments.flatMap(commitment => {
    // 检索词取「有区分度的变体」（issue #88）：中心词 + 按文档频率筛掉全书通用词。
    const keywords = selectDiscriminatingKeywords(foreshadowingKeywords(commitment.text), corpus)
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
  // issue #98：`openingConvergence` 的语义是「窗口内 scene 起手**达标**」（≥80%），
  // 返回的是**整个窗口**（调用方要用它渲染章号区间）。原实现直接把 `window.length`
  // 写成「连续 N 章都…」，于是 6 章里 5 章达标被说成 6/6，唯一的反例（第 43 章是
  // 人物起手）既不在文案里、也不在 `slice(0,3)` 的样例里。
  // 正确口径：N 必须来自**实际命中计数**，且反例要能出现在证据里。
  const scene = window.filter(item => item.shape === 'scene')
  const counter = window.find(item => item.shape !== 'scene')
  const share = Math.round(scene.length / window.length * 100)
  const samples = scene.slice(0, 3).map(item => `第${item.chapterNumber}章「${item.clause}」`).join('、')
  const counterText = counter ? `；反例：第${counter.chapterNumber}章是人物起手「${counter.clause}」` : ''
  const counterTextEn = counter ? `; the exception is chapter ${counter.chapterNumber}, which opens on a character (“${counter.clause}”)` : ''
  return [{
    // key 锚在「哪一种章首形态收敛」上，**不带章号**（issue #98 同族于 #86/#89：
    // 末章号随窗口滚动会让 key 每章都变，作者点「我已知」永远关不掉）。
    stableFactKey: 'chapter-opening:scene-first',
    severity: 'warning' as const,
    // 证据落在**已定稿的那几章**里，不是正在写的这一章（issue #79）：
    // 写成 currentChapter 会让每条提醒都以「来源：第 N 章」开头，看起来像本章的问题，
    // 而实际上章号集合全在 6–12 章之前。
    sourceChapter: window[window.length - 1]!.chapterNumber,
    evidence: `第 ${range} 章共 ${window.length} 章，其中 ${scene.length} 章（${share}%）以「时间/地点状语 + 主句」起手：${samples}${counterText}`,
    issue: {
      zhCN: `最近 ${window.length} 章（第 ${range} 章）里有 **${scene.length} 章（${share}%）** 的**开篇句**是同一个句式：先给时间或地点状语，主句在后${counter ? `（第${counter.chapterNumber}章例外，是人物起手）` : ''}。开篇句是读者每章第一眼看到的东西——连着十几章这样开场，正文还没读进去就先感到腻，连载里这种地方最容易掉收藏。这几章的场景其实各不相同，缺的只是句式轮换。`,
      enUS: `${scene.length} of the last ${window.length} chapters (chapters ${range}) — ${share}% — open with the same construction: a time or place adverbial first, the main clause after${counterTextEn}. The opening line is the first thing a reader sees in every chapter; a dozen chapters of the same opening wears thin before the prose even starts. These chapters already use different settings — only the sentence shape is repeating.`,
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
  /**
   * 其余组要**列出名字与章号**（issue #155 建议 2）。
   *
   * 旧实现只写「另有 N 组同类起手语」——那个数字无法核对，作者最自然的读法是
   * 「没有别的重复起手语」。实测那本书 38 组里只有 8 组的名字曾经出现在屏幕上。
   * 最多列 3 组（再多会淹没弹层），其余仍给数量并说明「还有」。
   */
  const others = hits.slice(1, 4).map(hit => `「${hit.opener}」（${hit.chapters.length} 章：${hit.chapters.join('、')}）`)
  const remaining = Math.max(0, hits.length - 1 - others.length)
  const othersText = others.length === 0
    ? ''
    : `；另有同类起手语 ${others.join('、')}${remaining > 0 ? ` 等 ${hits.length - 1} 组` : ''}`
  return [{
    stableFactKey: `chapter-opening:dialogue-opener:${widest!.opener}`,
    severity: 'warning' as const,
    // 证据章号集合才是读者要去看的地方（issue #79）。
    sourceChapter: widest!.chapters[widest!.chapters.length - 1]!,
    evidence: `第 ${widest!.chapters.join('、')} 章的对白都以「${widest!.opener}」起手（共 ${widest!.chapters.length} 章）${othersText}`,
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
 * 原先这里有四条**题材短语表**判据——道具终结两次（#73）、道具复活（#78）、
 * 段落起手固定化（#94）、物件过手动作固定化（#95）。
 *
 * 它们各自依赖一张我写的词表/动作表（`解开|剪断|烧掉…`、`塞进|揣进…`、代词表…），
 * 用户 2026-11-05 明确否掉这一整类：「不能去设计词表，也不能用任何的短语匹配，
 * 内容类的全部让模型判断。」
 *
 * 已改由 `content-review.ts` 的模型判据承担（轴 `prop-terminal` / `prop-moved` /
 * `repeated-device`），由作者在预检里主动触发；规则侧不再对「这句话在说什么」下断言。
 */


/**
 * 已被写死的物证又自己回来了（issue #78）。
 *
 * 实测样本：主角唯一的溯读工具「空白票根」在第 21 章被写碎、第 22 章正文自己承认
 * 「票根昨夜泡碎了，他读不了」，第 23–27 章对它的下落一个字都没有，
 * 第 28、30 章又「从怀里摸出空白票根」压上去读——没有任何取得动作。
 *
 * 与 #73 互补：那条管「同一件东西被终结两次」，这条管「只有一次终结、但后面自行复活」。
 */

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
      zhCN: `换这次登场要交代的东西：他累不累、衣服干没干、手里拿着什么、跟谁站在一起、是先出声还是先动手。**同一个角色连续几章的首次出现不得用同一套姿态＋穿戴交代**——前文已经用过的那套写法要换掉，被换掉的十几个字正是本可以写信息的地方。`,
      enUS: `Change what the entrance tells us: whether they are tired, whether the clothes are dry, what is in their hands, who they stand beside, whether they speak or act first. A character's first appearance must not repeat the same posture-plus-clothing formula in adjacent chapters. Earlier chapters have already used versions of that formula, so it can be changed — the freed-up words are exactly where new information could go.`,
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
    // ⚠️ **这里绝对不能剥离 Markdown**（issue #159，我引入过的 P0 回归）。
    //
    // 这个函数的产物不是「界面文案」，而是**落库的报告正文**：`review-revision-generation.ts`
    // 用它算 `review_content_hash` 落库，`m03-review-cycle.ts` 的 schema 校验再拿**当前代码
    // 重建同一份报告**去比那个哈希。在 #154 里我给这里加了 `stripEmphasis`，于是
    // 「旧版本落库的报告含 `**`、新版本重建的不含」→ 哈希不等 → `MIGRATION_VERIFICATION_FAILED`
    // → 旧书直接打不开（升级即触发、无自救路径）。
    //
    // 所以剥离只放在**界面渲染**那一侧（`ReviewSheet` / `EditorialPanelSection`）。
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
 * 「N 个字」的自报计数与紧随其后实体不符 → 一致性发现（issue #131）。
 *
 * 与 #47（编号位数）同族但不同量词：那条只认「编号/票号…+N 位+数字」，
 * 中文里「六个字——核至本班次为止」这种自报计数它一条都覆盖不到。
 *
 * ⚠️ key **不带章号**：这条提醒是按「哪一处计数对不上」认人的，带上章号会让
 * 「已标记稍后处理」永远关不掉（#86/#89/#98/#108 同一个坑）。
 */
export function declaredCharacterCountFindings(chapter: {
  chapterNumber: number
  content: string
}): ConsistencyFinding[] {
  return findDeclaredCharacterCountMismatches(chapter.content).map(mismatch => ({
    stableFactKey: `declared-count:chars:${mismatch.evidence.slice(0, 24)}`,
    severity: 'warning' as const,
    sourceChapter: chapter.chapterNumber,
    evidence: `第${chapter.chapterNumber}章：「${mismatch.evidence}」——声明 ${mismatch.declared} 个字，实际写出 ${mismatch.actual} 个`,
    issue: {
      zhCN: `这里声明「${mismatch.declared} 个字」，紧随其后写出的却是 ${mismatch.actual} 个字。这类句子是读者用来对账的（认字、数座号、核名单），数字对不上会让读者怀疑自己数错，回头重读。`,
      enUS: `This line claims ${mismatch.declared} characters but then writes ${mismatch.actual}. Readers use these counts to check the deduction along with the character; a wrong count makes them think they miscounted and reread.`,
    },
    suggestion: {
      zhCN: `二者改成一致：要么把声明改成 ${mismatch.actual} 个字，要么调整引出的字串到 ${mismatch.declared} 个字。`,
      enUS: `Make them agree: state ${mismatch.actual} characters, or adjust the quoted text to ${mismatch.declared}.`,
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
