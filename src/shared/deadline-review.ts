import type { ConsistencyFinding } from './consistency-preflight'
import { splitProseSentences } from './finalized-continuity-facts'

/**
 * 「期限宣告了却从不结算」——由**模型判断**（issue #101 的现场，issue #163 的迁移）。
 *
 * ## 现场
 *
 * 那本 46 章的悬疑长篇里，悬念几乎全靠一个装置——**期限**：每章都甩一个期限
 * （「明早签字结案」「今夜别想开船」「天亮前得还」「日落前核完」「明日中午，逾时结案」），
 * 但 46 章读下来**没有一个期限真的到期过**：结算词（期限已过／逾期／到期／误了时辰／
 * 已经迟了）全文 **0 处**，而期限类词 **79 处 / 覆盖 29 章**。
 *
 * 「结案」从第 5 章喊到第 46 章，每次都被下一个期限顶掉；12 条明确期限里 6 条下一章整章不再提。
 * 读者对期限的敏感度被磨掉——第 1 次「明早交不出就完了」还有压力，第 12 次「逾时结案」
 * 读者已经学会「这个期限不会来」，而这本书的紧张感全押在期限上。
 *
 * ## 为什么要从规则改成模型（issue #163 + 用户 2026-11-05 定规）
 *
 * 旧实现是四张题材措辞表：
 *
 * ```ts
 * const DEADLINE_TIME    = /(天亮前|日落前|中午前|开航前|逾时|明早|明日|三日内|今夜…)/u
 * const DEADLINE_THREAT  = /(不许|别想|扣下|停船|作废|摘|卷铺盖|后果|交不出…)/u
 * const PERSISTENT_BAN   = /(?:从)?(?:今晚|今夜|现在|明天|此后|从此|今日|当天)起/u
 * const SETTLEMENT       = /(期限已过|到期|逾期|误了时辰|已经迟了|来不及|作废|不算数…)/u
 * ```
 *
 * 它们只对这本书的这几种写法成立（「七月十五前」「验完这批再谈」全漏），
 * 而「这句话是不是在宣告一条期限、下一章有没有结算它」本身就是内容判断。
 *
 * ## 分工
 *
 * | 步骤 | 谁做 |
 * |---|---|
 * | 取哪几章、喂哪些段（**按结构：宣告句与下一章全文配对**） | **规则** |
 * | 要什么 JSON 形状、章号/引文能否逐字定位 | **规则** |
 * | 「这句是不是期限宣告」「下一章有没有结算它（或把它延续）」 | **模型** |
 * | 采纳 | **作者** |
 *
 * ⚠️ 取候选句仍用「截止时点 + 后果威胁」两类**语用形态**——那是**位置筛选**（决定喂什么），
 * 不产出结论；结论由模型给。这与「用词表判内容」不是一回事，但为透明起见两张表仍在基线里。
 */

export interface DeadlineChapter {
  chapterNumber: number
  content: string
}

export interface DeadlineReviewRequest {
  chapters: readonly DeadlineChapter[]
  language: 'zh-CN' | 'en-US'
  /** 最多检查最近多少章。 */
  recentChapters?: number
}

/** 最近这么多章：期限的张力只在「下一章还没交代」时最大，窗口取近段即可。 */
export const DEADLINE_REVIEW_RECENT_CHAPTERS = 12

/** 模型给出的一处「宣告了却没结算」。 */
export interface DeadlineIssue {
  /** 宣告所在的章。 */
  chapterNumber: number
  /** 宣告那句原文（必须能在该章正文里逐字找到）。 */
  quote: string
  /** 期限要的是什么（模型的一句话，用于给作者看）。 */
  deadline: string
  explanation: string
}

/**
 * 候选宣告句：同时含「截止时点」与「后果威胁」两类语用形态的句子。
 *
 * ⚠️ 这是**取数**（喂什么给模型），不是判断。两类都是**语用/句法形态**：
 * 「X 前 / X 时」是时间状语位置，「不许 / 否则 / 后果」是威胁语气标记。
 * 与 `chapter-time-anchor.ts` 同一套形式类。
 */
/**
 * 截止时点的**形式类**（不是题材词）：
 * - 位置式：「X 前 / X 之前 / X 后」（时间状语位置）；
 * - 相对日：「明早/明日/明天/今夜/当晚/天亮前/日落前」（**语用上的相对时点**，与 `chapter-time-anchor.ts` 同一族）；
 * - 区间式：「三日内 / 两日内 / 为限 / 期限 / 时限」。
 *
 * ⚠️ 这是**取数**（决定喂哪一句给模型），不产出结论；「这句是不是期限」仍由模型判。
 */
