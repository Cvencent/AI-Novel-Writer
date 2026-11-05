import type { ConsistencyFinding } from './consistency-preflight'

/**
 * 蓝图把某件事写成「一向如此」，而已定稿正文明写「没有发生」——由**模型判断**（issue #157）。
 *
 * ## 现场
 *
 * 第 25 章蓝图 `foreshadowing` 写「码头老位置**每日一停**却想不起缘由」；
 * 而第 24 章已定稿正文写「回程经过码头老位置。**脚底下没慢，也没停。**」
 *
 * 「每日一停」是对**过去整段时期**的追认，等于把第 24 章那句直接抹掉——
 * 中间没有任何转折动作，读者只会觉得前后打架。而这句是全书「他已经忘了自己是谁」的
 * 唯一体感锚点，第 24 章刚把它写成「淡出」，第 25 章又改回「保留」。
 *
 * ## 为什么原来没有任何一层看它
 *
 * | 判据 | 为什么没抓到 |
 * |---|---|
 * | `findUnmetTimeAnchorFindings`（#132） | 只比**时点**（跨日 vs 日界），不比「习惯」 |
 * | `foreshadowing-commitments`（#68） | 判「承诺在目标章有没有送达」，不判说法与事实相反 |
 * | `assertionReversalFindings`（#52） | 只认 `是X` / `不是X` 这种**结论句**结构；「每天停」不在形态里 |
 *
 * 两侧都不看「蓝图把某件事说成经常发生，而前文明确写过它没有发生」。
 *
 * ## 分工（与 `content-review` / `memory-anchor-review` 同一形态）
 *
 * | 步骤 | 谁做 |
 * |---|---|
 * | 把蓝图的哪几段（`keyEvents` / `foreshadowing` / `costsAndTurns`）与前文正文喂进去 | **规则** |
 * | 要什么 JSON 形状、两侧引文能否逐字核对 | **规则** |
 * | 「这条蓝图说法在前文里是不是被明确否定了」 | **模型** |
 * | 采纳 | **作者** |
 *
 * ⚠️ 用户 2026-11-05 定规：内容判断不许写词表。所以这里**不**去找「每天/一向/照旧」
 * 这类频率词——那条路（issue 建议 A）是词表 + 短语匹配，明令禁止。
 * 规则只负责「把蓝图声称的既有事实与前文摆在一起，问一句」。
 */

export interface BlueprintClaimChapter {
  chapterNumber: number
  /** 本章蓝图里会写成既有事实的字段（`keyEvents` / `foreshadowing` / `costsAndTurns`）。 */
  claims: string
}

export interface ProseConflictReviewRequest {
  /** 要检查的蓝图章（通常就是即将写的那一章）。 */
  claims: readonly BlueprintClaimChapter[]
  /** 已定稿正文（检索范围）。 */
  earlierChapters: readonly { chapterNumber: number, content: string }[]
  language: 'zh-CN' | 'en-US'
  /** 前文最多喂多少字（长篇别把上下文撑爆）。 */
  maxEarlierChars?: number
}

/** 前文喂入上限：约 8 万字符（≈ 四十章 800 字正文），够覆盖「同一处习惯」的回收半径。 */
export const PROSE_CONFLICT_MAX_EARLIER_CHARS = 80_000

export interface ProseConflictIssue {
  /** 蓝图章号。 */
  chapterNumber: number
  /** 蓝图里的说法（必须能在该章蓝图的 claims 里逐字找到）。 */
  claimQuote: string
  /** 前文里与之相反的那一句（必须能在那一章正文里逐字找到）。 */
  proseChapterNumber: number
  proseQuote: string
  explanation: string
}

