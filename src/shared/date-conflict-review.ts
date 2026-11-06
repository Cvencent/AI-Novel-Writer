import type { ConsistencyFinding } from './consistency-preflight'
import { splitProseSentences } from './finalized-continuity-facts'

/**
 * 「同一个事件的日期在不同章里不一致」——由**模型判断**（issue #216）。
 *
 * ## 现场
 *
 * 那本 95 章的悬疑长篇里，周叙父亲那趟船出事的那一夜：第 3、7、12、13、14 章一律写
 * 「**七月十七**」，到第 95 章变成「**九月十七**」——
 *
 * ```
 * ch14  林棠指着残字一个一个念「……七……十七。」周叙问「哪一年？」她说「你爹出事那趟。」
 * ch95  九，十七。父亲那条船，就是九月十七夜里没回来。
 * ```
 *
 * 第 14 章已经用对白锁死「这个日期 = 父亲出事那趟」，所以第 95 章那个日子没有第二种读法。
 * 更糟的是它进了三层：**蓝图 key_events 先写「九，十七」→ 正文照抄 →
 * `chapter_commits.facts_json` 收成事实**。后面每一章起草都会继承这个错值。
 *
 * ## 为什么规则做不了这件事
 *
 * 「这两个日期说的是不是同一件事」是**内容判断**：中文叙事里同一件事可以叫
 * 「爹那趟船」「三年前那页旧账」「沉船那夜」，没有任何词表能把它和「七月十七」连起来。
 * 反过来，「行政区的九月十七」和「沉船的九月十七」也可能毫无关系——按数字硬比会全是假阳性。
 *
 * 所以与 `deadline-review.ts` 同一分工：
 *
 * | 步骤 | 谁做 |
 * |---|---|
 * | 取哪几句（**形式类**：中文/阿拉伯数字的「X月Y日」写法） | **规则** |
 * | 要什么 JSON 形状、章号/引文能否逐字定位 | **规则** |
 * | 「这两处日期是不是同一个事件」「哪个是错的」 | **模型** |
 * | 采纳 | **作者** |
 *
 * ⚠️ 取数用的是**日期写法**这一**形式类**（序数词 + 月/日标记），与 `chapter-time-anchor.ts`
 * 的「第 N 日」同一族——不是题材词表，也不产出结论。
 */

export interface DateConflictChapter {
  chapterNumber: number
  content: string
}

export interface DateConflictRequest {
  chapters: readonly DateConflictChapter[]
  language: 'zh-CN' | 'en-US'
  /** 最多取多少处日期候选（默认 `DATE_CONFLICT_MAX_MENTIONS`）。 */
  maxMentions?: number
}

/**
 * 最多取多少处日期候选（**按候选数收口，不按章数**）（issue #216）。
 *
 * 第一版按「最近 40 章」收口，实测**直接把现场漏掉了**：那本 95 章的书，
 * 互相矛盾的两处是第 3 章与第 95 章，而 40 章窗里只剩第 95 章那一处 →
 * 提示词里只有一个日期，模型无从对照（语料实测：全量 8 处候选，40 章窗只剩 1 处）。
 * 日期候选本来就稀疏（95 章正文里总共 8 句），按章号切窗口是在切**距离**，
 * 而这条判据要的恰恰是距离。改成按候选数收口：既能覆盖几百章的跨度，
 * 又不会把整本书塞进提示词。
 */
export const DATE_CONFLICT_MAX_MENTIONS = 200

/**
 * 日期的**写法**（形式类）：
 * - 中文数字月／日：「七月十七」「九月十七」「腊月廿三」；
 * - 阿拉伯数字：「7月17日」「9 月 17 号」。
 *
 * ⚠️ 这是**取数**（决定把哪几句喂给模型），不产出结论；
 * 「这两处是不是同一个事件」仍由模型判。
 */
/**
 * ⚠️ 这一条进了 `literal-tables.baseline.json`（等于一次**显式决定**），理由：
 * 里面只有**日期写法**本身——中文/阿拉伯数字的序数词 + 月/日标记。
 * 它落在 §1.7.1 明确允许的那一格（「序数词、时间单位」是语言**形式**，不是题材内容），
 * 与 `chapter-time-anchor.ts` 的「第 N 日」同一族。本模块不判断两个日期是不是同一件事。
 */
const DATE_FORM = /(?:[一二三四五六七八九十正腊]{1,3}月(?:初|廿|卅)?[一二三四五六七八九十]{1,3}(?:[日号])?|[0-9]{1,2}\s*月\s*[0-9]{1,2}\s*[日号]?)/u

/** 一个日期出现的原文片段。 */
export interface DateMention {
  chapterNumber: number
  /** 该日期在正文里**逐字**的样子（模型必须引用得到）。 */
  mention: string
  /** 提到它的那一句（供提示词给上下文）。 */
  sentence: string
}

