/**
 * 整句逐字跨章复用（issue #140）。
 *
 * 现场：相邻两章的**开场句**原样复制——
 *
 *   第59章  周叙看了两息，指腹按进印泥，压在栏上。
 *   第60章  周叙看了两息，指腹按进印泥，压在栏上。   ← 16 字逐字相同
 *
 * 而写第 63 章时预检弹了 46 条，**没有一条**提到它：`prose-repetition.ts` 只扫三族
 * 固定短语（stillness / staging / posture），覆盖率阈值是样本章数的 60%，整句复用
 * 永远够不到；能声明抓逐字复写的审稿第 10 维又因输出上限（#26 / #121）在本书 63 章里
 * 只覆盖到第 1–9 章。
 *
 * 判据是**字面比对**，与三族词表正交：
 * - 切句（按句末标点与换行），按标点归一（`stripForComparison`：去掉标点/空白/符号）；
 * - 取**长度 ≥ minChars 的整句**；
 * - 跨**相邻窗口**（默认 3 章）比对，归一后**整句相同**即报。
 *
 * 为什么要求「整句相同」而不是「长片段相同」：实测 LCS ≥12 汉字在本书有 11 处，
 * 其中大半是**同场景的合法延续**（第 49 章「翻出一个半边——三点水。温。」
 * →第 50 章又写同一处刮痕；第 6 章「温珩刚才站过的地方」→第 7 章回到同一片地），
 * 那种复用是叙述必须的。而**整句原样搬运**没有这个辩解——同一句话在相邻两章各出现
 * 一次，读者读到的是模板感。所以本判据刻意收在「整句」这一档，宁可少报。
 *
 * 复用 `entrance-shot.ts` 的 `longestCommonSubstring` 与 `stripForComparison`（issue 建议 3）。
 */
import type { ConsistencyFinding } from './consistency-preflight'
import { longestCommonSubstring, stripForComparison } from './entrance-shot'

export interface RepeatedSentenceChapter {
  chapterNumber: number
  content: string
}

/**
 * 最少汉字数。12 是实测出来的下界：issue 点名的两处是 16 与 14 字；
 * 调到 10 会开始收进「他把存根摊在桌上」这类通用短句（本书实测 10 字档多出十余条）。
 */
export const SENTENCE_REUSE_MIN_CHARS = 12

const SENTENCE_SPLIT = /(?<=[。！？])|\n+/u

