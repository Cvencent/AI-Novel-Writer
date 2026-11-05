import type { ConsistencyFinding } from './consistency-preflight'

/**
 * 正文**内容**类判据的统一模型层（用户 2026-11-05 规则）。
 *
 * 用户原话：「不要有任何那个内容上的文字类的写死的判断逻辑，不能去设计词表，
 * 也不能用任何的短语匹配，就是不能有这类的逻辑，内容类的全部让模型判断。」
 *
 * 原先靠题材短语表判断的几族（动作反应 / 场景装置 / 低身姿态 / 道具终结与易手 /
 * 陈旧时长 / 文风套话）本质都是「这句话在说什么」——**必须交模型**。
 * 本模块只提供一次模型调用所需的三件可断言的东西：
 *
 * | 步骤 | 谁做 |
 * |---|---|
 * | 把哪几章、问什么、要什么 JSON 形状 | **规则**（`buildContentReviewPrompt`） |
 * | 答案能否核对（章号在范围内、引文能逐字定位、类别在白名单里） | **规则**（`parseContentReview`） |
 * | 「这里有没有重复的写法 / 这一拍是不是同一种动作」 | **模型** |
 * | 采纳 | **作者** |
 *
 * ⚠️ 「类别」是**判据的轴**（我们要模型回答哪几个问题），不是内容词表：
 * 轴的名称里不含任何题材词，模型按自己的理解去正文里找。
 */

/** 我们要模型回答的问题（判据轴）。**不是**词表：每条只说明「找什么现象」。 */
export const CONTENT_AXES = Object.freeze({
  'repeated-reaction': [
    '同一个角色的同一种反应式短句在多个章里反复出现（受挫时的固定反应、进场时的固定动作）',
    'the same reaction short-line repeating across chapters for one character',
  ],
  'repeated-device': [
    '同一个场景装置／起手动作在多个章里被反复用来开场（下舱、拧阀、蘸水这类固定程序）',
    'the same staging move used to open scene after scene',
  ],
  'prop-terminal': [
    '同一件道具被「终结」了两次以上（烧掉／丢掉／交出去之后又再被终结一次）',
    'the same prop destroyed or given away more than once',
  ],
  'prop-moved': [
    '同一件道具在几章之间换了持有者或容器，但正文没有写出交接动作',
    'a prop changing hands or containers across chapters without an on-page handover',
  ],
  'stale-duration': [
    '同一处状态（空着／关着／停着）用了两个互不相容的时长（先说三天，后说一个多月）',
    'one state described with two incompatible durations',
  ],
} as const)

export type ContentAxis = keyof typeof CONTENT_AXES

export interface ContentReviewChapter {
  chapterNumber: number
  content: string
}

export interface ContentReviewIssue {
  chapterNumber: number
  axis: ContentAxis
  quote: string
  explanation: string
}

export interface ContentReviewRequest {
  chapters: readonly ContentReviewChapter[]
  axes: readonly ContentAxis[]
  recentChapters?: number
  language: 'zh-CN' | 'en-US'
}

/** 每次看最近这么多章（这几族都是「跨章看过同一种写法」，窗口在判据侧收）。 */
export const CONTENT_REVIEW_RECENT_CHAPTERS = 16

export function buildContentReviewPrompt(request: ContentReviewRequest): { system: string, user: string } {
  const en = request.language === 'en-US'
  const limit = request.recentChapters ?? CONTENT_REVIEW_RECENT_CHAPTERS
  const chapters = [...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)
  const axisLines = request.axes.map(axis => `- "${axis}": ${en ? CONTENT_AXES[axis][1] : CONTENT_AXES[axis][0]}`).join('\n')

  const system = en
    ? [
      'Read the chapters and report ONLY the kinds of repetition listed below.',
      axisLines,
      'Judge by meaning, not by a fixed word list: the same move written with different words still counts; a word appearing often in different meanings does not.',
      'Each report must quote one exact sentence (or clause) from that chapter. If you cannot quote it, do not report it.',
      'Do not invent props or events that are not in the text. When unsure, do not report.',
      'Output one JSON object: {"issues":[{"chapterNumber":<n>,"axis":"<one of the axes above>","quote":"<exact sentence>","explanation":"<one sentence>"}]}',
      'Report at most 3 issues per axis. If nothing qualifies, output {"issues":[]}. No commentary outside the JSON.',
    ].join('\n')
    : [
      '读这些章节，只报下面这几类重复现象：',
      axisLines,
      '按**意思**判断，不要按固定词表：同一个动作换措辞写仍然算；一个词在不同意思上出现多次不算。',
      '每条都必须**逐字引用**该章正文里的一句（或一个分句）。引不出来就不要报。',
      '不要编造正文里没有的道具或事件。不确定就不要报。',
      '输出一个 JSON 对象：{"issues":[{"chapterNumber":<章号>,"axis":"<上面某一类>","quote":"<原句>","explanation":"<一句话>"}]}',
      '每一类最多 3 条。没有就输出 {"issues":[]}。JSON 之外不要写任何解释。',
    ].join('\n')

  const chapterText = chapters.map(chapter => [
    en ? `### Chapter ${chapter.chapterNumber}` : `### 第${chapter.chapterNumber}章`,
    String(chapter.content),
  ].join('\n')).join('\n\n')
  const user = en ? ['## Chapters', chapterText].join('\n\n') : ['## 章节正文', chapterText].join('\n\n')
  return { system, user }
}