const DEADLINE_TIME_FORM = /(?:[前后]|之前|明早|明日|明天|今夜|今晚|当晚|天亮|日落|天内|为限|期限|时限|届时)/u
/**
 * 后果威胁的**句式形态**（不是题材词）：条件—后果结构「不/没…就…」「否则…」「再…就…」，
 * 以及祈使否定「不许/别/不准」。这些是**句法位置**（条件连词 + 否定义），
 * 与具体题材无关；「这句话能不能兑现」仍由模型判。
 */
export function deadlineDeclarationSentences(chapterNumber: number, content: string): Array<{ chapterNumber: number, sentence: string }> {
  // ⚠️ 用 splitProseSentences（引号感知）：中文对白里句号常出现在引号内部，
  // 按句号硬切会把一句台词切成两半（#181 的教训）。
  const sentences = splitProseSentences(String(content ?? '')).map(s => s.trim()).filter(Boolean)
  /**
   * **只按时间状语形态取候选**（issue #163）。
   *
   * 旧实现还要求同句出现「后果威胁」（一张 20 个词的表：不许/别想/扣下/作废/摘/卷铺盖…）——
   * 那是拿一张题材词表去判「这句有没有威胁」，正是用户 2026-11-05 禁止的形态。
   * 而「『交不出，卷铺盖』算不算威胁」本身就要读懂句子。
   *
   * 所以规则只做**取数**：把含截止时点形态的句子挑出来（尽量宽，宁可多喂几句），
   * 「这句是不是期限宣告」全交模型——提示词里已写明「句子里出现时间词不等于它是期限」。
   */
  return [...new Set(sentences.filter(sentence => sentence.length >= 6 && DEADLINE_TIME_FORM.test(sentence)))]
    .map(sentence => ({ chapterNumber, sentence }))
}

export function buildDeadlineReviewPrompt(request: DeadlineReviewRequest): { system: string, user: string } {
  const en = request.language === 'en-US'
  const limit = request.recentChapters ?? DEADLINE_REVIEW_RECENT_CHAPTERS
  const chapters = [...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)
  const declarations = chapters.flatMap(chapter => deadlineDeclarationSentences(chapter.chapterNumber, chapter.content))

  const system = en
    ? [
      'Some sentences state a DEADLINE: something must be done by a point in time, or something bad follows.',
      'For each deadline sentence, look at the NEXT chapter and decide whether the deadline is settled there:',
      'either the outcome is shown (met, missed, consequences arrive), or the deadline is explicitly carried forward ("still has until…", "postponed to…").',
      'Report ONLY deadlines that the next chapter neither settles nor explicitly carries forward.',
      'A deadline met in the same chapter is fine. A deadline that the story drops because the scene ended is what to report.',
      'Judge by meaning, not by a fixed word list: the deadline may be phrased in completely different words; a sentence mentioning time is not automatically a deadline.',
      'Every report must quote the exact deadline sentence from the chapter. If you cannot quote it, do not report.',
      'If unsure, do not report — a false alarm sends the author hunting a deadline that was fine.',
      'Output one JSON object: {"issues":[{"chapterNumber":<n>,"quote":"<exact deadline sentence>","deadline":"<what is due and by when>","explanation":"<one sentence: what the next chapter did instead>"}]}',
      'If nothing qualifies, output {"issues":[]}. No commentary outside the JSON.',
    ].join('\n')
    : [
      '有些句子在宣告**期限**：某件事必须在某个时点之前做完，否则会有后果。',
      '对每一句期限，看**下一章**有没有把它结算掉：',
      '要么写出结果（做到了 / 误了 / 后果落下来了），要么**明确延续**（「还有时间」「改到……」）。',
      '只报**下一章既没有结算、也没有明确延续**的那些期限。',
      '同一章里当场兑现的期限不算问题；被场景切换无声吞掉、读者以为「这个期限不会来」的才是。',
      '按**意思**判断，不要按固定词表：期限可以换完全不同的措辞；句子里出现时间词不等于它是期限。',
      '每条都必须**逐字引用**该章正文里的那句期限。引不出来就不要报。',
      '不确定就不要报——误报会让作者去追一条其实没问题的期限。',
      '输出一个 JSON 对象：{"issues":[{"chapterNumber":<章号>,"quote":"<那句期限原文>","deadline":"<要求的是什么、到什么时候>","explanation":"<一句话：下一章改写了什么>"}]}',
      '没有就输出 {"issues":[]}。JSON 之外不要写任何解释。',
    ].join('\n')

  const declarationText = declarations.map(item => `- [第${item.chapterNumber}章] ${item.sentence}`).join('\n')
  const chapterText = chapters.map(chapter => [
    en ? `### Chapter ${chapter.chapterNumber}` : `### 第${chapter.chapterNumber}章`,
    String(chapter.content),
  ].join('\n')).join('\n\n')
  const user = en
    ? ['## Deadline sentences', declarationText, '## Chapters (check each deadline against the next one)', chapterText].join('\n\n')
    : ['## 期限宣告句', declarationText, '## 章节正文（逐条对下一章）', chapterText].join('\n\n')
  return { system, user }
}

