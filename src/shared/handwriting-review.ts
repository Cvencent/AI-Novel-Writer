import type { ConsistencyFinding } from './consistency-preflight'

/**
 * 「同一个书写者的笔迹被写成两套互斥特征」——**由模型判断**（issue #97 的现场，issue #163 的迁移）。
 *
 * ## 现场（保留原判据的记录，因为它是这条判据存在的理由）
 *
 * 那本书的核心金手指是「溯读」——靠**笔迹特征认出是谁的手**，整条主线都架在「这笔字是谁写的」上：
 *
 *   第 11 章「第一层墨浮起来——叶九的，**横折收得急**。」
 *   第 13 章「最上头是**叶九的手，稳、匀，起笔带锋**。」   ← 同一个叶九，换了相反的一套
 *   第 17 章「……父亲留的纸条……**起笔轻，收笔回锋**。」
 *   第 28–39 章「父亲那一笔签押，**起笔重，末横压住**。」
 *
 * 第 19 章「不是叶九的手」这条推理，用来排除叶九的那套特征正是第 11 章判给他的反面。
 *
 * ## 为什么从「规则」改成「模型」（issue #163 + 用户 2026-11-05 定规）
 *
 * 旧实现写了四张书写质量词表：
 *
 * ```ts
 * const STEADY_QUALITY  = /(稳、匀|笔压稳|起笔齐|收笔匀|起笔带锋)/u
 * const HURRIED_QUALITY = /(收得急|笔压…慌|笔压…抖|收得利落)/u
 * const HEAVY_QUALITY   = /(起笔重|笔压重|末横压住|压得重)/u
 * const LIGHT_QUALITY   = /(起笔轻|力道发虚|笔画软|发虚)/u
 * ```
 *
 * 它们只对这本书的这几种写法成立（「横折收得很涩」「笔锋一转就散」全漏），
 * 而且**把「这套字迹是什么样」这个内容问题塞进了一张我编的正则**——
 * 正是用户明令禁止的形态：「不能去设计词表，也不能用任何的短语匹配，内容类的全部让模型判断」。
 *
 * ## 分工
 *
 * | 步骤 | 谁做 |
 * |---|---|
 * | 把哪几个书写者、哪些章喂进去、要什么 JSON 形状 | **规则** |
 * | 归属人是否在名册里、引文能否逐字定位、哪些章号合法 | **规则** |
 * | 「这两处说的是不是同一个人的同一支笔」「这两套特征是不是互斥」 | **模型** |
 * | 采纳 | **作者** |
 *
 * ⚠️ 归属判定（「这笔字是谁的」）同样交模型：旧实现靠 `X 的（笔|手|字|签押）` 这类句式正则，
 * 长句、倒装、代词一换就抽不到人——而「这句在说谁的笔迹」是内容判断。
 */

export interface HandwritingChapter {
  chapterNumber: number
  content: string
}

export interface HandwritingReviewRequest {
  chapters: readonly HandwritingChapter[]
  /** 在册角色名：给模型做归属时的参照（也用于校验它回引的名字）。 */
  castNames: readonly string[]
  language: 'zh-CN' | 'en-US'
  /** 最多看多少章（这一族是跨章比对，窗口在判据侧收）。 */
  recentChapters?: number
}

/** 最近这么多章：同一支笔的特征矛盾通常相隔十余章内。 */
export const HANDWRITING_REVIEW_RECENT_CHAPTERS = 40

/** 模型给出的一处自相矛盾。 */
export interface HandwritingConflictIssue {
  /** 书写者：名册里的角色名，或亲属称谓这类称谓（模型原文给出，规则只校验非空）。 */
  owner: string
  /** 主问题落在哪一章（`quote` 所在章）。 */
  chapterNumber: number
  quote: string
  /** 与之相悖的另一处。 */
  conflictingChapterNumber: number
  conflictingQuote: string
  /** 模型对「这两处是否互斥」的一句说明。 */
  explanation: string
}

