import type { ConsistencyFinding } from './consistency-preflight'

/**
 * 同一章蓝图**内部**自相矛盾（issue #172）——由**模型判断**。
 *
 * ## 现场
 *
 * 第 79 章蓝图 `notes` 里同一条目先写「收完**压一道**」，后面又写「温珩的结要**压三道**」：
 *
 * ```
 * - [触发] …认出其绕法与温珩收缆绕法一致（先绕半圈、从左往右收尾、收完压一道）。
 * - [结果] …先绕半圈从左往右收，打一遍松，再打仍松；温珩的结要压三道、第三道收紧时绳头朝里咬住…
 * ```
 *
 * 正文照抄了这两句（第 1 段「收完压一道」/ 第 35 段「要压三道」），而全章落幅正是
 * 「他打不成温珩的结法」——读者无法判断他到底差在哪一步。这不是起草自由发挥，
 * 是**蓝图先写成了两套，正文忠实继承**。
 *
 * ## 为什么规则做不了
 *
 * issue 建议 ① 是「抽『数词 + 量词 + 同一名词』，同章内互斥即报」。听起来像结构判据，
 * 但它要求**判断两个「道」是不是同一属性**：同一章里「压一道」「三道缆桩」「第二道闸」
 * 里的「道」指三件不同的事。要分清必须读懂句子，而任何「数词+量词」的正则都是把
 * 「什么算同一个属性」写死进代码——正是用户 2026-11-05 禁止的那类内容逻辑。
 * 所以整条交模型：规则只负责**把同一章的蓝图原文整段摆进去**、校验引文可定位。
 *
 * ## 分工
 *
 * | 步骤 | 谁做 |
 * |---|---|
 * | 把哪几章的蓝图原文喂进去、要什么 JSON 形状 | **规则** |
 * | 章号是否在范围内、**两处引文是否都能在该章蓝图里逐字定位** | **规则** |
 * | 「这两句说的是不是同一件事、数值是不是互斥」 | **模型** |
 * | 采纳 | **作者** |
 */

export interface BlueprintInternalChapter {
  chapterNumber: number
  /** 这一章蓝图里会写成既有事实的全部文本（notes / keyEvents / foreshadowing / costsAndTurns）。 */
  text: string
}

export interface BlueprintInternalReviewRequest {
  chapters: readonly BlueprintInternalChapter[]
  language: 'zh-CN' | 'en-US'
  /** 最多检查多少章（越靠后越重要）。 */
  recentChapters?: number
}

/** 最近这么多章：蓝图自相矛盾在写到那一章时才需要看，滚动窗口取近段即可。 */
export const BLUEPRINT_INTERNAL_RECENT_CHAPTERS = 8

export interface BlueprintInternalIssue {
  chapterNumber: number
  /** 两处互斥表述的原文（都必须能在该章蓝图里逐字找到）。 */
  firstQuote: string
  secondQuote: string
  explanation: string
}

export function buildBlueprintInternalPrompt(request: BlueprintInternalReviewRequest): { system: string, user: string } {
  const en = request.language === 'en-US'
  const limit = request.recentChapters ?? BLUEPRINT_INTERNAL_RECENT_CHAPTERS
  const chapters = [...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.text ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)

  const system = en
    ? [
      'You are given chapter blueprints (the plan the prose is written from).',
      'Report ONLY cases where ONE chapter\'s own plan contradicts itself about the same concrete thing:',
      'the same object, gesture, procedure or quantity is described with two incompatible values',
      '(one press vs three presses, two people vs three, left hand vs right hand, before dawn vs after noon).',
      'Two mentions of the same thing that agree are fine. Two different things that happen to share a word are NOT a conflict.',
      'Do NOT compare across chapters — each report must concern a single chapter.',
      'Judge by meaning, not by a fixed word list or number pattern: the number may be written in words or digits.',
      'Quote both phrases verbatim from that chapter\'s plan. If you cannot quote both, do not report.',
      'If unsure, do not report — a false alarm makes the author hunt for a contradiction that is not there.',
      'Output one JSON object: {"issues":[{"chapterNumber":<n>,"firstQuote":"<exact words>","secondQuote":"<exact words>","explanation":"<one sentence: which concrete thing, which two values>"}]}',
      'If nothing conflicts, output {"issues":[]}. No commentary outside the JSON.',
    ].join('\n')
    : [
      '下面是章节蓝图（正文照着它写）。',
      '只报**同一章蓝图自己**对**同一件具体事物**给出两套不能同时成立的数值/工序：',
      '同一件物、同一个动作、同一道工序或同一个数量，被写成两个不相容的值（压一道 vs 压三道、两个人 vs 三个人、左手 vs 右手、天亮前 vs 午后）。',
      '同一件事被提两次而说法一致，不算；两件不同的事恰好共用一个词，也不算。',
      '**不要跨章比较**——每条都必须是同一章内部的问题。',
      '按**意思**判断，不要按固定词表或数字形式：数字可能写成汉字也可能写成阿拉伯数字。',
      '两处都必须**逐字引用**该章蓝图里的原文。引不出来就不要报。',
      '不确定就不要报——误报会让作者去找一个并不存在的矛盾。',
      '输出一个 JSON 对象：{"issues":[{"chapterNumber":<章号>,"firstQuote":"<原文>","secondQuote":"<原文>","explanation":"<一句话：同一件什么、两个什么值>"}]}',
      '没有就输出 {"issues":[]}。JSON 之外不要写任何解释。',
    ].join('\n')

  const chapterText = chapters.map(chapter => [
    en ? `### Plan for chapter ${chapter.chapterNumber}` : `### 第${chapter.chapterNumber}章蓝图`,
    String(chapter.text),
  ].join('\n')).join('\n\n')
  const user = en ? ['## Blueprints', chapterText].join('\n\n') : ['## 章节蓝图', chapterText].join('\n\n')
  return { system, user }
}

