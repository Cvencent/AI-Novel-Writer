import type { ConsistencyFinding } from './consistency-preflight'

/**
 * 文风**内容**判据——由**模型判断**（用户 2026-11-05 规则）。
 *
 * ## 为什么这里没有词表
 *
 * 旧 `prose-flavor.ts` 里有三族短语表：
 *
 * ```ts
 * const METAPHOR_CONNECTORS = ['仿佛','犹如','宛如','如同']
 * const PHYSIOLOGICAL_CLICHES = ['喉结','攥紧拳','咬唇','鼻血','耳鸣',…]
 * const SUMMARY_TAIL_PATTERNS = ['他知道，','她知道，','命运的齿轮','才刚刚开始',…]
 * ```
 *
 * 用户 2026-11-05 明确否掉这一整类：「**不能去设计词表，也不能用任何的短语匹配**，
 * 内容类的全部让模型判断。」
 *
 * 这条判断在代码里也能自证：这些表只对**这一本书**成立（「攥着」在本书多是字面握持、
 * 「笑停在脸上」是另一本书的现象），而判「这一句是不是模板化生理反应 / 段尾总结腔」
 * 本来就要理解这句话在说什么——那是模型的事。
 *
 * ## 分工（与 `appearance-consistency.ts` / `sensory-review.ts` 一致）
 *
 * | 步骤 | 谁做 |
 * |---|---|
 * | 喂哪几章、要什么 JSON 形状 | **规则** |
 * | 章号/引文能否逐字定位 | **规则** |
 * | 「这几章里有没有比喻堆叠 / 生理套话 / 段尾总结 / 意象被反复摩挲」 | **模型** |
 * | 采纳 | **作者** |
 */
export interface StyleReviewChapter {
  chapterNumber: number
  content: string
}

/** 模型对**一章**的文风判断：命中的是「哪一类」+ 引文。 */
export interface StyleIssue {
  chapterNumber: number
  /** 封闭的四类（这是**判据的轴**，不是内容词表）：比喻堆叠 / 生理套话 / 段尾总结 / 意象过载。 */
  kind: 'metaphor' | 'physiological' | 'summary-tail' | 'motif'
  quote: string
  explanation: string
}

export interface StyleReviewRequest {
  chapters: readonly StyleReviewChapter[]
  recentChapters?: number
  language: 'zh-CN' | 'en-US'
}

/** 每次看最近这么多章：文风是「这几章读起来像不像」，不是全书统计。 */
export const STYLE_REVIEW_RECENT_CHAPTERS = 12

/** 四类的显示名（界面与提醒共用一处）。 */
export const STYLE_KIND_LABELS: Readonly<Record<StyleIssue['kind'], [string, string]>> = Object.freeze({
  metaphor: ['比喻堆叠', 'simile stacking'],
  physiological: ['模板化生理反应', 'templated physiological reaction'],
  'summary-tail': ['段尾总结腔', 'summary-tone paragraph ending'],
  motif: ['同一个词反复承担情绪', 'one word carrying the feeling repeatedly'],
})