/**
 * 解析并校验模型输出（规则侧）。
 *
 * 四道收窄：坏 JSON → null；章号不在样本里 → 丢弃；
 * **引文必须在该章正文里逐字找到** → 否则丢弃；
 * `deadline` 为空 → 丢弃（没说要什么，等于没报）。
 */
export function parseDeadlineReview(
  raw: string,
  request: Pick<DeadlineReviewRequest, 'chapters' | 'recentChapters'>,
): DeadlineIssue[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFence(String(raw ?? '').trim()))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const list = (parsed as { issues?: unknown }).issues
  if (!Array.isArray(list)) return null
  const limit = request.recentChapters ?? DEADLINE_REVIEW_RECENT_CHAPTERS
  const byNumber = new Map([...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)
    .map(chapter => [chapter.chapterNumber, String(chapter.content)]))
  const result: DeadlineIssue[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const chapterNumber = Number(record.chapterNumber)
    const quote = String(record.quote ?? '').trim()
    const deadline = String(record.deadline ?? '').trim()
    if (!Number.isSafeInteger(chapterNumber) || !byNumber.has(chapterNumber)) continue
    if (!quote || !byNumber.get(chapterNumber)!.includes(quote)) continue
    if (!deadline) continue
    const key = `${chapterNumber}:${quote}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ chapterNumber, quote, deadline, explanation: String(record.explanation ?? '').trim() })
  }
  return result
}

function stripFence(value: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(value)
  return fenced ? fenced[1]! : value
}

/**
 * 转成一致性发现。
 *
 * ⚠️ key **与旧实现同形**（`deadline:unsettled:<章号>:<时间词>`），这样历史 ack 不失效。
 * 但新的 `deadline` 是模型的一句话（可能不是一个时间词），所以这里取它里最"像时间点"的那段：
 * 先按空白/标点切，取最短的非空片段；切不出来就整句截 12 字。
 * ⚠️ 同章同一条期限只出一条（去重已在 parse 里做）；不同期限各自一条——这是对的，
 * 因为它们是**不同的期限**（旧实现按时间词分，同一章的不同时间词也是不同条）。
 */
export function deadlineReviewFindings(issues: readonly DeadlineIssue[]): ConsistencyFinding[] {
  return issues.map(item => {
    const label = deadlineLabel(item.deadline)
    return {
      stableFactKey: `deadline:unsettled:${item.chapterNumber}:${label}`,
      severity: 'warning' as const,
      sourceChapter: item.chapterNumber,
      evidence: `第${item.chapterNumber}章宣告的期限「${item.quote}」，下一章没有结算也没有明确延续${item.explanation ? `（${item.explanation}）` : ''}`,
      issue: {
        zhCN: `第${item.chapterNumber}章宣告了一条期限（${item.deadline}，原文「${item.quote}」），而下一章既没有写出结果、也没有明确延续它。这本书的紧张感如果押在期限上，读者第一次还会当回事，第五次就学会「这个期限不会来」——后面再写「明早交不出就完了」就没有压力了。${item.explanation ? `（${item.explanation}）` : ''}`,
        enUS: `Chapter ${item.chapterNumber} states a deadline (${item.deadline}; “${item.quote}”) and the next chapter neither settles it nor explicitly carries it forward. When tension rests on deadlines, readers take the first one seriously and learn by the fifth that this deadline will not come — later “unfinished by morning” beats lose their pressure.${item.explanation ? ` (${item.explanation})` : ''}`,
      },
      suggestion: {
        zhCN: `三选一：① 让它在**下一章开头**落地（兑现或误期，后果写出来）；② 明确**延续**并说明为什么（谁宽限、拖到什么时候）；③ 承认它只是虚张声势——把期限从台词里去掉。不要让它被场景切换无声吞掉。`,
        enUS: `Pick one: settle it at the start of the next chapter (met or missed, with the consequence shown), explicitly carry it forward and say why (who grants the extension, until when), or admit it was bluster and drop the deadline from the line. Do not let a scene change swallow it silently.`,
      },
    }
  })
}

/**
 * 从「模型给的期限描述」里取一个**稳定、可读**的 key 片段（issue #101 的 key 与旧实现同形）。
 *
 * ⚠️ 这一步只做**字符串形状**：切分与截断，不做语义判断。
 */
function deadlineLabel(deadline: string): string {
  const trimmed = String(deadline ?? '').trim()
  if (!trimmed) return '期限'
  // 优先取最短的、含时间状语形态的片段（「明早」「天亮前」「三日内」这类）。
  const parts = trimmed.split(/[\s，,。；;：:、（）()]+/u).map(part => part.trim()).filter(Boolean)
  const timed = parts.find(part => /(?:[前后]|之前|为限|期限|时限|内)/u.test(part) && part.length <= 12)
  if (timed) return timed
  return parts[0]!.slice(0, 12)
}