export function buildHandwritingReviewPrompt(request: HandwritingReviewRequest): { system: string, user: string } {
  const en = request.language === 'en-US'
  const limit = request.recentChapters ?? HANDWRITING_REVIEW_RECENT_CHAPTERS
  const chapters = [...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)
  const castNames = (request.castNames ?? []).map(name => String(name ?? '').trim()).filter(Boolean)

  const system = en
    ? [
      'In these chapters, handwriting is used to identify WHO wrote something.',
      'Report only one kind of problem: the same writer is given two features that cannot both be true of one hand (steady vs rushed, heavy vs light, slanted one way vs the other, clean vs blotted).',
      'Two different writers may of course have different hands — never compare across writers.',
      'A change the prose itself explains (an injured hand, a forgery, a deliberate disguise) is NOT a conflict.',
      'Judge by meaning, not by a fixed word list: the same trait may be described in completely different words; a word used in ordinary narration is not a handwriting feature.',
      'Every report must quote both sentences verbatim, each from the chapter you name. If you cannot quote both, do not report.',
      'Name the writer exactly as the prose does (a cast name, or a form of address such as a kin label).',
      ...(castNames.length > 0 ? [`Known cast names: ${castNames.join(', ')}`] : []),
      'Output one JSON object: {"conflicts":[{"owner":"<whoever the handwriting belongs to>","chapterNumber":<n>,"quote":"<exact sentence>","conflictingChapterNumber":<n>,"conflictingQuote":"<exact sentence>","explanation":"<one sentence: why the two cannot both describe one hand>"}]}',
      'If nothing conflicts, output {"conflicts":[]}. No commentary outside the JSON.',
    ].join('\n')
    : [
      '这些章节里，笔迹被用来判断**某个东西是谁写的**。',
      '只报一类问题：同一个书写者被写成两套**不能同时成立**的特征（稳厉 vs 慌乱、重 vs 轻、向一侧斜 vs 向另一侧斜、干净 vs 晕开）。',
      '两个不同的人当然可以笔迹不同——**绝不跨人比较**。',
      '正文**自己交代过**的变化（手受了伤、被人仿写、刻意伪装）不算矛盾。',
      '按**意思**判断，不要按固定词表：同一个特征可以换完全不同的措辞；普通叙述里出现的字眼不算笔迹特征。',
      '每条都必须**逐字引用两处**，各自来自你点名的那一章。引不出来就不要报。',
      '书写者按正文里的叫法写（角色名，或「父亲」这类称谓）。',
      ...(castNames.length > 0 ? [`已知角色名：${castNames.join('、')}`] : []),
      '输出一个 JSON 对象：{"conflicts":[{"owner":"<这笔字是谁的>","chapterNumber":<章号>,"quote":"<原句>","conflictingChapterNumber":<章号>,"conflictingQuote":"<原句>","explanation":"<一句话：为什么这两处不能同时描述同一支笔>"}]}',
      '没有就输出 {"conflicts":[]}。JSON 之外不要写任何解释。',
    ].join('\n')

  const chapterText = chapters.map(chapter => [
    en ? `### Chapter ${chapter.chapterNumber}` : `### 第${chapter.chapterNumber}章`,
    String(chapter.content),
  ].join('\n')).join('\n\n')
  const user = en ? ['## Chapters', chapterText].join('\n\n') : ['## 章节正文', chapterText].join('\n\n')
  return { system, user }
}

/**
 * 解析并校验模型输出（规则侧）。
 *
 * 五道收窄：坏 JSON → null；`owner` 为空 → 丢弃；两个章号都必须在样本范围内；
 * **两处引文都要能在各自那一章里逐字定位**（作者据此核对）；
 * 完全重复的那条去掉。
 */
