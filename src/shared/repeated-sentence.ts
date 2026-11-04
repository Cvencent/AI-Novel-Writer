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

/**
 * 切句（**原样保留**引号与标点，不做任何归一、不设长度门槛）。
 *
 * ⚠️ 短句一档必须用这一份（issue #145）：
 * - 用 `sentencesOf` 取不到句子——它内建了 12 字门槛（第一版踩到，三条测试全红在
 *   「expected undefined」）；
 * - 用剥过引号的版本判「是不是台词」也不成立——**台词标记恰恰要被保留下来**才能判。
 *   长度门槛与引号归一属于各自的判据，不属于切句。
 */
function rawSentencesOf(content: string): string[] {
  return String(content ?? '')
    .split(SENTENCE_SPLIT)
    .map(sentence => sentence.trim())
    .filter(Boolean)
}

function allSentencesOf(content: string): string[] {
  return rawSentencesOf(content)
    .map(sentence => sentence.replace(/^[“「『"'`]+|[”」』"'`]+$/gu, '').trim())
    .filter(Boolean)
}

function sentencesOf(content: string): string[] {
  return allSentencesOf(content)
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

/**
 * 「同一句短叙述句」跨多章复用（issue #145）。
 *
 * `findRepeatedSentenceFindings`（#140）判的是**相邻 3 章内、≥12 字的整句搬运**，
 * 它的两条限制恰好把这一类现象整个漏掉——实测那本书 69 章里**8 章**用同一个短句骨架
 * 写金手指的代价（issue 报告统计到 12 章，含「记得 A、记得 B，中间空了」那一套）：
 *
 *   ch34 / 43 / 48 / 64 / 67   脑子里空了一块。
 *   ch52 / 61                  脑子里空了一下。
 *   ch62                       脑子里空了一小块。
 *
 * 整句只有 8 个字、**跨度 33 章**，而且**每次措辞都略有不同**（一块/一下/一小块）——
 * 逐字整句比对（#140）与「换个说法写同一件事」都判不出来。
 *
 * 所以本判据比的是**句子骨架**：归一后取**首 prefixChars 字**（issue 建议的「首 4–6 字」），
 * 同一前缀在多章出现即归为一组。这是同一族的第三档，与另两档边界互不重叠：
 *
 * | 判据 | 比什么 | 范围 |
 * |---|---|---|
 * | #140 `prose:sentence-reuse` | ≥12 字**整句逐字**相同 | 相邻 3 章 |
 * | 本判据 | 6–11 字短句的**首 6 字骨架**相同 | 分布（≥3 章、跨度 ≥8） |
 *
 * 四条收窄，全部由实测逼出：
 * - **长度 6–11 字**：≥12 归 #140，两档不重叠；下界 6 是骨架长度的下限。
 * - **不含引号**：台词复现是人物在说话（「随册送检。」三章都有是设定），
 *   模板感来自**叙述句**每次落到同一个短句上。
 * - **不含在册人名**：剥掉人名后「〇没动」「〇站在那儿」是**动作 idiom**，
 *   不是模板（实测「周叙没动。」8 章、「周叙没答。」7 章，全是正常的受挫反应）。
 * - **骨架取 6 字而不是 5**：5 字时实测开始把场所名当模板
 *   （「码头办公室的门半开着」「码头办公室门开着」三章 → 那是同一个地方，不是句式）。
 *
 * 跨章用**分布**判而不是相邻窗口（与 #111 的密度窗口同一思路）：同一句在 ≥minChapters 章
 * 出现、且首末跨度 ≥minSpan，才是在说「这本书反复用这一句」。
 *
 * 一组只出一条，把命中的章号与**变体**一起给出——作者要看到的是「这一拍用了 8 次，
 * 其中三种措辞」，不是其中一句的 8 个副本。
 * key 取**首现章 + 骨架**（两者都是既成事实），不带末章号（#86/#89/#98/#108）。
 */
export interface ShortSentenceReuseOptions {
  /** 整句归一后的最少字数（含）。默认 6。 */
  minChars?: number
  /** 整句归一后的最多字数（含）。默认 11——12 起归 #140 的长句一档，两档不重叠。 */
  maxChars?: number
  /** 骨架长度（首 N 字）。默认 6；5 会开始把场所名当模板（见文件头）。 */
  prefixChars?: number
  /** 至少在几章里出现。默认 3。 */
  minChapters?: number
  /** 首末出现章的最小跨度。默认 8——跨几章才算「反复」，否则视为同一段剧情的延续。 */
  minSpan?: number
}

export interface ShortSentenceReuse {
  /** 骨架（首 prefixChars 字，归一去标点）。 */
  skeleton: string
  /** 这个骨架下实际出现过的**不同整句**（按首次出现顺序，≤4 条）。 */
  variants: string[]
  /** 含这个骨架的章号（升序、去重）。 */
  chapters: number[]
  /** `chapters` 覆盖的章数跨度（末 − 首）。 */
  span: number
}

const SHORT_MIN_CHARS = 6
const SHORT_MAX_CHARS = 11
const SHORT_PREFIX_CHARS = 6
const SHORT_MIN_CHAPTERS = 3
const SHORT_MIN_SPAN = 8
/** 变体只列前几条：一组报一条，证据要能读，不能变成句子清单。 */
const SHORT_MAX_VARIANTS = 4

/** 整句里是否有引号（台词/引文）——有就不算「叙述句模板」。 */
const SENTENCE_QUOTED = /[“”「」『』"]/u

/**
 * 找出「同一句短叙述句的骨架在多章复用」的组（issue #145）。
 *
 * 传入 `castNames` 是**必需**的：判据要排除「人名 + 同一个动作」这种正常写法
 * （见文件头），而没有名册就无法区分「人名」与「普通名词」。
 */
export function findShortSentenceReuse(
  chapters: readonly RepeatedSentenceChapter[],
  castNames: readonly string[],
  options: ShortSentenceReuseOptions = {},
): ShortSentenceReuse[] {
  const minChars = options.minChars ?? SHORT_MIN_CHARS
  const maxChars = options.maxChars ?? SHORT_MAX_CHARS
  const prefixChars = Math.max(1, options.prefixChars ?? SHORT_PREFIX_CHARS)
  const minChapters = options.minChapters ?? SHORT_MIN_CHAPTERS
  const minSpan = options.minSpan ?? SHORT_MIN_SPAN
  const names = castNames.map(name => String(name ?? '').trim()).filter(Boolean)
  const grouped = new Map<string, { variants: string[]; chapters: number[] }>()
  for (const chapter of chapters) {
    if (!Number.isSafeInteger(chapter.chapterNumber)) continue
    for (const sentence of rawSentencesOf(String(chapter.content ?? ''))) {
      if (SENTENCE_QUOTED.test(sentence)) continue
      // 归一化只用于比较与去重：首尾引号、标点都不影响「是不是同一句」。
      const bare = sentence.replace(/^[“「『"'`]+|[”」』"'`]+$/gu, '').trim()
      if (names.some(name => bare.includes(name))) continue
      const normalized = stripForComparison(bare)
      if (normalized.length < minChars || normalized.length > maxChars) continue
      const skeleton = normalized.slice(0, prefixChars)
      const entry = grouped.get(skeleton) ?? { variants: [], chapters: [] }
      // 变体按**归一后**去重（「空了一下。」与「空了一下」算同一个变体）。
      if (!entry.variants.some(variant => stripForComparison(variant) === normalized)
        && entry.variants.length < SHORT_MAX_VARIANTS) {
        entry.variants.push(bare)
      }
      if (!entry.chapters.includes(chapter.chapterNumber)) entry.chapters.push(chapter.chapterNumber)
      grouped.set(skeleton, entry)
    }
  }
  return [...grouped.entries()]
    .map(([skeleton, entry]) => ({
      skeleton,
      variants: entry.variants,
      chapters: [...entry.chapters].sort((left, right) => left - right),
    }))
    .filter(entry => entry.chapters.length >= minChapters)
    .map(entry => ({ ...entry, span: entry.chapters.at(-1)! - entry.chapters[0]! }))
    .filter(entry => entry.span >= minSpan)
    // 复用章数多的先报；同章数按跨度、再按首现章。
    .sort((left, right) => right.chapters.length - left.chapters.length
      || right.span - left.span
      || left.chapters[0]! - right.chapters[0]!)
}

/** `findShortSentenceReuse` 的结果 → 一致性发现（一组一条）。 */
export function findShortSentenceReuseFindings(
  chapters: readonly RepeatedSentenceChapter[],
  castNames: readonly string[],
  options: ShortSentenceReuseOptions = {},
): ConsistencyFinding[] {
  return findShortSentenceReuse(chapters, castNames, options).map(reuse => {
    const first = reuse.chapters[0]!
    const list = reuse.chapters.map(number => `第${number}章`).join('、')
    const variantText = reuse.variants.map(variant => `「${variant}」`).join('、')
    const variantCount = reuse.variants.length
    return {
      // key 取首现章 + 骨架：两者都是既成事实，不随写作推进而变。
      stableFactKey: `prose:short-sentence-reuse:${first}:${reuse.skeleton}`,
      severity: 'warning' as const,
      sourceChapter: reuse.chapters.at(-1)!,
      evidence: `${reuse.chapters.length} 章用同一个句首「${reuse.skeleton}」：${list}（写法：${variantText}）`,
      issue: {
        zhCN: `同一句叙述短句在多章复用：句首是「${reuse.skeleton}」的短句出现在 ${list} 共 ${reuse.chapters.length} 章，横跨 ${reuse.span} 章${variantCount > 1 ? `，中间换了 ${variantCount} 种写法（${variantText}）` : `，写法始终是 ${variantText}`}。换措辞不算换写法——读者认出的是这个句子的形状，不是字面。这种短句最容易变成「提示音」：它本来该是这一章独有的那一拍，重复几次之后那一拍的分量就没了。`,
        enUS: `A short narrative line keeps recurring: sentences opening with “${reuse.skeleton}” appear in ${reuse.chapters.length} chapters (${list}), spanning ${reuse.span} chapters${variantCount > 1 ? `, in ${variantCount} variants (${variantText})` : ''}. Varying the wording is not varying the writing — readers recognize the shape of the sentence, not the exact characters. A short line like this easily turns into a cue, and the beat it was meant to carry loses its weight.`,
      },
      suggestion: {
        zhCN: `把其中几处改写掉：换它当场造成的后果（人物做了什么、别人看见了什么），或换身体反应、换视角落点、换它这次丢掉的**具体内容**——别让同一拍每次都落回同一个句子的形状。若确实是刻意的复现（同一件事被反复想起），后几次要带上这次新丢的东西，读者才分得出这是第几次。`,
        enUS: `Rewrite several of these: land on the consequence it produces in the scene (what someone does, what someone notices), or shift the body reaction, the viewpoint, and the specific thing lost this time — so the same beat does not keep landing on the same sentence shape. If the recurrence is deliberate (the same thing being lost again), give the later ones what was newly lost, so readers can tell which time this is.`,
      },
    }
  })
}