/** 解析并校验模型输出（规则侧）。 */
export function parseContentReview(
  raw: string,
  request: Pick<ContentReviewRequest, 'chapters' | 'axes' | 'recentChapters'>,
): ContentReviewIssue[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFence(String(raw ?? '').trim()))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const list = (parsed as { issues?: unknown }).issues
  if (!Array.isArray(list)) return null
  const limit = request.recentChapters ?? CONTENT_REVIEW_RECENT_CHAPTERS
  const byNumber = new Map([...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)
    .map(chapter => [chapter.chapterNumber, String(chapter.content)]))
  const axes = new Set<string>(request.axes)
  const result: ContentReviewIssue[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const chapterNumber = Number(record.chapterNumber)
    const axis = String(record.axis ?? '')
    const quote = String(record.quote ?? '').trim()
    if (!Number.isSafeInteger(chapterNumber) || !byNumber.has(chapterNumber)) continue
    if (!axes.has(axis)) continue
    const body = byNumber.get(chapterNumber)!
    if (!quote || !body.includes(quote)) continue
    const key = `${chapterNumber}:${axis}:${quote}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      chapterNumber,
      axis: axis as ContentAxis,
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

/** 把模型判出的内容问题转成一致性发现。 */
export function contentReviewFindings(issues: readonly ContentReviewIssue[]): ConsistencyFinding[] {
  /**
   * **同章同轴合并成一条**（issue #164 建议 ②）。
   *
   * 提示词允许「每类最多 3 条」，而 key 只含 `轴 + 章号`——于是同章同轴的第 1、2 条
   * 拿到完全相同的 key：React 列表复用错节点、**ack 按 key 精确匹配会把没修的那条一起静默掉**、
   * `findingByKey` 只留最后一条（#120 的标题错配）。
   *
   * 合并后语义也变正确：**一条提醒 = 这一章这个轴的一个判断**，
   * 作者 ack 它就是把「这一章这个轴」整个认了；而不是「认了其中一句」。
   */
  const grouped = new Map<string, ContentReviewIssue[]>()
  for (const issue of issues) {
    const key = `${issue.axis}:${issue.chapterNumber}`
    const list = grouped.get(key) ?? []
    list.push(issue)
    grouped.set(key, list)
  }
  return [...grouped.values()].map(list => {
    const first = list[0]!
    const quotes = list.map(item => `「${item.quote}」`).join('、')
    const explanations = list.map(item => item.explanation).filter(Boolean).join('；')
    const count = list.length
    return {
      // 章号 + 轴是既成事实；不带「当前章」（#86/#89/#98/#108）。
      // ⚠️ 合并后**天然唯一**：一章节一轴只出一条，见上面的分组。
      stableFactKey: `prose:${first.axis}:${first.chapterNumber}`,
      severity: 'warning' as const,
      sourceChapter: first.chapterNumber,
      evidence: `第${first.chapterNumber}章（${CONTENT_AXES[first.axis][0]}）${count > 1 ? `${count} 处：` : ''}${quotes}`,
      issue: {
        zhCN: `第${first.chapterNumber}章有${count > 1 ? ` ${count} 处` : '一处'}重复写法${count > 1 ? '（同一个轴上）' : ''}：${quotes}${explanations ? `——${explanations}` : ''}。同一个动作、同一套程序在多个章里按同一顺序出现时，读者读到的是流程，不是这一章发生的事。`,
        enUS: `Chapter ${first.chapterNumber} repeats a move${count > 1 ? ` ${count} times on the same axis` : ''}: ${quotes}${explanations ? ` — ${explanations}` : ''} When the same beat runs in the same order chapter after chapter, readers read a procedure instead of what happened here.`,
      },
      suggestion: {
        zhCN: `换这一拍的落点：换由谁来做、换在场的人看见什么、换它这次造成的后果。或者在保留动作的同时**给它一个新的信息**（这次拿到的和上次不一样）。`,
        enUS: `Move this beat's landing: change who does it, what the people present notice, or the consequence it produces this time — or keep the action but give it new information.`,
      },
    }
  })
}