export function buildStyleReviewPrompt(request: StyleReviewRequest): { system: string, user: string } {
  const en = request.language === 'en-US'
  const limit = request.recentChapters ?? STYLE_REVIEW_RECENT_CHAPTERS
  const chapters = [...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)

  const system = en
    ? [
      'Read the chapters and report only these four kinds of style problems, each with a verbatim quote:',
      '"metaphor": similes piled up — the chapter leans on comparing things instead of stating them, more than about two in a chapter.',
      '"physiological": templated body reactions used as a generic stand-in for tension (throat bobbing, clenched fists, bitten lips, ringing ears…). Report when the SAME reaction family repeats, not for one vivid gesture.',
      '"summary-tail": a paragraph ends by stating what the passage meant (a moral, a realisation, "it was only the beginning").',
      '"motif": one concrete word or object is used over and over to carry the emotion of the chapter.',
      'Judge by meaning, not by a fixed word list: a simile written without a connective is still a simile; a body reaction specific to this character is NOT a cliché.',
      'Quote the exact sentence from the chapter for every issue. If you cannot quote it, do not report it.',
      'Output one JSON object: {"issues":[{"chapterNumber":<n>,"kind":"metaphor|physiological|summary-tail|motif","quote":"<exact sentence>","explanation":"<one sentence>"}]}',
      'Report at most 3 issues per chapter. If nothing qualifies, output {"issues":[]}. No commentary outside the JSON.',
    ].join('\n')
    : [
      '读这些章节，只报下面四类文风问题，每条都要**逐字引用**正文：',
      'metaphor（比喻堆叠）：这一章靠打比方推进，而不是把事情直接说出来——大致超过两处。',
      'physiological（模板化生理反应）：用通用的身体反应代替「紧张」的写法（喉结滚动、攥紧拳头、咬唇、耳鸣…）。**同一个反应反复用**才报；一次具体的动作不报。',
      'summary-tail（段尾总结腔）：一段的结尾替读者把这一段的意思说了一遍（哲理感悟、「这一切才刚刚开始」这类）。',
      'motif（同一个词反复承担情绪）：一个具体的词或物件在本章被反复用来承载情绪。',
      '按**意思**判断，不要按固定词表：不写连接词的比喻仍是比喻；这个人特有的身体反应不算套话。',
      '每条都必须逐字引用正文里的一句。引不出来就不要报。',
      '输出一个 JSON 对象：{"issues":[{"chapterNumber":<章号>,"kind":"metaphor|physiological|summary-tail|motif","quote":"<原句>","explanation":"<一句话>"}]}',
      '每章最多 3 条。没有就输出 {"issues":[]}。JSON 之外不要写任何解释。',
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
 * 收窄：坏 JSON → null；`kind` 不在四类里 → 丢弃；章号不在送进去的范围内 → 丢弃；
 * **引文在该章正文里找不到逐字匹配 → 丢弃**（引文不能定位，作者无法核对）；同章同类去重。
 */
export function parseStyleReview(
  raw: string,
  request: Pick<StyleReviewRequest, 'chapters' | 'recentChapters'>,
): StyleIssue[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFence(String(raw ?? '').trim()))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const list = (parsed as { issues?: unknown }).issues
  if (!Array.isArray(list)) return null
  const limit = request.recentChapters ?? STYLE_REVIEW_RECENT_CHAPTERS
  const byNumber = new Map([...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)
    .map(chapter => [chapter.chapterNumber, String(chapter.content)]))
  const kinds = new Set(Object.keys(STYLE_KIND_LABELS))
  const result: StyleIssue[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const chapterNumber = Number(record.chapterNumber)
    const kind = String(record.kind ?? '')
    const quote = String(record.quote ?? '').trim()
    if (!Number.isSafeInteger(chapterNumber) || !byNumber.has(chapterNumber)) continue
    if (!kinds.has(kind)) continue
    const body = byNumber.get(chapterNumber)!
    if (!quote || !body.includes(quote)) continue
    const key = `${chapterNumber}:${kind}:${quote}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      chapterNumber,
      kind: kind as StyleIssue['kind'],
      quote,
      explanation: String(record.explanation ?? '').trim(),
    })
  }
  return result
}

/** 去掉 ```json 围栏。 */
function stripFence(value: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(value)
  return fenced ? fenced[1]! : value
}

/** 把模型判出的文风问题转成一致性发现（每条一章一类）。 */
export function styleIssueFindings(issues: readonly StyleIssue[]): ConsistencyFinding[] {
  /**
   * **同章同类合并成一条**（issue #164 建议 ②）——理由与 `content-review` 完全相同：
   * 提示词允许「每章最多 3 条」，而 key 只含 `类别 + 章号`，同章第 1、2 条会同 key，
   * 导致 React 复用错节点、ack 静默掉没修的那条。
   */
  const grouped = new Map<string, StyleIssue[]>()
  for (const issue of issues) {
    const key = `${issue.kind}:${issue.chapterNumber}`
    const list = grouped.get(key) ?? []
    list.push(issue)
    grouped.set(key, list)
  }
  return [...grouped.values()].map(list => {
    const first = list[0]!
    const labels = STYLE_KIND_LABELS[first.kind]
    const quotes = list.map(item => `「${item.quote}」`).join('、')
    const explanations = list.map(item => item.explanation).filter(Boolean).join('；')
    const count = list.length
    return {
      // 章号 + 类别是既成事实；不带「当前章」（#86/#89/#98/#108）。合并后天然唯一。
      stableFactKey: `prose-flavor:${first.kind}:${first.chapterNumber}`,
      severity: 'warning' as const,
      sourceChapter: first.chapterNumber,
      evidence: `第${first.chapterNumber}章 ${labels[0]}${count > 1 ? `${count} 处` : ''}：${quotes}`,
      issue: {
        zhCN: `第${first.chapterNumber}章的${labels[0]}${count > 1 ? `（${count} 处）` : ''}：${explanations || '这一处的写法在本章显得重复或代替了具体描写。'}（原文${quotes}）`,
        enUS: `Chapter ${first.chapterNumber} — ${labels[1]}${count > 1 ? ` (${count} places)` : ''}: ${explanations || 'this passage repeats a stock move or stands in for concrete detail.'} (${quotes})`,
      },
      suggestion: {
        zhCN: `把这一处换成**具体的、这一章独有的东西**：一个动作、一个数字、一件道具的位置，或这个人特有的反应——而不是通用的比喻或身体反应。`,
        enUS: `Replace it with something concrete and specific to this chapter: an action, a number, where an object ended up, or this character's own reaction — rather than a stock simile or body beat.`,
      },
    }
  })
}
