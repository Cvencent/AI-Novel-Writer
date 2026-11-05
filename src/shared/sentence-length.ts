import type { ConsistencyFinding } from './consistency-preflight'

/**
 * 句长与节奏的**纯形式**判据（issue #114 保留部分）。
 *
 * ⚠️ 用户 2026-11-05 的规则：**内容判断一律交模型**——不设计词表、不用短语匹配。
 * 本条判的是「句子有多长」，是**形式**（可数、不需要理解内容），所以留在规则里；
 * 而「比喻连接词 / 生理反应套话 / 段尾总结腔」这三族是**内容**判断（要理解这句话在说什么），
 * 已从 `prose-flavor.ts` 删除、改由模型判（见 `prose-style-review.ts`）。
 *
 * 从句长本身能断言的只有两类：
 * - **章内配额**：章均叙述句长落在 [12, 22] 字之间；每 5 段至少 1 个 ≤12 字短句、至少 1 个 ≥25 字长句；
 * - **跨章趋势**：最近窗口的叙述句均长比开篇基准低 2.5 字以上且降幅 ≥15% 即报（单章读不出的单向收敛）。
 */

/** 句长口径（与起草清单同一组数字，见 `SENTENCE_RHYTHM_RULE_ZH_CN`）。 */
export const SENTENCE_LENGTH_QUOTAS = Object.freeze({
  averageSentenceChars: 22,
  minAverageSentenceChars: 12,
  longSentenceChars: 25,
  /** 「每 N 段至少 1 个短句 / 1 个长句」的 N。 */
  paragraphsPerShortSentence: 5,
  /** 跨章趋势：最近窗口的叙述句均长比开篇基准低多少字即报。 */
  driftDropChars: 2.5,
  /** 跨章趋势的相对降幅门槛（与绝对门槛同时满足才报，避免小基数误报）。 */
  driftDropRatio: 0.15,
})

/**
 * 起草清单「句长与节奏」那一条的**单一事实源**。
 *
 * 原文只封上限，模型照它逐章把句子拆短（实测篇均从 16.0 字降到 12.5 字）；判据层当时也只有上限，
 * 两边天然同向。这里把清单口径收成一处，由模板插值引用，避免清单改了判据不动。
 * ⚠️ 与 `SENTENCE_LENGTH_QUOTAS` 是**同一组数字**，不要各写一遍。
 */
export const SENTENCE_RHYTHM_RULE_ZH_CN = Object.freeze(
  `句长与节奏（**双边**）：平均句长 12–22 字；每 5 个自然段至少 1 个 12 字以内的短句或纯动作句，`
  + `也至少 1 个 25 字以上的成句叙述；不得连续 3 句都超过 35 字，也不得连续 3 句都在 12 字以内。`
  + `解释性段落单段不超过 3 句。`,
)

/**
 * 虚词／功能字（**封闭语法类**，不是开放词表）。
 *
 * 用途：判「哪个实词重复最多」时把含这些字的窗口剔掉——中文里「了一」「的那」「他把」
 * 这类窗口在每章都会大量出现，不剔最高频词永远是它们。
 *
 * ⚠️ 只收**语法功能字**（助词/介词/连词/代词/量词/趋向动词），**不收任何实词**：
 * 一旦开始收「墨」「票」这类实词，就变成了题材词表（用户 2026-11-05 明确禁止）。
 */
export const FUNCTION_CHARACTERS: ReadonlySet<string> = new Set([
  ...'的了在是把被和与就也都这那一不没他她我你么什怎为其而且或但如若因所以至从向对给让着过很更最又还再才只已将并等种些个件张条只次回到去来说做看想要能可得地着',
])