export function parseHandwritingReview(
  raw: string,
  request: Pick<HandwritingReviewRequest, 'chapters' | 'recentChapters'>,
): HandwritingConflictIssue[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFence(String(raw ?? '').trim()))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const list = (parsed as { conflicts?: unknown }).conflicts
  if (!Array.isArray(list)) return null
  const limit = request.recentChapters ?? HANDWRITING_REVIEW_RECENT_CHAPTERS
  const byNumber = new Map([...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)
    .map(chapter => [chapter.chapterNumber, String(chapter.content)]))
  const result: HandwritingConflictIssue[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const owner = String(record.owner ?? '').trim()
    const chapterNumber = Number(record.chapterNumber)
    const conflictingChapterNumber = Number(record.conflictingChapterNumber)
    const quote = String(record.quote ?? '').trim()
    const conflictingQuote = String(record.conflictingQuote ?? '').trim()
    if (!owner) continue
    if (!byNumber.has(chapterNumber) || !byNumber.has(conflictingChapterNumber)) continue
    if (!quote || !byNumber.get(chapterNumber)!.includes(quote)) continue
    if (!conflictingQuote || !byNumber.get(conflictingChapterNumber)!.includes(conflictingQuote)) continue
    const key = `${owner}:${chapterNumber}:${quote}:${conflictingChapterNumber}:${conflictingQuote}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      owner,
      chapterNumber,
      quote,
      conflictingChapterNumber,
      conflictingQuote,
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
 * ⚠️ **每个书写者合并成一条**（#164 的教训）：同一个人可能有多处矛盾，key 只含 owner
 * 的话会撞车，ack 会静默掉没修的那条。合并后语义也正确——「一条提醒 = 这个人的笔迹有问题」。
 * key 锚在归属人上、**不带章号**（#86/#89/#98/#108：带章号的 key 会随章滚动，永远关不掉）。
 */
export function handwritingReviewFindings(issues: readonly HandwritingConflictIssue[]): ConsistencyFinding[] {
  const grouped = new Map<string, HandwritingConflictIssue[]>()
  for (const issue of issues) {
    const list = grouped.get(issue.owner) ?? []
    list.push(issue)
    grouped.set(issue.owner, list)
  }
  return [...grouped.entries()].map(([owner, list]) => {
    const earliest = Math.min(...list.map(item => Math.min(item.chapterNumber, item.conflictingChapterNumber)))
    const evidence = list
      .map(item => `第${item.chapterNumber}章「${item.quote}」vs 第${item.conflictingChapterNumber}章「${item.conflictingQuote}」`)
      .join('；')
    const explanations = list.map(item => item.explanation).filter(Boolean).join('；')
    return {
      stableFactKey: `handwriting:conflict:${owner}`,
      severity: 'warning' as const,
      sourceChapter: earliest,
      evidence: `「${owner}」的笔迹被写成两套互斥特征：${evidence}${explanations ? `（${explanations}）` : ''}`,
      issue: {
        zhCN: `同一个书写者「${owner}」的笔迹在正文里有两套**互斥**的特征：${evidence}。如果这本书靠笔迹认人，读者拿不到一张可对照的特征表——每次判读都只能信叙述；而当某章用其中一套去**排除**这个人时，读者回看会发现两章对不上，整条推理跟着塌。`,
        enUS: `The same writer “${owner}” is given two **mutually exclusive** hands: ${evidence}. If the book identifies people by handwriting, readers cannot build a reference table — every identification has to be taken on trust; and when a chapter uses one of those traits to rule the person out, looking back shows the two chapters contradict each other and the deduction collapses.`,
      },
      suggestion: {
        zhCN: `把「${owner}」的笔迹特征**固定下来**：在角色卡里写下两三类可核对的特征（起笔／转折／收笔／笔压），此后每次判读只**引用**、不再重新描述。改法二选一：①选定其中一套，把另一处按它重写；②如果确实要写「笔迹变了」（手受伤、被人仿写、被指使），就在正文里写明**为什么会变**——让变化成为情节，而不是让特征随机漂移。`,
        enUS: `Fix “${owner}”'s handwriting once: record two or three checkable traits (entry, turn, exit, pressure) on the character card and only **cite** them afterwards. To repair: (1) keep one set and rewrite the other occurrence after it; or (2) if the hand really changed (injury, forgery, coercion), say on the page **why** — make the change plot instead of letting traits drift.`,
      },
    }
  })
}