function sentencesOf(content: string): string[] {
  return String(content ?? '')
    .split(SENTENCE_SPLIT)
    .map(sentence => sentence.trim())
    .map(sentence => sentence.replace(/^[“「『"'`]+|[”」』"'`]+$/gu, '').trim())
    .filter(sentence => stripForComparison(sentence).length >= SENTENCE_REUSE_MIN_CHARS)
}

/**
 * 相邻窗口内「整句逐字复用」→ 一致性发现。
 *
 * `window` 默认 3 章：整句复用最刺眼的是**相邻两章**，放宽到 3 章覆盖「隔一章又搬回来」。
 */
export function findRepeatedSentenceFindings(
  chapters: readonly RepeatedSentenceChapter[],
  options: { window?: number; minChars?: number } = {},
): ConsistencyFinding[] {
  const window = options.window ?? 3
  const minChars = options.minChars ?? SENTENCE_REUSE_MIN_CHARS
  const ordered = [...chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .map(chapter => ({
      chapterNumber: chapter.chapterNumber,
      content: String(chapter.content),
      sentences: sentencesOf(chapter.content)
        .filter(sentence => stripForComparison(sentence).length >= minChars)
        .map(sentence => ({ raw: sentence, normalized: stripForComparison(sentence) })),
    }))

  const findings: ConsistencyFinding[] = []
  const reported = new Set<string>()
  for (const [index, chapter] of ordered.entries()) {
    for (const later of ordered.slice(index + 1)) {
      if (later.chapterNumber - chapter.chapterNumber > window) break
      for (const sentence of chapter.sentences) {
        const match = later.sentences.find(candidate => candidate.normalized === sentence.normalized)
        if (!match) continue
        // 后续章明确写成引述的（「他把那句话原样端出来」）不算模板化。
        if (isQuotation(later.content, match.raw)) continue
        // 同一句在窗口里被多次复用时只报一次（按首现章 + 原句）。
        const key = `${chapter.chapterNumber}|${sentence.normalized}`
        if (reported.has(key)) continue
        reported.add(key)
        // 证据里给出**可读的原句**（不是归一后的无标点串），作者才能去定位。
        const preview = sentence.raw.length > 50 ? `${sentence.raw.slice(0, 50)}…` : sentence.raw
        findings.push({
          // key 取「首现章 + 原句归一」：两者都是既成事实，不随写作推进而变
          // （#86/#89/#98/#108：key 里带当前章号会让提醒永远关不掉）。
          stableFactKey: `prose:sentence-reuse:${chapter.chapterNumber}:${sentence.normalized.slice(0, 16)}`,
          severity: 'warning' as const,
          sourceChapter: later.chapterNumber,
          evidence: `第${chapter.chapterNumber}章与第${later.chapterNumber}章有 ${sentence.normalized.length} 字逐字相同的整句：「${preview}」`,
          issue: {
            zhCN: `同一句话在第 ${chapter.chapterNumber} 章与第 ${later.chapterNumber} 章**逐字重复**（${sentence.normalized.length} 字）：「${preview}」。这种整句搬运是读者最容易发现的模板感——不是「同一个动作写了两遍」，而是这句话原样出现在两章里。`,
            enUS: `The same sentence appears verbatim in chapters ${chapter.chapterNumber} and ${later.chapterNumber} (${sentence.normalized.length} characters): “${preview}”. A whole sentence copied across chapters is the most visible kind of templating — not the same action written twice, but the identical line in both.`,
          },
          suggestion: {
            zhCN: `把其中一处改写掉：换一个动作落点、换视角细节，或直接删掉（若两处说的是同一件事，后一处往往可以只提结果）。若是刻意的复现（人物回想同一幕），后面那次要明确写成回想或引述，别让它读起来像重播。`,
            enUS: `Rewrite one of the two: land on a different action or viewpoint detail, or cut it (if both say the same thing, the later one usually needs only the result). If the repetition is deliberate (a character recalling the same moment), mark the later one as a recollection or quotation so it does not read as a replay.`,
          },
        })
      }
    }
  }
  // 按子串长度降序（复制得越长越该先看），再按章号。
  return findings.sort((left, right) => right.evidence.length - left.evidence.length
    || left.sourceChapter - right.sourceChapter)
}

/**
 * 后出现的那句是不是**明确引述**（issue #140 实测的假阳性形态）。
 *
 * 实测第 20 章：「周叙没坐。他把叶九那句话**原样端出来**。

『这一笔不是我一个人要补的。』谁下的令？」
 * ——这是角色**在引用**上一章说过的话，属 issue 自己列出的「刻意的复现」，
 * 不该按模板化处理。判据是**封闭的引述标记**（原样/照搬/那句话/同理…），
 * 或该句在原文里就带引号且紧邻处有引述动词；不引词表式地判「这句话像不像引用」。
 */
const QUOTATION_MARKERS = /(?:原样|照（?:原）?样|原话|那句话|这句话|引用|转述|复述|同样的话|一字不差)/u

function isQuotation(content: string, sentence: string): boolean {
  const index = content.indexOf(sentence)
  if (index < 0) return false
  // 判据只看该句**前一句**与**紧邻前文**：引述标记通常写在它前面
  // （「他把那句话原样端出来。」「这一笔……」
  const before = content.slice(Math.max(0, index - 40), index)
  return QUOTATION_MARKERS.test(before)
}

/** 与 `findRepeatedSentenceFindings` 同一口径的最长公共片段（供证据/调试用）。 */
export function longestSharedFragment(left: string, right: string): string {
  return longestCommonSubstring(stripForComparison(left), stripForComparison(right))
}