/** 去掉对白后的正文（台词的句长由说话人决定，不是叙述节奏）。 */
function withoutQuotedDialogue(content: string): string {
  return String(content ?? '').replace(/[“「『"][^”」』"]*[”」』"]/gu, '')
}

/**
 * 叙述句长度（去掉对白、按句末标点切、只留 ≥1 字的实在句）。
 *
 * ⚠️ 长度按**去标点去空白后的字数**算——「他推开门，走了进去。」是 8 字而不是 10 字。
 */
export function narrativeSentenceLengths(content: string): number[] {
  const lengths: number[] = []
  for (const piece of withoutQuotedDialogue(content).split(/(?<=[。！？])/u)) {
    const plain = piece.replace(/[\s。！？…、；：，,.!?;:"'“”「」『』—\-]/gu, '')
    if (plain) lengths.push(plain.length)
  }
  return lengths
}

function paragraphsOf(content: string): string[] {
  return String(content ?? '').split(/\n\s*\n/u).map(block => block.trim()).filter(Boolean)
}

export interface SentenceLengthChapter {
  chapterNumber: number
  content: string
}

export interface SentenceLengthMeasurement {
  chapterNumber: number
  /** 叙述句均长（null = 本章没有叙述句）。 */
  averageChars: number | null
  sentenceCount: number
  longSentences: number
  shortSentences: number
  paragraphCount: number
}

/** 量一章的句长指标（纯统计）。 */
export function measureSentenceLengths(chapter: SentenceLengthChapter): SentenceLengthMeasurement {
  const lengths = narrativeSentenceLengths(chapter.content)
  return {
    chapterNumber: chapter.chapterNumber,
    averageChars: lengths.length === 0 ? null : lengths.reduce((sum, value) => sum + value, 0) / lengths.length,
    sentenceCount: lengths.length,
    longSentences: lengths.filter(value => value >= SENTENCE_LENGTH_QUOTAS.longSentenceChars).length,
    shortSentences: lengths.filter(value => value <= SENTENCE_LENGTH_QUOTAS.minAverageSentenceChars).length,
    paragraphCount: paragraphsOf(chapter.content).length,
  }
}
/** 跨章趋势的**开篇基准**章数与**最近窗口**章数（issue #114）。 */
export const SENTENCE_DRIFT_BASE_CHAPTERS = 10
export const SENTENCE_DRIFT_WINDOW = 10

/**
 * 章内句长配额（形式判据，保留在规则层）。
 *
 * ⚠️ 只断言「句子有多长」——这是可数的形式，不需要理解内容。
 * 「比喻太多 / 生理反应套话 / 段尾总结腔」三族是内容判断，已交模型（`prose-style-review.ts`）。
 */
export function sentenceLengthFindings(
  chapters: readonly SentenceLengthChapter[],
  currentChapter: number,
): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = []
  const ordered = [...chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
  for (const chapter of ordered) {
    const measurement = measureSentenceLengths(chapter)
    const chapterNumber = measurement.chapterNumber
    if (measurement.averageChars !== null && measurement.averageChars > SENTENCE_LENGTH_QUOTAS.averageSentenceChars) {
      findings.push({
        stableFactKey: `prose-flavor:sentence-length:${chapterNumber}`,
        severity: 'warning',
        sourceChapter: chapterNumber,
        evidence: `第${chapterNumber}章平均句长 ${measurement.averageChars.toFixed(1)} 字，清单要求 ≤${SENTENCE_LENGTH_QUOTAS.averageSentenceChars} 字`,
        issue: {
          zhCN: `本章平均句长 ${measurement.averageChars.toFixed(1)} 字，超过清单的 ${SENTENCE_LENGTH_QUOTAS.averageSentenceChars} 字。平均句长偏长通常意味着句子都在做同一件事（交代、解释、铺陈），缺短句与纯动作句来打断节奏——读者读起来会觉得「一直在被告诉」，而不是「在看事情发生」。`,
          enUS: `Average sentence length is ${measurement.averageChars.toFixed(1)} characters, above the declared ${SENTENCE_LENGTH_QUOTAS.averageSentenceChars}. A long average usually means the sentences are all doing the same job (informing, explaining, setting up) with too few short or pure-action sentences to break the rhythm.`,
        },
        suggestion: {
          zhCN: `把解释性段落拆短：每 5 个自然段里放 1 个 12 字以内的短句或纯动作句。⚠️ 但别只朝短的方向改：拆短的同时要保留成句的叙述（见同章「句长只短不长」的提醒），否则会从「太长」滑到「全是短句」。`,
          enUS: `Split the explanatory paragraphs: keep one sentence of twelve characters or fewer, or one pure-action sentence, in every five paragraphs. But do not only shorten: keep fully-formed narration alongside, or you will slide from "too long" into "all short".`,
        },
      })
    }
    if (measurement.averageChars !== null
      && measurement.sentenceCount >= 8
      && measurement.averageChars < SENTENCE_LENGTH_QUOTAS.minAverageSentenceChars) {
      findings.push({
        stableFactKey: `prose-flavor:sentence-length-floor:${chapterNumber}`,
        severity: 'warning',
        sourceChapter: chapterNumber,
        evidence: `第${chapterNumber}章叙述句均长 ${measurement.averageChars.toFixed(1)} 字（去对白，${measurement.sentenceCount} 句），低于清单下限 ${SENTENCE_LENGTH_QUOTAS.minAverageSentenceChars} 字；≥${SENTENCE_LENGTH_QUOTAS.longSentenceChars} 字的成句叙述 ${measurement.longSentences} 句`,
        issue: {
          zhCN: `本章叙述句均长只有 ${measurement.averageChars.toFixed(1)} 字（去掉对白后 ${measurement.sentenceCount} 句），低于清单下限 ${SENTENCE_LENGTH_QUOTAS.minAverageSentenceChars} 字；其中 ≥${SENTENCE_LENGTH_QUOTAS.longSentenceChars} 字的成句叙述只有 ${measurement.longSentences} 句。清单原来只写了「平均不超过 22 字」，于是逐章只朝短的方向改——句子碎成一串短拍，读者拿到的是连续的信息点，而不是成句的叙述。`,
          enUS: `Narration averages only ${measurement.averageChars.toFixed(1)} characters here (${measurement.sentenceCount} sentences excluding dialogue), below the declared floor of ${SENTENCE_LENGTH_QUOTAS.minAverageSentenceChars}; only ${measurement.longSentences} sentence(s) reach ${SENTENCE_LENGTH_QUOTAS.longSentenceChars} characters. The list only ever capped the average, so chapter after chapter got shorter until the prose is a run of short beats.`,
        },
        suggestion: {
          zhCN: `把这一章里该铺开的那几处写成成句的叙述：一件道具怎么放、一个人怎么想、一层因果怎么接。目标是长短交替：短句留给动作与冲击，长句留给交代与铺陈。规则是不得连续 3 句都 ≤12 字；每 5 段至少 1 个 ≥25 字的成句叙述。`,
          enUS: `Write the passages that genuinely need room as formed sentences. Aim for alternation: short lines for action and impact, longer ones for exposition. Never three consecutive sentences at twelve characters or fewer; keep at least one sentence of ${SENTENCE_LENGTH_QUOTAS.longSentenceChars}+ characters in every five paragraphs.`,
        },
      })
    }
  }
  void currentChapter
  return findings
}

/**
 * 跨章趋势：最近窗口的叙述句均长比开篇基准低一截（issue #114）。
 *
 * 三条同时成立才报：绝对降幅 ≥2.5 字、相对降幅 ≥15%、且最近窗口确实短。
 * 全部用**同一本书自己**的正文当基线，不需要外部人类样本。
 */
export function sentenceLengthDriftFindings(chapters: readonly SentenceLengthChapter[]): ConsistencyFinding[] {
  const metrics = chapters
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .map(chapter => measureSentenceLengths(chapter))
    .filter(metric => metric.averageChars !== null && metric.sentenceCount > 0)
  const base = metrics.slice(0, SENTENCE_DRIFT_BASE_CHAPTERS)
  const baseChars = base.reduce((sum, metric) => sum + metric.sentenceCount * (metric.averageChars ?? 0), 0)
  const baseCount = base.reduce((sum, metric) => sum + metric.sentenceCount, 0)
  if (base.length < SENTENCE_DRIFT_BASE_CHAPTERS || baseCount === 0
    || metrics.length < SENTENCE_DRIFT_BASE_CHAPTERS + SENTENCE_DRIFT_WINDOW) return []
  const baseline = baseChars / baseCount
  const recent = metrics.slice(-SENTENCE_DRIFT_WINDOW)
  const recentChars = recent.reduce((sum, metric) => sum + metric.sentenceCount * (metric.averageChars ?? 0), 0)
  const recentCount = recent.reduce((sum, metric) => sum + metric.sentenceCount, 0)
  if (recentCount === 0) return []
  const recentAverage = recentChars / recentCount
  const drop = baseline - recentAverage
  const ratio = baseline > 0 ? drop / baseline : 0
  if (drop < SENTENCE_LENGTH_QUOTAS.driftDropChars || ratio < SENTENCE_LENGTH_QUOTAS.driftDropRatio) return []
  const longShare = recent.reduce((sum, metric) => sum + metric.longSentences, 0) / recentCount
  const shortShare = recent.reduce((sum, metric) => sum + metric.shortSentences, 0) / recentCount
  const range = `${recent[0]!.chapterNumber}–${recent[recent.length - 1]!.chapterNumber}`
  return [{
    // key 锚在「这一个方向收敛了」上、不带章号（#86/#89/#98/#108/#111）。
    stableFactKey: 'prose-flavor:sentence-length-drift',
    severity: 'warning' as const,
    sourceChapter: recent[recent.length - 1]!.chapterNumber,
    evidence: `最近 ${SENTENCE_DRIFT_WINDOW} 章（第 ${range} 章）叙述句均长 ${recentAverage.toFixed(1)} 字，比开篇 ${SENTENCE_DRIFT_BASE_CHAPTERS} 章的 ${baseline.toFixed(1)} 字低 ${drop.toFixed(1)} 字（${Math.round(ratio * 100)}%）；≥${SENTENCE_LENGTH_QUOTAS.longSentenceChars} 字占比 ${(longShare * 100).toFixed(1)}%，≤${SENTENCE_LENGTH_QUOTAS.minAverageSentenceChars} 字占比 ${(shortShare * 100).toFixed(1)}%`,
    issue: {
      zhCN: `句长在单向收敛：最近 ${SENTENCE_DRIFT_WINDOW} 章（第 ${range} 章）的叙述句均长是 ${recentAverage.toFixed(1)} 字，比开篇 ${SENTENCE_DRIFT_BASE_CHAPTERS} 章的 ${baseline.toFixed(1)} 字低了 ${drop.toFixed(1)} 字（${Math.round(ratio * 100)}%），且 ≥${SENTENCE_LENGTH_QUOTAS.longSentenceChars} 字的成句叙述只剩 ${(longShare * 100).toFixed(1)}%。这不是「短句用得好」，是只朝一个方向改：句子越写越碎，到后半程那些把一件道具怎么放、一层因果怎么接铺开的成句叙述基本没有了。`,
      enUS: `Sentence length is converging in one direction: the last ${SENTENCE_DRIFT_WINDOW} chapters average ${recentAverage.toFixed(1)} characters of narration, ${drop.toFixed(1)} characters (${Math.round(ratio * 100)}%) below the opening ${baseline.toFixed(1)}, and sentences of ${SENTENCE_LENGTH_QUOTAS.longSentenceChars}+ characters are down to ${(longShare * 100).toFixed(1)}%. That is not well-used short sentences — it is a one-directional edit.`,
    },
    suggestion: {
      zhCN: `把节奏改回长短交替：找出最近几章里本该铺开却被拆碎的那几处（道具怎么放、一个人怎么想、一层因果怎么接），写回成句的叙述；短句留给动作与冲击，长句留给交代与铺陈。起草清单已同步改成双边规则（均长 12–22 字）。`,
      enUS: `Restore alternation: find the passages in the recent chapters that needed room but got chopped and write them back as formed sentences; keep short lines for action, longer ones for exposition. The drafting list is now a two-sided rule (average 12–22 characters).`,
    },
  }]
}