export function buildProseConflictPrompt(request: ProseConflictReviewRequest): { system: string, user: string } {
  const en = request.language === 'en-US'
  const cap = request.maxEarlierChars ?? PROSE_CONFLICT_MAX_EARLIER_CHARS
  const claims = [...request.claims]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.claims ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
  // 由近及远保留：越近的章越可能是否定的出处。
  const earlier = [...request.earlierChapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => right.chapterNumber - left.chapterNumber)
  let used = 0
  const kept: string[] = []
  for (const chapter of earlier) {
    const block = en ? `### Chapter ${chapter.chapterNumber}\n${chapter.content}` : `### 第${chapter.chapterNumber}章\n${chapter.content}`
    if (used + block.length > cap) break
    used += block.length
    kept.push(block)
  }

  const system = en
    ? [
      'You are given what a chapter PLAN asserts about the past (its events and foreshadowing), and the chapters already finalized before it.',
      'Decide whether the plan asserts something as an ALREADY EXISTING habit, routine, or long-standing state that the finalized prose explicitly says did NOT happen or was NOT the case.',
      'Only report a direct conflict: same act, opposite claim. A plan that merely changes something, or that the prose never mentions, is NOT a conflict.',
      'A plan describing what will happen in this upcoming chapter is not a claim about the past — do not report it.',
      'Quote the plan verbatim, and quote the contradicting prose sentence verbatim, naming its chapter.',
      'If unsure, do not report — a false alarm sends the author back to re-read chapters for nothing.',
      'Output one JSON object: {"issues":[{"chapterNumber":<plan chapter>,"claimQuote":"<exact words from the plan>","proseChapterNumber":<n>,"proseQuote":"<exact sentence from that chapter>","explanation":"<one sentence>"}]}',
      'If nothing conflicts, output {"issues":[]}. No commentary outside the JSON.',
    ].join('\n')
    : [
      '下面是一份**章节蓝图**对过去的说法（本章要写的既有事件与伏笔），以及它之前的已定稿正文。',
      '判断：蓝图是否把某件事写成了**早已如此的习惯、惯例或长期状态**，而已定稿正文里**明确写过这件事没有发生、或并非如此**。',
      '只报**直接相反**的那一种：同一个动作，一边说「一直如此」，一边说「并没有」。',
      '蓝图写的是「这一章将要发生什么」，不算「对过去的追认」，不要报。',
      '正文里根本没提过这件事，也不算冲突，不要报。',
      '必须**逐字引用**蓝图里的说法，以及**逐字引用**与之相反的正文那一句，并给出它所在的章号。',
      '不确定就不要报——误报会让作者白翻几章。',
      '输出一个 JSON 对象：{"issues":[{"chapterNumber":<蓝图章号>,"claimQuote":"<蓝图原话>","proseChapterNumber":<正文章号>,"proseQuote":"<那一句正文>","explanation":"<一句话>"}]}',
      '没有就输出 {"issues":[]}。JSON 之外不要写任何解释。',
    ].join('\n')

  const claimText = claims
    .map(chapter => (en ? `### Plan for chapter ${chapter.chapterNumber}\n${chapter.claims}` : `### 第${chapter.chapterNumber}章蓝图\n${chapter.claims}`))
    .join('\n\n')
  const user = [
    en ? '## What the plan asserts' : '## 蓝图声称的既有事实',
    claimText,
    en ? '## Finalized prose before it' : '## 此前的已定稿正文',
    kept.join('\n\n'),
    ...(kept.length < earlier.length
      ? [en
        ? `(Only the most recent ${kept.length} of ${earlier.length} earlier chapters are shown; assume the text before them was not provided.)`
        : `（只给了最近 ${kept.length} 章，共 ${earlier.length} 章；更早的内容未提供。）`]
      : []),
  ].join('\n\n')
  return { system, user }
}

/**
 * 解析并校验模型输出（规则侧）。
 *
 * 四道收窄：坏 JSON → null；蓝图章号不在被检查的章里 → 丢弃；
 * **蓝图引文必须能在该章蓝图里逐字找到** → 否则丢弃；
 * **正文引文必须能在它声称的那一章里逐字找到** → 否则丢弃（作者据此定位）。
 */
