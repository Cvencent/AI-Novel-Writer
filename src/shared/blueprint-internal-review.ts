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
  /** 缺省按 `value-contradiction` 解析（旧模型输出不带这个字段）。 */
  kind?: BlueprintInternalKind
  /** 两处互斥表述的原文（都必须能在该章蓝图里逐字找到）。 */
  firstQuote: string
  secondQuote: string
  explanation: string
}

/**
 * 这一档要模型回答的**两类**问题（issue #172 现场是第一类；#222 补第二类）。
 *
 * 第二类是「互斥处置」：同一章蓝图让一方**拒绝收下某物或声明它不能入卷**，
 * 又让这物**被收下、封存或随卷带走**，中间没有任何一句解除该障碍。
 * 现场（bp99）：「文书员收下旁证**却说**无实物佐证**不能入卷**……这张纸往下跟着卷走」——
 * 「收下」与「不能入卷」压在同一句里，起草模型照抄，读者读不出旁证到底进没进卷。
 * 判断「这两个处置能不能同时成立」要读懂句子，交模型；规则只校验引文可定位。
 */
export const BLUEPRINT_INTERNAL_KINDS = {
  'value-contradiction': {
    zhCN: '同一件具体事物被写成两个不相容的值',
    enUS: 'one concrete thing is given two incompatible values',
  },
  'exclusive-disposition': {
    zhCN: '同一件物被同时写成「拒收/不能入卷」与「收下/随卷走」',
    enUS: 'an item is both refused as inadmissible and accepted into the record in the same chapter',
  },
} as const

export type BlueprintInternalKind = keyof typeof BLUEPRINT_INTERNAL_KINDS

