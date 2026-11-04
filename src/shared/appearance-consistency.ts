/**
 * 角色卡上的外观/身体描述与正文的对账（issue #153）——**由模型判断**。
 *
 * ## 为什么这里没有词表
 *
 * 本模块的第一版（已删除）写的是这样一套「封闭词类」：
 *
 * ```ts
 * const BODY_MARKERS = /缺|断|疤|伤|残|瘸|瞎|茧|墨垢/
 * const BODY_PARTS   = ['无名指','小指','拇指','食指','中指','虎口','肩','腿','脚','掌','手']
 * ```
 *
 * 它的理由听起来成立（「这些是封闭词类，不是短语表」），但用户 2026-11-05 明确否掉：
 *
 * > 「不要有这种写死的标记词……不要有任何写死的这种内容的逻辑。内容全让模型去处理，
 * >  你只负责让模型怎么去生成。」
 *
 * 这条判断更有力，理由有三：
 * 1. **词表只对这一本书成立**——「缺半节小指」换本书可能是「少了一截食指」「耳后一道刀痕」，
 *    换一种写法我的表就抽不出来（本仓 #30/#43/#70/#80/#93/#96/#99 反复吃过这个亏）；
 * 2. **词表会悄悄判错**——「从标记词往回找最近的部位」在「右手虎口留着一道旧疤」上是对的，
 *    但换个语序就会抽错对象，而我无法穷举中文写法；
 * 3. 模型本来就在这条链路上（起草、审稿都用它），让它判一次的成本远低于我维护一张表。
 *
 * ## 本模块只做「能断言的」四件事（与 `preflight-repair.ts` 同一分工）
 *
 * | 步骤 | 谁做 |
 * |---|---|
 * | 把哪些章、哪些角色卡喂进去 | **规则**（`buildAppearanceReviewPrompt`） |
 * | 要求返回什么形状（JSON 数组、字段白名单） | **规则**（同上 + `parseAppearanceReview`） |
 * | 判断「正文这一处与卡上描述是否相悖」 | **模型** |
 * | 是否采纳 | **作者**（差异/确认后落库，本模块不落库） |
 *
 * ⚠️ 只报**相悖**这一档（写反了、写成另一个人），不报「这一章没写到卡上的特征」：
 * 后者要判「哪个特征算显眼」，那同样是我判不了的（issue #153 第一部分）。
 * ⚠️ 模型必须给出**正文原句**作为证据；给不出就不报。
 */

/** 喂给模型的一章正文。 */
export interface AppearanceReviewChapter {
  chapterNumber: number
  content: string
}

/** 角色卡上可能与被正文写反的描述。字段名与原卡一致。 */
export interface AppearanceReviewCard {
  name: string
  appearance: string
  notes?: string
}

export interface AppearanceReviewRequest {
  chapters: readonly AppearanceReviewChapter[]
  cards: readonly AppearanceReviewCard[]
  /** 最多检查多少章（越靠后的章越重要：那是作者刚写完的）。 */
  recentChapters?: number
  language: 'zh-CN' | 'en-US'
}

/** 章数上限的默认值：与其它「读已定稿正文」的判据同一量级（16~20 章）。 */
export const APPEARANCE_REVIEW_RECENT_CHAPTERS = 20

/** 模型给出的**一处**相悖。 */
export interface AppearanceContradiction {
  /** 角色的精确名字（必须在传入的卡里）。 */
  characterName: string
  /** 落在哪一章（必须在传入的章节范围内）。 */
  chapterNumber: number
  /** 正文里与卡上相悖的那一句（逐字）。 */
  quote: string
  /** 模型对「卡上说什么、正文说什么」的一句说明。 */
  explanation: string
}

