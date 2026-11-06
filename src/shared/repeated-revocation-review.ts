import type { ConsistencyFinding } from './consistency-preflight'

/**
 * 同一项不可逆处境变更被宣告两次（issue #105，#163 第九批改由模型判）——**由模型判断**。
 *
 * ## 为什么旧规则要下线
 *
 * 旧实现靠三张表：\`IRREVERSIBLE\`（从此不再/回不来/断掉…）、\`STATE_NOUNS\`（柜台/位子/售票口…）、
 * \`HANDLING_ACTION\`（递/抽/数/把…）。三张全是**本书**的题材词：换本书（茶馆/医院/官衙）
 * 全部静默；而「这句是不是在宣告一项不可逆丧失」「两处宣告的是不是同一项处境」都要读懂句子。
 *
 * ## 分工
 *
 * | 步骤 | 谁做 |
 * |---|---|
 * | 把蓝图账本与已定稿正文喂进去、要什么 JSON 形状 | **规则**（本模块） |
 * | 章号在范围内、两处引文各在**本章蓝图/正文**里逐字定位 | **规则**（\`parseRepeatedRevocationReview\`） |
 * | 「这两处宣告的是不是同一项处境、有没有中间恢复」 | **模型** |
 * | 采纳 | **作者** |
 */

export interface RevocationLedgerEntry {
  chapterNumber: number
  costs: string
}

export interface RevocationChapter {
  chapterNumber: number
  content: string
}

export interface RepeatedRevocationIssue {
  /** 第一次宣告所在章（蓝图账本）。 */
  firstChapterNumber: number
  /** 重复宣告所在章。 */
  secondChapterNumber: number
  /** 第一次宣告的原句（必须能在该章蓝图账本里逐字找到）。 */
  firstQuote: string
  /** 重复宣告的原句（必须能在该章正文里逐字找到）。 */
  secondQuote: string
  explanation: string
}

export interface RepeatedRevocationReviewRequest {
  ledger: readonly RevocationLedgerEntry[]
  prose: readonly RevocationChapter[]
  language: 'zh-CN' | 'en-US'
  recentChapters?: number
}

export const REVOCATION_RECENT_CHAPTERS = 20

export function buildRepeatedRevocationPrompt(request: RepeatedRevocationReviewRequest): { system: string, user: string } {
  const en = request.language === 'en-US'
  const limit = request.recentChapters ?? REVOCATION_RECENT_CHAPTERS
  const ledger = [...request.ledger]
    .filter(entry => Number.isSafeInteger(entry.chapterNumber) && String(entry.costs ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)
  const prose = [...request.prose]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)

  const system = en
    ? [
      'You are given the author\'s blueprint ledger (the cost/turn field per chapter) and the finalized prose.',
      'Report ONLY cases where the SAME irreversible change of circumstance is declared TWICE:',
      'the ledger declared it once (someone lost a position, a right, a place, an ability — declared permanent),',
      'and a later chapter declares it again as if new — while the prose in between shows the person still living with the loss, and no line accounts for a re-declaration.',
      'Do NOT report: a loss that was genuinely recovered on the page and then lost again (that needs its own price); two different losses sharing a word; a restatement that matches the original wording.',
      'Judge by meaning, not by a fixed word list: losses may be a job, a right, a place, an ability, a relationship.',
      'Every report must quote BOTH declarations verbatim: one from the ledger, one from the later prose. If you cannot quote both, do not report.',
      'If unsure, do not report — a false alarm sends the author hunting for a repetition that is not there.',
      'Output one JSON object: {"issues":[{"firstChapterNumber":<n>,"secondChapterNumber":<n>,"firstQuote":"<exact words from the ledger>","secondQuote":"<exact words from the prose>","explanation":"<one sentence: what was lost, how the second declaration repeats it>"}]}.',
      'If nothing conflicts, output {"issues":[]}. No commentary outside the JSON.',
    ].join('\n')
    : [
      '下面是作者的蓝图账本（每章的「代价与转折」字段）与已定稿正文。',
      '只报**同一项不可逆处境变更被宣告两次**的情况：',
      '账本里已经宣告过一次（某人失去一个位置、一项权利、一处所在、一种能力——写明永久），',
      '后面的章节又把它当成新的丧失再宣告一次——而两次之间的正文显示这个人一直带着这个损失生活，且没有一句说明为什么要重新宣告。',
      '不要报：真正在页面上恢复过、之后又失去的（那需要付出新的代价）；共用一个词的两件不同损失；与原句措辞一致的复述。',
      '按**意思**判断，不要按固定词表：损失可以是一个职位、一项权利、一处所在、一种能力、一段关系。',
      '每条都必须**逐字引用**两处：账本里的一次与后面正文里的一次。引不出来就不要报。',
      '不确定就不要报——误报会让作者去找一个并不存在的重复。',
      '输出一个 JSON 对象：{"issues":[{"firstChapterNumber":<章号>,"secondChapterNumber":<章号>,"firstQuote":"<账本原句>","secondQuote":"<正文原句>","explanation":"<一句话：失去的是什么、第二次宣告怎么重复了它>"}]}。',
      '没有就输出 {"issues":[]}。JSON 之外不要写任何解释。',
    ].join('\n')

  const ledgerText = ledger.map(entry => [
    en ? `### Ledger chapter ${entry.chapterNumber}` : `### 账本第${entry.chapterNumber}章`,
    String(entry.costs),
  ].join('\n')).join('\n\n')
  const proseText = prose.map(chapter => [
    en ? `### Prose chapter ${chapter.chapterNumber}` : `### 正文第${chapter.chapterNumber}章`,
    String(chapter.content),
  ].join('\n')).join('\n\n')

  const user = en
    ? ['## Blueprint ledger (costs & turns)', ledgerText, '## Finalized prose', proseText].join('\n\n')
    : ['## 蓝图账本（代价与转折）', ledgerText, '## 已定稿正文', proseText].join('\n\n')
  return { system, user }
}

