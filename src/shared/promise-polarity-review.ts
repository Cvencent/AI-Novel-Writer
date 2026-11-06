import type { ConsistencyFinding } from './consistency-preflight'

/**
 * 口头约定的**方向**被复述反了（issue #142，#163 第七批改由模型判）——**由模型判断**。
 *
 * ## 为什么规则做不了
 *
 * 旧实现（下线）靠两张表：承诺动词表（答应/约定/说好…）与动作短语字符类（写记交给说带送留收报）。
 * 换本书（立契/按手印/点头应承/起誓）全部静默——而静默与「没问题」不可区分。
 * 「这句话是不是在承诺」「两次说的是不是同一件事」都要读懂句子——§1.7 禁止的写死内容逻辑。
 *
 * ## 分工
 *
 * | 步骤 | 谁做 |
 * |---|---|
 * | 把哪几章喂进去、要什么 JSON 形状 | **规则**（本模块） |
 * | 章号在范围内、**两处引文都能逐字定位** | **规则**（\`parsePromisePolarityReview\`） |
 * | 「这是不是同一约定的两次表述、方向是否相反」 | **模型** |
 * | 采纳 | **作者** |
 */

export interface PromisePolarityChapter {
  chapterNumber: number
  content: string
}

export interface PromisePolarityIssue {
  /** 首次约定所在章。 */
  firstChapterNumber: number
  /** 复述反了所在章。 */
  secondChapterNumber: number
  /** 首次约定的原句（必须能在 firstChapterNumber 的正文里逐字找到）。 */
  firstQuote: string
  /** 复述句的原句（必须能在 secondChapterNumber 的正文里逐字找到）。 */
  secondQuote: string
  explanation: string
}

export interface PromisePolarityReviewRequest {
  chapters: readonly PromisePolarityChapter[]
  language: 'zh-CN' | 'en-US'
  recentChapters?: number
}

export const PROMISE_POLARITY_RECENT_CHAPTERS = 20

export function buildPromisePolarityPrompt(request: PromisePolarityReviewRequest): { system: string, user: string } {
  const en = request.language === 'en-US'
  const limit = request.recentChapters ?? PROMISE_POLARITY_RECENT_CHAPTERS
  const chapters = [...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)

  const system = en
    ? [
      'Read the chapters. Characters sometimes make spoken promises or agreements (to do or NOT do something), and later chapters restate them.',
      'Report ONLY cases where a spoken promise is restated in the OPPOSITE direction, with no line accounting for the change:',
      'chapter A states the promise one way ("never write this down", "hand it over when asked"), a later chapter states it the other way ("you promised to write it down") — and nothing in between explains the change (the promise was lifted, renegotiated, or misremembered ON THE PAGE).',
      'Do NOT report: promises that were fulfilled exactly as stated; a promise about a DIFFERENT matter that happens to share a verb; restatements that match the original direction.',
      'Judge by meaning, not by a fixed word list: promises may be phrased as requests, oaths, deals, or conditions, and the restatement may use different words for the same matter.',
      'Every report must quote BOTH sentences verbatim: the original promise and the restatement. If you cannot quote both, do not report.',
      'If unsure, do not report — a false alarm sends the author hunting for a contradiction that is not there.',
      'Output one JSON object: {"issues":[{"firstChapterNumber":<n>,"secondChapterNumber":<n>,"firstQuote":"<exact sentence>","secondQuote":"<exact sentence>","explanation":"<one sentence: what was promised, how the two directions differ>"}]}',
      'If nothing conflicts, output {"issues":[]}. No commentary outside the JSON.',
    ].join('\n')
    : [
      '读这些章节。人物有时会做口头约定或承诺（要做/不做某事），后面的章节会复述它们。',
      '只报**同一句约定被复述成相反方向**、且没有任何一句交代改变的情况：',
      '章 A 说的是「不要写进任何册」，后面的章却复述成「你答应过写进册」——中间没有一句说明约定被解除、重新谈过、或有人当场记错（要写成**页面上发生的**改变）。',
      '不要报：按原方向兑现的约定；只是动词相同、内容不同的另一件事；方向一致的复述。',
      '按**意思**判断，不要按固定词表：约定可以是请求、起誓、交易或条件，复述也可能换了措辞说同一件事。',
      '每条都必须**逐字引用**两句：原约定句与复述句。引不出来就不要报。',
      '不确定就不要报——误报会让作者去找一个并不存在的矛盾。',
      '输出一个 JSON 对象：{"issues":[{"firstChapterNumber":<章号>,"secondChapterNumber":<章号>,"firstQuote":"<原句>","secondQuote":"<原句>","explanation":"<一句话：约定的是什么、两个方向怎么相反>"}]}',
      '没有就输出 {"issues":[]}。JSON 之外不要写任何解释。',
    ].join('\n')

  const chapterText = chapters.map(chapter => [
    en ? `### Chapter ${chapter.chapterNumber}` : `### 第${chapter.chapterNumber}章`,
    String(chapter.content),
  ].join('\n')).join('\n\n')
  const user = en ? ['## Chapters', chapterText].join('\n\n') : ['## 章节正文', chapterText].join('\n\n')
  return { system, user }
}

