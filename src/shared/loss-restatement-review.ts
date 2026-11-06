import type { ConsistencyFinding } from './consistency-preflight'

/**
 * 「同一笔遗忘被跨章重新宣告」——由**模型判断**（issue #75 的现场，issue #163 的迁移）。
 *
 * ## 现场（保留原判据的记录，因为它是这条判据存在的理由）
 *
 * 金手指的代价是「每溯读一次，墨吞掉主角一段记忆」，而同一笔缺失被跨章宣告三遍，
 * 每次读起来都像新损失：
 *
 * ```
 * ch19  他记得自己开口要过这三个结，要它们做什么，那里空了。
 * ch20  他记得让全叔打过这三个结，要它们做什么，脑子里空着。
 * ch23  他记得让全叔打过这三个结，但为什么打，脑子里空着。
 * ch24  林棠托人递的那句话，他使劲想，还是空壳。
 * ch25  他记得有人递过话，也记得是林棠递的。话里是什么，空的。
 * ```
 *
 * 代价于是变成可重复计价，后面再写「他又忘了一件事」就没有分量。
 *
 * ## 为什么从「规则」改成「模型」（issue #163 + 用户 2026-11-05 定规）
 *
 * 旧实现是五张题材措辞表：
 *
 * ```ts
 * const REMEMBER_MARKERS  = ['他记得','她记得','我记得','还记得','记得起','记得']
 * const FORGET_MARKERS    = ['空了','空着','空壳','摸不着','想不起','记不起','答不上',
 *                            '想不起来','记不起来','被水洇','想不通','记不真切']
 * const COGNITIVE_CONTEXT = /(?:脑子|心里|脑海|记忆|…)/u
 * const CARRY_OVER_PHRASES= ['仍然没','仍旧没','还是没','依然没','一直没','始终没','至今没','照旧没']
 * ```
 *
 * 它们只对这本书的这几种写法成立（「断了一截」「接不上」「像被人揭走一层」全漏），
 * 而且「这一句是不是在宣告同一笔损失」本身就是内容判断。
 *
 * ## 分工
 *
 * | 步骤 | 谁做 |
 * |---|---|
 * | 取哪几章、喂哪些段（**按结构：同段内既有记忆语素又有否定/缺失语素**） | **规则** |
 * | 要什么 JSON 形状、章号/引文能否逐字定位 | **规则** |
 * | 「这两处在说同一笔损失吗」「后一处是不是又当新损失宣告了一遍」 | **模型** |
 * | 采纳 | **作者** |
 *
 * ⚠️ 取候选段仍用「记忆语素 + 缺失语素」——那是**语法功能类**（判断「这一句在讲记忆」），
 * 且它只决定**喂什么**，不产出结论；结论由模型给。这与「用词表判内容」不是一回事，
 * 但为透明起见，这两张表仍留在基线里（见 `literal-tables.baseline.json` 的备注）。
 */

export interface LossReviewChapter {
  chapterNumber: number
  content: string
}

export interface LossRestatementReviewRequest {
  chapters: readonly LossReviewChapter[]
  language: 'zh-CN' | 'en-US'
  /** 最多检查多少章。 */
  recentChapters?: number
}

/** 最近这么多章：同一笔损失的重复宣告通常相邻数章内。 */
export const LOSS_REVIEW_RECENT_CHAPTERS = 12

export interface LossRestatementIssue {
  /** 被反复宣告缺失的那件东西（模型原话，用于展示与定位）。 */
  referent: string
  /** 涉及章号（升序，至少两个）。 */
  chapterNumbers: number[]
  /** 其中一处的原句（必须能在对应章里逐字找到）。 */
  quote: string
  /** `quote` 所在章。 */
  quoteChapterNumber: number
  explanation: string
}

export function buildLossRestatementPrompt(request: LossRestatementReviewRequest): { system: string, user: string } {
  const en = request.language === 'en-US'
  const limit = request.recentChapters ?? LOSS_REVIEW_RECENT_CHAPTERS
  const chapters = [...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)
  const spans = chapters.map(chapter => {
    const head = en ? `### Chapter ${chapter.chapterNumber}` : `### 第${chapter.chapterNumber}章`
    return `${head}\n${String(chapter.content)}`
  }).join('\n\n')

  const system = en
    ? [
      'In these chapters a power may cost a character pieces of memory. Report only ONE kind of problem:',
      'the SAME piece of lost memory is announced again in a later chapter as if it were a fresh loss.',
      'Two different things being forgotten are fine. Continuing the same loss is fine — as long as the prose makes clear it is a continuation (still not remembered), not a new loss.',
      'A new attempt to recover the same information, which pays its own price, is fine and is even the intended fix.',
      'Judge by meaning, not by a fixed word list: the same loss may be described in completely different words.',
      'Quote one exact sentence from one of the chapters you name, and name every chapter involved.',
      'If unsure, do not report — re-charging a cost is a judgement about the story, not a mechanical check.',
      'Output one JSON object: {"issues":[{"referent":"<what is lost>","chapterNumbers":[<n>,<n>],"quoteChapterNumber":<n>,"quote":"<exact sentence>","explanation":"<one sentence: why this reads as the same loss charged twice>"}]}',
      'If nothing qualifies, output {"issues":[]}. No commentary outside the JSON.',
    ].join('\n')
    : [
      '这些章节里，某种能力可能让角色付出「丢一段记忆」的代价。只报一类问题：',
      '**同一笔被丢掉的东西**，在后面某一章又被当成**新的损失**宣告了一遍。',
      '两件不同的东西被忘掉，不算；同一笔损失的**延续**也不算——只要正文让人读得出「他一直没想起来」，而不是「又新丢了一次」。',
      '为了拿回来而付出的**新尝试**（再溯读一次、求人提醒）并写了这笔代价，不算问题，那正是推荐写法。',
      '按**意思**判断，不要按固定词表：同一笔损失可以换完全不同的措辞写。',
      '**逐字引用**你点名的那一章里的一句，并把涉及的章号都列出来。',
      '不确定就不要报——「代价被重复计价」是对故事的判断，不是机械核对。',
      '输出一个 JSON 对象：{"issues":[{"referent":"<被丢掉的是什么>","chapterNumbers":[<章号>,<章号>],"quoteChapterNumber":<章号>,"quote":"<原句>","explanation":"<一句话：为什么这读起来像同一笔损失被算了两次>"}]}',
      '没有就输出 {"issues":[]}。JSON 之外不要写任何解释。',
    ].join('\n')

  const user = en ? ['## Chapters', spans].join('\n\n') : ['## 章节正文', spans].join('\n\n')
  return { system, user }
}