/** 组装提示词（规则侧，纯函数，可直测）。 */
export function buildAppearanceReviewPrompt(
  request: AppearanceReviewRequest,
): { system: string, user: string } {
  const en = request.language === 'en-US'
  const limit = request.recentChapters ?? APPEARANCE_REVIEW_RECENT_CHAPTERS
  const chapters = [...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)
  const cards = request.cards.filter(card => String(card.name ?? '').trim()
    && `${card.appearance ?? ''}${card.notes ?? ''}`.trim())

  const system = en
    ? [
      'You check whether a chapter contradicts a character card’s description of how that character looks.',
      'Report ONLY a contradiction: the prose says something that cannot be true together with the card',
      '(a mark on the other side, a different body part, a different number, a description that belongs to someone else).',
      'Do NOT report a chapter that merely fails to mention a detail — silence is not a contradiction.',
      'Every report must quote the exact sentence from the chapter. If you cannot quote it, do not report it.',
      'Output one JSON object: {"contradictions":[{"characterName":"<exact name from the cards>","chapterNumber":<n>,"quote":"<exact sentence from that chapter>","explanation":"<one sentence: what the card says vs what the prose says>"}]}',
      'If nothing contradicts, output {"contradictions":[]}. No commentary outside the JSON.',
    ].join('\n')
    : [
      '你的任务是核对：正文有没有**与角色卡的外观/身体描述相悖**的地方。',
      '只报**相悖**——正文与卡上的说法不能同时成立（记在另一侧、换了一个部位、数目不同、把别人的描述安到了这个人身上）。',
      '**不要**报「这一章没有提到卡上的某个细节」——没写不等于写错。',
      '每条都必须**逐字引用正文里的一句**。引不出来就不要报。',
      '输出一个 JSON 对象：{"contradictions":[{"characterName":"<卡上的精确名字>","chapterNumber":<章号>,"quote":"<该章正文里的原句>","explanation":"<一句话说明：卡上说什么、正文说什么>"}]}',
      '没有相悖时输出 {"contradictions":[]}。JSON 之外不要写任何解释。',
    ].join('\n')

  const cardText = cards.map(card => [
    `### ${card.name}`,
    en ? `Appearance: ${String(card.appearance ?? '').trim()}` : `外观：${String(card.appearance ?? '').trim()}`,
    String(card.notes ?? '').trim() ? (en ? `Notes: ${String(card.notes).trim()}` : `补充：${String(card.notes).trim()}`) : '',
  ].filter(Boolean).join('\n')).join('\n\n')

  const chapterText = chapters.map(chapter => [
    en ? `### Chapter ${chapter.chapterNumber}` : `### 第${chapter.chapterNumber}章`,
    String(chapter.content),
  ].join('\n')).join('\n\n')

  const user = en
    ? ['## Character cards', cardText, '## Chapters to check (only the recent ones matter)', chapterText].join('\n\n')
    : ['## 角色卡', cardText, '## 要核对的章节（只有最近这些重要）', chapterText].join('\n\n')
  return { system, user }
}

/**
 * 解析并校验模型输出（规则侧，纯函数）。
 *
 * 五道收窄，全部是「能断言」的（与 `parseRepairPatch` 同一纪律）：
 * - 不是合法 JSON → null（调用方当成一次失败，不静默采纳）；
 * - 形状不对（不是 `{contradictions: [...]}`）→ null；
 * - `characterName` 不在传入的卡里 → 丢弃该条（模型编了个人名）；
 * - `chapterNumber` 不在传入的章节里 → 丢弃；
 * - `quote` 在该章正文里找不到逐字匹配 → 丢弃（引文必须能定位，否则作者无法核对）。
 */
export function parseAppearanceReview(
  raw: string,
  request: Pick<AppearanceReviewRequest, 'chapters' | 'cards' | 'recentChapters'>,
): AppearanceContradiction[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFence(String(raw ?? '').trim()))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const list = (parsed as { contradictions?: unknown }).contradictions
  if (!Array.isArray(list)) return null
  const limit = request.recentChapters ?? APPEARANCE_REVIEW_RECENT_CHAPTERS
  const chapters = [...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)
  const byNumber = new Map(chapters.map(chapter => [chapter.chapterNumber, String(chapter.content)]))
  const names = new Set(request.cards.map(card => String(card.name ?? '').trim()).filter(Boolean))
  const result: AppearanceContradiction[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const characterName = String(record.characterName ?? '').trim()
    const chapterNumber = Number(record.chapterNumber)
    const quote = String(record.quote ?? '').trim()
    const explanation = String(record.explanation ?? '').trim()
    if (!names.has(characterName)) continue
    if (!Number.isSafeInteger(chapterNumber)) continue
    const body = byNumber.get(chapterNumber)
    if (!body) continue
    if (!quote || !body.includes(quote)) continue
    const key = `${chapterNumber}:${characterName}:${quote}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ characterName, chapterNumber, quote, explanation })
  }
  return result
}

/** 去掉 ```json 围栏（模型常加，不影响语义）。 */
function stripFence(value: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(value)
  return fenced ? fenced[1]! : value
}