/**
 * 取候选：正文里出现过「X 月 Y 日」写法的句子。
 *
 * 尽量**宽**（宁可多喂几句）：只要求句子里有一个日期写法，且句子不太短。
 * ⚠️ 用 `splitProseSentences`（引号感知）：中文对白里句号常在引号内，
 * 按句号硬切会把一句台词切成两半（`#181` 的教训，这里第二次用）。
 */
export function dateMentionSentences(chapters: readonly DateConflictChapter[], limit = DATE_CONFLICT_MAX_MENTIONS): DateMention[] {
  const ordered = [...chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
  const mentions: DateMention[] = []
  const seen = new Set<string>()
  for (const chapter of ordered) {
    for (const sentence of splitProseSentences(String(chapter.content))) {
      const trimmed = sentence.trim()
      if (trimmed.length < 4) continue
      const found = DATE_FORM.exec(trimmed)
      if (!found) continue
      const key = `${chapter.chapterNumber}:${trimmed}`
      if (seen.has(key)) continue
      seen.add(key)
      mentions.push({ chapterNumber: chapter.chapterNumber, mention: found[0], sentence: trimmed })
    }
  }
  // 候选稀疏，按**条数**收口（见 `DATE_CONFLICT_MAX_MENTIONS`）：只保留最近的若干处，
  // 而它们可以跨越几百章 —— 这正是一条「跨章日期对账」判据需要的跨度。
  return mentions.slice(-limit)
}

/** 模型给出的一处「同一事件、两个日期」。 */
export interface DateConflictIssue {
  /** 两个日期各自出现在哪一章。 */
  earlierChapter: number
  laterChapter: number
  /** 两处各自**逐字**的日期写法。 */
  earlierMention: string
  laterMention: string
  /** 这两处说的是同一件什么事（模型的一句话，给作者看）。 */
  event: string
  /** 哪个是对的（模型判断），说明依据。 */
  explanation: string
}

export function buildDateConflictPrompt(request: DateConflictRequest): { system: string, user: string } {
  const en = request.language === 'en-US'
  const mentions = dateMentionSentences(request.chapters, request.maxMentions ?? DATE_CONFLICT_MAX_MENTIONS)

  const system = en
    ? [
      'You are given dated mentions from one novel, chapter by chapter.',
      'Find pairs that refer to THE SAME EVENT (the same incident, not merely the same calendar day) but state DIFFERENT dates.',
      'Judge by meaning, not by matching words: the same event can be called "that boat of father\'s", "the night the ship went down", "that page of the old ledger".',
      'Do NOT report two mentions of the same date (that is consistent), and do NOT report two different events that happen to share a date — the same day can belong to unrelated events.',
      'When they conflict, say which one the rest of the book supports (state the evidence: how many chapters say it, or what another character states outright).',
      'Every report must quote BOTH dated mentions exactly as they appear. If you cannot quote them, do not report.',
      'If unsure, do not report — a false alarm sends the author to fix a date that was right.',
      'Output one JSON object: {"issues":[{"earlierChapter":<n>,"laterChapter":<n>,"earlierMention":"<exact date wording>","laterMention":"<exact date wording>","event":"<what the event is>","explanation":"<which value the book supports, and why>"}]}',
      'If nothing qualifies, output {"issues":[]}. No commentary outside the JSON.',
    ].join('\n')
    : [
      '下面是一部小说逐章的**带日期**句子。',
      '找出说的是**同一件事**（同一个事件，不只是同一天）却给出**不同日期**的两处。',
      '按**意思**判断，不要靠字面相同：同一件事可以叫「爹那趟船」「沉船那夜」「三年前那页旧账」。',
      '**不要报**同一天的两处（那是一致的）；也**不要报**两个不同事件恰好同一天——同一个日子可以属于互不相干的事。',
      '有矛盾时，指出**全书支持哪一处**，并给出依据（多少章这么写、或哪个角色明说过）。',
      '每条都必须**逐字引用**两处日期写法。引不出来就不要报。',
      '不确定就不要报——误报会让作者去改一个本来正确的日期。',
      '只输出一个 JSON 对象：{"issues":[{"earlierChapter":<章号>,"laterChapter":<章号>,"earlierMention":"<逐字日期>","laterMention":"<逐字日期>","event":"<这件事是什么>","explanation":"<全书支持哪个值、依据是什么>"}]}',
      '没有符合条件的就输出 {"issues":[]}。JSON 之外不要任何说明。',
    ].join('\n')

  const user = en
    ? [
      `Dated mentions (${mentions.length}), grouped by chapter:`,
      ...groupByChapter(mentions).map(line => line),
    ].join('\n')
    : [
      `带日期的句子（共 ${mentions.length} 处），按章排列：`,
      ...groupByChapter(mentions),
    ].join('\n')

  return { system, user }
}

function groupByChapter(mentions: readonly DateMention[]): string[] {
  const byChapter = new Map<number, DateMention[]>()
  for (const mention of mentions) {
    const list = byChapter.get(mention.chapterNumber) ?? []
    list.push(mention)
    byChapter.set(mention.chapterNumber, list)
  }
  return [...byChapter]
    .sort(([left], [right]) => left - right)
    .map(([chapterNumber, list]) => `第${chapterNumber}章：\n${list.map(item => `  - ${item.sentence}`).join('\n')}`)
}

/**
 * 解析模型的回答。
 *
 * 四条**硬校验**（与 `deadline-review` 同口径）：两处引文都必须能在**各自声明的章**里逐字找到 →
 * 否则丢弃；`event` 为空 → 丢弃；`laterChapter` 不晚于 `earlierChapter` → 丢弃（模型给反了）。
 */
export function parseDateConflictReview(
  raw: string,
  request: Pick<DateConflictRequest, 'chapters' | 'maxMentions'>,
): DateConflictIssue[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFence(String(raw ?? '').trim()))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const list = (parsed as { issues?: unknown }).issues
  if (!Array.isArray(list)) return null
  /**
   * 引文校验的章池 = **候选句覆盖到的那些章**，不是「最近 N 章」。
   *
   * 若这里按章号切窗口，而提示词按候选数给（上面那一条），就会出现
   * 「模型引的第 3 章正文不在池子里 → 整条被丢弃」这种自己造成的假阴性。
   */
  const allowed = new Set(dateMentionSentences(request.chapters, request.maxMentions ?? DATE_CONFLICT_MAX_MENTIONS)
    .map(mention => mention.chapterNumber))
  const byNumber = new Map([...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .filter(chapter => allowed.has(chapter.chapterNumber))
    .map(chapter => [chapter.chapterNumber, String(chapter.content)]))
  const result: DateConflictIssue[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const earlierChapter = Number(record.earlierChapter)
    const laterChapter = Number(record.laterChapter)
    const earlierMention = String(record.earlierMention ?? '').trim()
    const laterMention = String(record.laterMention ?? '').trim()
    const event = String(record.event ?? '').trim()
    if (!Number.isSafeInteger(earlierChapter) || !Number.isSafeInteger(laterChapter)) continue
    if (laterChapter <= earlierChapter) continue
    const earlierText = byNumber.get(earlierChapter), laterText = byNumber.get(laterChapter)
    if (!earlierText || !laterText) continue
    if (!earlierMention || !laterMention) continue
    if (!earlierText.includes(earlierMention) || !laterText.includes(laterMention)) continue
    if (!event) continue
    const key = `${earlierChapter}:${earlierMention}>${laterChapter}:${laterMention}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ earlierChapter, laterChapter, earlierMention, laterMention, event,
      explanation: String(record.explanation ?? '').trim() })
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
 * key = `date:conflict:<后出现的章>:<那一章的日期写法>`：
 * 章号是既成事实、日期写法是引用，两者都不随写作推进而变（`#86/#89/#98/#108` 的规矩）。
 * 作者把后一处改对，这条自然消失；把前一处改对它也消失（引文对不上）。
 */
export function dateConflictFindings(issues: readonly DateConflictIssue[]): ConsistencyFinding[] {
  return issues.map(item => ({
    stableFactKey: `date:conflict:${item.laterChapter}:${item.laterMention}`,
    severity: 'warning' as const,
    sourceChapter: item.laterChapter,
    evidence: `同一件事「${item.event}」在第${item.earlierChapter}章写作「${item.earlierMention}」，第${item.laterChapter}章写作「${item.laterMention}」`,
    issue: {
      zhCN: `同一件事（${item.event}）的日期在两处对不上：第${item.earlierChapter}章是「${item.earlierMention}」，第${item.laterChapter}章是「${item.laterMention}」。${item.explanation ? `（${item.explanation}）` : ''}这类数字一旦定稿，会跟着事实账本与章节要点传给后面每一章，越晚改越贵——读者也会记得那个日子，因为它往往是全书推理的支点。`,
      enUS: `The same event (${item.event}) carries two different dates: chapter ${item.earlierChapter} says “${item.earlierMention}”, chapter ${item.laterChapter} says “${item.laterMention}”. ${item.explanation ? `(${item.explanation}) ` : ''}Once finalized, a figure like this is carried into the fact ledger and the chapter summary and inherited by every later chapter — the longer it stands, the more expensive the fix, and readers remember the date precisely because a plot deduction usually rests on it.`,
    },
    suggestion: {
      zhCN: `按全书口径统一：把第${item.laterChapter}章那一处改成「${item.earlierMention}」（若前面是对的），或反过来把前面几处一起改（若后面是对的）。**改哪一处要先看事实账本**——已经落库的那条事实也要一并改，否则下一章起草还会读到错值。`,
      enUS: `Settle on one value for the whole book: change chapter ${item.laterChapter} to “${item.earlierMention}” if the earlier chapters are right, or change the earlier ones if this one is. **Check the fact ledger first** — the stored fact has to be corrected too, or the next chapter will keep drafting against the wrong value.`,
    },
  }))
}