/**
 * 解析并校验模型输出（规则侧）。
 *
 * 五道收窄：坏 JSON → null；`referent` 为空 → 丢弃；
 * `quote` 必须能在 `quoteChapterNumber` 那一章里逐字定位；
 * `chapterNumbers` 里只保留样本范围内的章号，**少于 2 章**就丢弃（不足两章谈不上「反复」）；
 * 完全重复的那条去掉。
 */
export function parseLossRestatementReview(
  raw: string,
  request: Pick<LossRestatementReviewRequest, 'chapters' | 'recentChapters'>,
): LossRestatementIssue[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFence(String(raw ?? '').trim()))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const list = (parsed as { issues?: unknown }).issues
  if (!Array.isArray(list)) return null
  const limit = request.recentChapters ?? LOSS_REVIEW_RECENT_CHAPTERS
  const byNumber = new Map([...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)
    .map(chapter => [chapter.chapterNumber, String(chapter.content)]))
  const result: LossRestatementIssue[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const referent = String(record.referent ?? '').trim()
    const quoteChapterNumber = Number(record.quoteChapterNumber)
    const quote = String(record.quote ?? '').trim()
    if (!referent) continue
    const chapterNumbers = (Array.isArray(record.chapterNumbers) ? record.chapterNumbers : [])
      .map(value => Number(value))
      .filter(value => Number.isSafeInteger(value) && byNumber.has(value))
    if (chapterNumbers.length < 2) continue
    const body = byNumber.get(quoteChapterNumber)
    if (!body || !quote || !body.includes(quote)) continue
    const key = `${referent}:${chapterNumbers.join(',')}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      referent,
      chapterNumbers: [...new Set(chapterNumbers)].sort((left, right) => left - right),
      quoteChapterNumber,
      quote,
      explanation: String(record.explanation ?? '').trim(),
    })
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
 * key 锚在**损失本身**上、不带章号（#86/#89/#98/#108：带章号会随写作滚动，永远关不掉）。
 * 与旧实现同一口径（`continuity:loss-restatement:<referent>`），所以历史 ack 不会失效。
 */
export function lossRestatementReviewFindings(issues: readonly LossRestatementIssue[]): ConsistencyFinding[] {
  return issues.map(item => ({
    stableFactKey: `continuity:loss-restatement:${item.referent}`,
    severity: 'warning' as const,
    sourceChapter: item.chapterNumbers[item.chapterNumbers.length - 1]!,
    evidence: `「${item.referent}」的缺失在第 ${item.chapterNumbers.join('、')} 章各被当新损失宣告一次：${item.quote}`,
    issue: {
      zhCN: `同一笔记忆缺失（「${item.referent}」）在第 ${item.chapterNumbers.join('、')} 章各被宣告了一次，每次读起来都像刚发生的损失。金手指的代价是这本书张力的来源，同一笔被反复宣告，读者学到的是「这个代价可以重复计价」——后面再写「又忘了一件事」就没有分量了。${item.explanation ? `（${item.explanation}）` : ''}`,
      enUS: `The same memory loss (“${item.referent}”) is announced once in each of chapters ${item.chapterNumbers.join(', ')}, each time reading like a fresh loss. When a power's cost is repeatedly re-charged for the same thing, readers learn that the cost is repeatable — later "he forgot something again" beats land with no weight.${item.explanation ? ` (${item.explanation})` : ''}`,
    },
    suggestion: {
      zhCN: `后续章再提这件事时，二选一：① 写成**延续**（让读者读得出「一直没想起来」）；② 写成**新的获取尝试**（再溯读一次、求人提醒、换个法子查），并把这次尝试的代价落账。不要每次都用同一种「记得 X，Y 是空的」重新宣告一遍。`,
      enUS: `When later chapters revisit this, write it as a **continuation** (readers can tell it is still unremembered), or as a **new attempt** (re-reading, asking someone, another route) with its own cost recorded. Do not re-announce it each time with the same “he remembers X, but Y is blank”.`,
    },
  }))
}