export const BLUEPRINT_INTERNAL_KIND_IDS = Object.freeze(Object.keys(BLUEPRINT_INTERNAL_KINDS) as BlueprintInternalKind[])

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
      'Report ONLY cases where ONE chapter\'s own plan contradicts itself. Two kinds count:',
      'Kind 1 (value contradiction): the same object, gesture, procedure or quantity is described with two incompatible values',
      '(one press vs three presses, two people vs three, left hand vs right hand, before dawn vs after noon).',
      'Two mentions of the same thing that agree are fine. Two different things that happen to share a word are NOT a conflict.',
      'Kind 2 (exclusive disposition): one party refuses to accept an item or declares it inadmissible ("cannot be filed without X"),',
      'and the same chapter also has that item accepted, sealed, or carried off into the record — with no line in between lifting the obstacle',
      '(the condition met, the ruling changed, or the item explicitly filed as an attachment rather than evidence).',
      'The question "did it ever enter the file" is usually the whole point of that scene; an unanswered one is the defect.',
      'For kind 2 quote the refusal and the acceptance verbatim; they must both be in the same chapter\'s plan.',
      'Do NOT compare across chapters — each report must concern a single chapter.',
      'Judge by meaning, not by a fixed word list or number pattern: the number may be written in words or digits.',
      'Quote both phrases verbatim from that chapter\'s plan. If you cannot quote both, do not report.',
      'If unsure, do not report — a false alarm makes the author hunt for a contradiction that is not there.',
      'Output one JSON object: {"issues":[{"kind":"value-contradiction|exclusive-disposition","chapterNumber":<n>,"firstQuote":"<exact words>","secondQuote":"<exact words>","explanation":"<one sentence: which concrete thing, which two values/dispositions>"}]}',
      'If nothing conflicts, output {"issues":[]}. No commentary outside the JSON.',
    ].join('\n')
    : [
      '下面是章节蓝图（正文照着它写）。',
      '只报**同一章蓝图自己**与自己矛盾的地方。两类都算：',
      '第一类（数值矛盾）：同一件物、同一个动作、同一道工序或同一个数量，被写成两个不相容的值（压一道 vs 压三道、两个人 vs 三个人、左手 vs 右手、天亮前 vs 午后）。',
      '同一件事被提两次而说法一致，不算；两件不同的事恰好共用一个词，也不算。',
      '第二类（互斥处置）：一方拒绝收下某物、或声明它「没有 X 不能入卷」，同一章又让这物被收下、封存或随卷带走——中间没有任何一句解除该障碍（条件被满足、口径被改、或写明这物只作附卷不作证据）。',
      '「这物到底进没进卷」往往正是那一场戏的全部目的；没人回答它就是缺陷。',
      '第二类要逐字引用「拒绝/声明」与「收下/带走」两处，且都必须在同一章蓝图里。',
      '**不要跨章比较**——每条都必须是同一章内部的问题。',
      '按**意思**判断，不要按固定词表或数字形式：数字可能写成汉字也可能写成阿拉伯数字。',
      '两处都必须**逐字引用**该章蓝图里的原文。引不出来就不要报。',
      '不确定就不要报——误报会让作者去找一个并不存在的矛盾。',
      '输出一个 JSON 对象：{"issues":[{"kind":"value-contradiction|exclusive-disposition","chapterNumber":<章号>,"firstQuote":"<原文>","secondQuote":"<原文>","explanation":"<一句话：同一件什么、哪两个值/哪两个处置>"}]}',
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
    const kind = asBlueprintInternalKind(record.kind)
    if (kind === null) continue
    const body = byNumber.get(chapterNumber)
    if (!body) continue
    if (!firstQuote || !body.includes(firstQuote)) continue
    if (!secondQuote || !body.includes(secondQuote)) continue
    // 两处必须真的不同——同一条引用两次不是矛盾。
    if (firstQuote === secondQuote) continue
    const key = `${kind}:${chapterNumber}:${firstQuote}:${secondQuote}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      chapterNumber,
      kind,
      firstQuote,
      secondQuote,
      explanation: String(record.explanation ?? '').trim(),
    })
  }
  return result
}

/**
 * 模型给的 `kind` 必须是我们认识的两类之一；缺省按旧口径（`value-contradiction`），
 * 与历史输出兼容。未知值整条丢弃——宁可少报一条，也不要按错的种类给作者一段不合用的修法。
 */
function asBlueprintInternalKind(value: unknown): BlueprintInternalKind | null {
  const raw = String(value ?? '').trim()
  if (!raw) return 'value-contradiction'
  return (BLUEPRINT_INTERNAL_KIND_IDS as readonly string[]).includes(raw) ? raw as BlueprintInternalKind : null
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
    // 两类共用一个 key 族：key 锚在章节上（既成事实），同一章两类并存时合并在一条里
    // （#164：一章节一个判断一条，ack 不会埋掉没修的那类）。
    const hasExclusive = list.some(item => (item.kind ?? 'value-contradiction') === 'exclusive-disposition')
    const leadZh = hasExclusive
      ? `本章蓝图对同一件物写出了两个不能同时成立的处置——一方拒收/声明它不能入卷，它又被收下/随卷带走。读者读不出这物到底进没进卷，而那正是这一场戏要回答的。`
      : `本章蓝图**自己**对同一件具体事物写了两套不能同时成立的值。正文会照着蓝图写，于是同一个细节在章内出现两次、数字不同——而这类细节往往正是这一章的落幅所依赖的那一下（读者一旦对上，情绪就泄了）。`
    const leadEn = hasExclusive
      ? `This chapter's plan gives one item two dispositions that cannot both hold — one party refuses it as inadmissible while it is also accepted into the record. The reader cannot tell whether it ever entered the file, and that is the question the scene exists to answer.`
      : `This chapter's plan contradicts itself about one concrete thing. The prose is written from the plan, so the same detail appears twice in one chapter with different values — and such details are often exactly what the chapter's closing beat rests on.`
    return {
      stableFactKey: `blueprint:internal-contradiction:${chapterNumber}`,
      severity: 'warning' as const,
      sourceChapter: chapterNumber,
      evidence: `第${chapterNumber}章蓝图内部自相矛盾：${pairs}${explanations ? `（${explanations}）` : ''}`,
      issue: {
        zhCN: `${leadZh}${pairs}。${explanations ? `（${explanations}）` : ''}`,
        enUS: `${leadEn} ${pairs}.${explanations ? ` (${explanations})` : ''}`,
      },
      suggestion: {
        /**
         * issue #180：这里原来写死了本书样本（「若『压三道』才是设定，就把前面那句改成
         * 『收完压三道』…只写『绕法认得』，不报数」），于是**每一条** finding 的建议里都挂着
         * 那段绳结话——包括讲按字口供、讲油布包的那两条，作者照它去改根本无从下手。
         *
         * 现在改成**引用这一条 finding 自己的两处原文**，并按它们各自的形状给改法。
         * #222 第二类：障碍要么被解除、要么这物留在卷外——二选一，中间态最伤。
         */
        zhCN: hasExclusive
          ? `二选一，别让两个处置并排留在蓝图里：①**保留拒收**——「${list[0]!.firstQuote}」成立，那这一场就停在障碍上，把「它进没进卷」留成真正的悬念，后续章节要接；②**让障碍被解除**——在两处之间补一句怎么解除的（条件被满足、口径被改、或写明只作附卷不作证据），然后「${list[0]!.secondQuote}」才成立。正文已照蓝图写时，优先核对正文里有没有那句「解除」，没有就补或删。`
          : `二选一，别两处都改模棱两可：①**选一个值当权威**——在「${list[0]!.firstQuote}」与「${list[0]!.secondQuote}」里定一个，把另一处按它统一；②**如果两处本来讲的是两件事**，就在第二处写清区别，别让读者以为是同一个值。两边都不确定时，还有第三条最省事的路：**把那一处改成不报具体值的写法**（只说这件事发生了，不落在数字或处数上）。改完顺带核一下正文：蓝图这一处若是落幅支点，正文里那两句也得跟着统一。`,
        enUS: hasExclusive
          ? `Pick one disposition — do not leave both in the plan: either keep the refusal (“${list[0]!.firstQuote}”) and let the scene stop at that obstacle, leaving "did it enter the file" as a real open question for later chapters; or lift the obstacle between the two beats with one line (the condition was met, the ruling changed, or the item is filed as an attachment, not evidence) so that “${list[0]!.secondQuote}” becomes valid. If the prose already followed the plan, check first whether that lifting line exists there — add it or cut the crossing beat.`
          : `Pick one value as authoritative — choose between “${list[0]!.firstQuote}” and “${list[0]!.secondQuote}” and align the other occurrence with it; or, if the two mentions really are two different things, make the difference explicit so readers do not read them as the same value. When neither side is settled, the cheapest route is to drop the specific value from that spot entirely (say the thing happened without pinning a number). Then check the prose: if this detail carries the closing beat, both mentions there have to match too.`,
      },
    }
  })
}