export function parseProseConflictReview(
  raw: string,
  request: Pick<ProseConflictReviewRequest, 'claims' | 'earlierChapters'>,
): ProseConflictIssue[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFence(String(raw ?? '').trim()))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const list = (parsed as { issues?: unknown }).issues
  if (!Array.isArray(list)) return null
  const claimByNumber = new Map(request.claims.map(chapter => [chapter.chapterNumber, String(chapter.claims ?? '')]))
  const proseByNumber = new Map(request.earlierChapters.map(chapter => [chapter.chapterNumber, String(chapter.content ?? '')]))
  const result: ProseConflictIssue[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const chapterNumber = Number(record.chapterNumber)
    const proseChapterNumber = Number(record.proseChapterNumber)
    const claimQuote = String(record.claimQuote ?? '').trim()
    const proseQuote = String(record.proseQuote ?? '').trim()
    if (!Number.isSafeInteger(chapterNumber) || !claimByNumber.has(chapterNumber)) continue
    if (!Number.isSafeInteger(proseChapterNumber) || !proseByNumber.has(proseChapterNumber)) continue
    if (!claimQuote || !claimByNumber.get(chapterNumber)!.includes(claimQuote)) continue
    if (!proseQuote || !proseByNumber.get(proseChapterNumber)!.includes(proseQuote)) continue
    const key = `${chapterNumber}:${proseChapterNumber}:${claimQuote}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      chapterNumber,
      claimQuote,
      proseChapterNumber,
      proseQuote,
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
 * 把模型判出的「蓝图 vs 前文相反」转成一致性发现。
 *
 * ⚠️ 每章**合并一条**（#164 的教训）：同一章蓝图可能有多处这种说法，
 * key 只含章号的话会撞车，ack 会静默掉没修的那条。
 */
export function proseConflictFindings(issues: readonly ProseConflictIssue[]): ConsistencyFinding[] {
  const grouped = new Map<number, ProseConflictIssue[]>()
  for (const issue of issues) {
    const list = grouped.get(issue.chapterNumber) ?? []
    list.push(issue)
    grouped.set(issue.chapterNumber, list)
  }
  return [...grouped.entries()].map(([chapterNumber, list]) => {
    const first = list[0]!
    const claims = list.map(item => `「${item.claimQuote}」`).join('、')
    const refs = list.map(item => `第${item.proseChapterNumber}章「${item.proseQuote}」`).join('；')
    const explanations = list.map(item => item.explanation).filter(Boolean).join('；')
    return {
      // 蓝图章号是既成事实；合并后天然唯一（#164）。
      stableFactKey: `blueprint:habit-vs-prose:${chapterNumber}`,
      severity: 'warning' as const,
      sourceChapter: first.proseChapterNumber,
      evidence: `第${chapterNumber}章蓝图写「${list.map(item => item.claimQuote).join('」「')}」，而前文${refs}`,
      issue: {
        zhCN: `本章蓝图把${claims}写成了**早就在做的事**，但前文已经明写它没有发生：${refs}。这不是「这一章的发展」，而是对过去整段时期的追认——等于把前文那句直接抹掉，而中间没有任何转折。${explanations ? `（${explanations}）` : ''}`,
        enUS: `The blueprint treats ${claims} as something that has been happening all along, but the finalized prose already says it did not: ${refs}. That is not this chapter's development but a retroactive claim about the whole past — it erases the earlier line with no turning point in between.${explanations ? ` (${explanations})` : ''}`,
      },
      suggestion: {
        zhCN: `二选一：① 按前文写——这一章它还是「没做」，把蓝图那句改成只描述本章这一次；② 让「一直如此」成立——那就必须在正文里写出**从「没做」变回「做」**的那一次转折（谁、为什么、付出了什么），读者才不会认为前后打架。改完顺带看一眼事实账本：前文那句「没停」已经进了账本，后面几章还会照它写。`,
        enUS: `Either follow the prose — it still did not happen this chapter, so narrow the blueprint line to this one occasion — or make “all along” true by writing the turn from “did not” back to “does” on the page (who, why, at what cost). Then check the fact ledger: the earlier “did not stop” line is already recorded and later chapters will keep writing from it.`,
      },
    }
  })
}