function stripFence(value: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(value)
  return fenced ? fenced[1]! : value
}

/**
 * 解析并校验模型输出（规则侧）：
 * 两处引文各在**对应来源**里逐字定位（账本句在 costsAndTurns、正文句在该章正文）；
 * 两章都必须在送进去的范围里；完全重复的那条去掉。
 */
export function parseRepeatedRevocationReview(
  raw: string,
  request: Pick<RepeatedRevocationReviewRequest, 'ledger' | 'prose' | 'recentChapters'>,
): RepeatedRevocationIssue[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFence(String(raw ?? '').trim()))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const list = (parsed as { issues?: unknown }).issues
  if (!Array.isArray(list)) return null
  const limit = request.recentChapters ?? REVOCATION_RECENT_CHAPTERS
  const ledgerByNumber = new Map([...request.ledger]
    .filter(entry => Number.isSafeInteger(entry.chapterNumber) && String(entry.costs ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)
    .map(entry => [entry.chapterNumber, String(entry.costs)]))
  const proseByNumber = new Map([...request.prose]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)
    .map(chapter => [chapter.chapterNumber, String(chapter.content)]))
  const result: RepeatedRevocationIssue[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const firstChapterNumber = Number(record.firstChapterNumber)
    const secondChapterNumber = Number(record.secondChapterNumber)
    const firstQuote = String(record.firstQuote ?? '').trim()
    const secondQuote = String(record.secondQuote ?? '').trim()
    if (!Number.isSafeInteger(firstChapterNumber) || !Number.isSafeInteger(secondChapterNumber)) continue
    const ledgerBody = ledgerByNumber.get(firstChapterNumber)
    const proseBody = proseByNumber.get(secondChapterNumber)
    if (!ledgerBody || !proseBody) continue
    if (!firstQuote || !ledgerBody.includes(firstQuote)) continue
    if (!secondQuote || !proseBody.includes(secondQuote)) continue
    const key = `${firstChapterNumber}:${secondChapterNumber}:${firstQuote}:${secondQuote}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ firstChapterNumber, secondChapterNumber, firstQuote, secondQuote, explanation: String(record.explanation ?? '').trim() })
  }
  return result
}

/**
 * 转成一致性发现。
 *
 * key 锚在两章 + 账本句前缀（两章都是既成事实，#86/#89/#98/#108）；
 * 同对章的不同损失不互相埋掉（#164）。
 */
export function repeatedRevocationFindings(issues: readonly RepeatedRevocationIssue[]): ConsistencyFinding[] {
  return issues.map(issue => ({
    stableFactKey: `repeated-revocation:${issue.firstChapterNumber}:${issue.secondChapterNumber}:${issue.firstQuote.slice(0, 12)}`,
    severity: 'warning' as const,
    sourceChapter: issue.secondChapterNumber,
    evidence: `第${issue.firstChapterNumber}章账本宣告「${issue.firstQuote}」；第${issue.secondChapterNumber}章又宣告「${issue.secondQuote}」`,
    issue: {
      zhCN: `同一项不可逆丧失被宣告了两次：第${issue.firstChapterNumber}章账本已经写明（「${issue.firstQuote}」），第${issue.secondChapterNumber}章又当成新的丧失宣告一遍（「${issue.secondQuote}」），中间没有交代为什么重新宣告。读者第一次相信「这真的失去了」，第二次只会困惑——或者觉得前面的宣告不作数。`,
      enUS: `The same irreversible loss is declared twice: chapter ${issue.firstChapterNumber}'s ledger already states it (“${issue.firstQuote}”), and chapter ${issue.secondChapterNumber} declares it again as if new (“${issue.secondQuote}”) with no line explaining why. Readers believed the first declaration; the second one only confuses them — or teaches them the first one never counted.`,
    },
    suggestion: {
      zhCN: `删掉第二次宣告，或者给它一个存在的理由：当事人忘了已经宣告过（要写成可辨认的失误）、或宣告的内容与第一次有实质差别（同一处境的**另一面**）。别让两次宣告并排而中间没有解释。`,
      enUS: `Delete the second declaration, or give it a reason to exist: the character forgot it was already declared (as a visible mistake), or it declares a genuinely different facet of the same situation. Do not leave two declarations side by side with nothing between.`,
    },
  }))
}