function stripFence(value: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(value)
  return fenced ? fenced[1]! : value
}

/**
 * 解析并校验模型输出（规则侧）。
 *
 * 四道收窄：坏 JSON → null；章号不在送进去的范围里 → 丢弃；
 * 两处引文都必须能在**各自章**的正文里逐字定位；完全重复的那条去掉。
 */
export function parsePromisePolarityReview(
  raw: string,
  request: Pick<PromisePolarityReviewRequest, 'chapters' | 'recentChapters'>,
): PromisePolarityIssue[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFence(String(raw ?? '').trim()))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const list = (parsed as { issues?: unknown }).issues
  if (!Array.isArray(list)) return null
  const limit = request.recentChapters ?? PROMISE_POLARITY_RECENT_CHAPTERS
  const byNumber = new Map([...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)
    .map(chapter => [chapter.chapterNumber, String(chapter.content)]))
  const result: PromisePolarityIssue[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const firstChapterNumber = Number(record.firstChapterNumber)
    const secondChapterNumber = Number(record.secondChapterNumber)
    const firstQuote = String(record.firstQuote ?? '').trim()
    const secondQuote = String(record.secondQuote ?? '').trim()
    if (!Number.isSafeInteger(firstChapterNumber) || !Number.isSafeInteger(secondChapterNumber)) continue
    const firstBody = byNumber.get(firstChapterNumber)
    const secondBody = byNumber.get(secondChapterNumber)
    if (!firstBody || !secondBody) continue
    if (!firstQuote || !firstBody.includes(firstQuote)) continue
    if (!secondQuote || !secondBody.includes(secondQuote)) continue
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
 * key 锚在两章（都是既成事实，不随写作推进变，#86/#89/#98/#108）+ 原句；
 * 同一对章的不同约定不会互相埋掉（#164）。
 */
export function promisePolarityFindings(issues: readonly PromisePolarityIssue[]): ConsistencyFinding[] {
  return issues.map(issue => ({
    stableFactKey: `promise:polarity:${issue.firstChapterNumber}:${issue.secondChapterNumber}:${issue.firstQuote.slice(0, 12)}`,
    severity: 'warning' as const,
    sourceChapter: issue.secondChapterNumber,
    evidence: `第${issue.firstChapterNumber}章约定「${issue.firstQuote}」；第${issue.secondChapterNumber}章复述成「${issue.secondQuote}」`,
    issue: {
      zhCN: `口头约定的方向被复述反了：第${issue.firstChapterNumber}章约定的是一件事（「${issue.firstQuote}」），第${issue.secondChapterNumber}章却复述成相反的方向（「${issue.secondQuote}」），中间没有一句交代改变。这类约定常常是几章戏的支点——方向一反，守约会被读成背约，人物的动机跟着反了。`,
      enUS: `A spoken promise is restated backwards: chapter ${issue.firstChapterNumber} states one direction (“${issue.firstQuote}”), while chapter ${issue.secondChapterNumber} repeats the opposite (“${issue.secondQuote}”) with nothing accounting for the change. Such a promise is often the pivot of several scenes — flipping it turns keeping the promise into breaking it.`,
    },
    suggestion: {
      zhCN: `把后一次的复述改回与首次约定一致的方向；若确实要写成「约定被记反了」，那就把这次记反写成**一个可辨认的错误**（人物自己发现记错、或另一个人纠正），别让它作为事实陈述过去。`,
      enUS: `Align the later restatement with the original promise. If you intend the promise to be misremembered, make the misremembering visibly a mistake (the character notices, or someone corrects it) instead of asserting it as fact.`,
    },
  }))
}