/**
 * 解析并校验模型输出（规则侧）。
 *
 * 四道收窄：坏 JSON → null；章号不在范围内 → 丢弃；
 * **两处引文都必须能在该章蓝图里逐字定位**（作者据此核对，且防止模型改写原文）；
 * 完全重复的那条去掉。
 */
export function parseBlueprintInternalReview(
  raw: string,
  request: Pick<BlueprintInternalReviewRequest, 'chapters' | 'recentChapters'>,
): BlueprintInternalIssue[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFence(String(raw ?? '').trim()))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const list = (parsed as { issues?: unknown }).issues
  if (!Array.isArray(list)) return null
  const limit = request.recentChapters ?? BLUEPRINT_INTERNAL_RECENT_CHAPTERS
  const byNumber = new Map([...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.text ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)
    .map(chapter => [chapter.chapterNumber, String(chapter.text)]))
  const result: BlueprintInternalIssue[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const chapterNumber = Number(record.chapterNumber)
    const firstQuote = String(record.firstQuote ?? '').trim()
    const secondQuote = String(record.secondQuote ?? '').trim()
    const body = byNumber.get(chapterNumber)
    if (!body) continue
    if (!firstQuote || !body.includes(firstQuote)) continue
    if (!secondQuote || !body.includes(secondQuote)) continue
    // 两处必须真的不同——同一条引用两次不是矛盾。
    if (firstQuote === secondQuote) continue
    const key = `${chapterNumber}:${firstQuote}:${secondQuote}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      chapterNumber,
      firstQuote,
      secondQuote,
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
 * ⚠️ 每章合并一条（#164 的教训）：同一章可能有多处自相矛盾，key 只含章号会撞车。
 * key 锚在章节上（章号是既成事实，不随写作滚动，与 #86/#89/#98/#108 的「当前章号」不同）。
 */
export function blueprintInternalFindings(issues: readonly BlueprintInternalIssue[]): ConsistencyFinding[] {
  const grouped = new Map<number, BlueprintInternalIssue[]>()
  for (const issue of issues) {
    const list = grouped.get(issue.chapterNumber) ?? []
    list.push(issue)
    grouped.set(issue.chapterNumber, list)
  }
  return [...grouped.entries()].map(([chapterNumber, list]) => {
    const pairs = list.map(item => `「${item.firstQuote}」vs「${item.secondQuote}」`).join('；')
    const explanations = list.map(item => item.explanation).filter(Boolean).join('；')
    return {
      stableFactKey: `blueprint:internal-contradiction:${chapterNumber}`,
      severity: 'warning' as const,
      sourceChapter: chapterNumber,
      evidence: `第${chapterNumber}章蓝图内部对同一件事给了两套值：${pairs}${explanations ? `（${explanations}）` : ''}`,
      issue: {
        zhCN: `本章蓝图**自己**对同一件具体事物写了两套不能同时成立的值：${pairs}。正文会照着蓝图写，于是同一个细节在章内出现两次、数字不同——而这类细节往往正是这一章的落幅所依赖的那一下（读者一旦对上，情绪就泄了）。${explanations ? `（${explanations}）` : ''}`,
        enUS: `This chapter's plan contradicts itself about one concrete thing: ${pairs}. The prose is written from the plan, so the same detail appears twice in one chapter with different values — and such details are often exactly what the chapter's closing beat rests on.${explanations ? ` (${explanations})` : ''}`,
      },
      suggestion: {
        zhCN: `二选一，别两处都改模棱两可：①**选一个值当权威**，把另一处按它统一（若「压三道」才是设定，就把前面那句改成「收完压三道」，或改成「收完压几道」之外的说法：只写「绕法认得」，不报数）；②**如果两处本来讲的是两件事**，就在第二处写清区别（哪一道是哪一道），不要让读者以为是同一个数。改完顺带核一下正文：蓝图这一处若是落幅支点，正文里那两句也得跟着统一。`,
        enUS: `Pick one value as authoritative and align the other phrase with it (or drop the number and describe the method instead), or — if the two mentions really are two different things — make the difference explicit so readers do not read them as the same number. Then check the prose: if this detail carries the closing beat, both mentions there have to match too.`,
      },
    }
  })
}