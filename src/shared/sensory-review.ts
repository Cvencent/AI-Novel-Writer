/**
 * 「感官通道覆盖」——由**模型判断**（issue #151 的规则修正，用户 2026-11-05）。
 *
 * ## 为什么这里没有词表
 *
 * 第一版（已删除）是这样数的：
 *
 * ```ts
 * const SMELL_WORDS = ['腥气','铁腥','血腥','霉味','霉气','墨味',…]
 * const TASTE_WORDS = ['尝了尝','舔了舔','咸味','发苦',…]
 * const SOUND_WORDS = ['吱呀','咔嚓','哐当','砰','哗啦',…]
 * ```
 *
 * 用户 2026-11-05 明确否掉这一整类做法：
 *
 * > 「不要有任何那个内容上的文字类的写死的判断逻辑，不能去设计词表，也不能用任何的短语匹配，
 * >  就是不能有这类的逻辑，内容类的全部让模型判断。」
 *
 * 这条判断是对的，而且我自己的实测就给了反证：「一炷香」是计时器不是气味、
 * 「叮嘱」不是拟声、「锁舌咬得不紧」不是味觉、「他何尝不想」不是尝——**每一条都是我事后补的补丁**，
 * 而中文里还有无数种我没想到的写法。判断「这一段有没有写气味」是要理解内容的，只能交模型。
 *
 * ## 本模块只做三件能断言的事
 *
 * | 步骤 | 谁做 |
 * |---|---|
 * | 喂哪几章、要什么 JSON 形状 | **规则**（`buildSensoryReviewPrompt`） |
 * | 答案能不能核对（章号在范围内、序号合法） | **规则**（`parseSensoryReview`） |
 * | 「这一章有没有嗅觉/味觉/环境音」 | **模型** |
 * | 要不要据此改稿 | **作者** |
 *
 * ⚠️ 提示词里必须写「只按正文实际写到的判断；诗意的比喻不算闻到；不确定就说不确定」——
 * 否则模型会把「提到气味这个词」当成「写了气味」，与词表犯同一个错。
 */

export interface SensoryReviewChapter {
  chapterNumber: number
  content: string
}

/** 模型对**一章**的判断。 */
export interface SensoryChapterVerdict {
  chapterNumber: number
  smell: boolean
  taste: boolean
  sound: boolean
}

export interface SensoryReviewRequest {
  chapters: readonly SensoryReviewChapter[]
  recentChapters?: number
  language: 'zh-CN' | 'en-US'
}

/** 默认只看最近这么多章：这是「这一段读起来干不干」，不是全书统计。 */
export const SENSORY_REVIEW_RECENT_CHAPTERS = 20

/** 组装提示词（规则侧，纯函数，可直测）。 */
export function buildSensoryReviewPrompt(request: SensoryReviewRequest): { system: string, user: string } {
  const en = request.language === 'en-US'
  const limit = request.recentChapters ?? SENSORY_REVIEW_RECENT_CHAPTERS
  const chapters = [...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)

  const system = en
    ? [
      'For each chapter, say whether the prose ACTUALLY uses each of three channels: smell, taste, ambient sound.',
      'Judge only what the text does on the page. A figure of speech does not count (saying something "smelled of lies" is not a smell).',
      'A word that merely contains a sense character does not count either (a timekeeping stick is not a smell; "urge someone" is not a sound).',
      'If a chapter does not clearly use a channel, mark it false. Do not guess generously.',
      'Output one JSON object: {"chapters":[{"chapterNumber":<n>,"smell":true|false,"taste":true|false,"sound":true|false}]}',
      'Include exactly one entry per chapter given. No commentary outside the JSON.',
    ].join('\n')
    : [
      '逐章判断：这一章的正文**真的**用了以下哪几个通道——嗅觉、味觉、环境音。',
      '只按正文实际写到的判断。**比喻不算**（「像是谎言的气味」不是闻到）。',
      '只是**字面上含某个字**也不算（「一炷香」是计时不是气味；「叮嘱」不是拟声；「锁舌咬得不紧」不是味觉；「何尝不想」不是尝）。',
      '如果这一章没有明确用到某个通道，就填 false。不要为了显得宽容而填 true。',
      '输出一个 JSON 对象：{"chapters":[{"chapterNumber":<章号>,"smell":true|false,"taste":true|false,"sound":true|false}]}',
      '给定的每一章都要有一条，不多不少。JSON 之外不要写任何解释。',
    ].join('\n')

  const chapterText = chapters.map(chapter => [
    en ? `### Chapter ${chapter.chapterNumber}` : `### 第${chapter.chapterNumber}章`,
    String(chapter.content),
  ].join('\n')).join('\n\n')
  const user = en
    ? ['## Chapters', chapterText].join('\n\n')
    : ['## 章节正文', chapterText].join('\n\n')
  return { system, user }
}

/**
 * 解析并校验模型输出（规则侧，纯函数）。
 *
 * 四道收窄，全部「能断言」：
 * - 坏 JSON / 形状不对 → null（调用方报一次失败，不静默采纳）；
 * - 章号不在**送进去的那几章**里 → 丢弃该条（模型数错章）；
 * - 三个字段都必须**显式是布尔**（缺一个就丢弃这一章，不猜）；
 * - 同章重复 → 只留第一条。
 */
export function parseSensoryReview(
  raw: string,
  request: Pick<SensoryReviewRequest, 'chapters' | 'recentChapters'>,
): SensoryChapterVerdict[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFence(String(raw ?? '').trim()))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const list = (parsed as { chapters?: unknown }).chapters
  if (!Array.isArray(list)) return null
  const limit = request.recentChapters ?? SENSORY_REVIEW_RECENT_CHAPTERS
  const allowed = new Set([...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)
    .map(chapter => chapter.chapterNumber))
  const result: SensoryChapterVerdict[] = []
  const seen = new Set<number>()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const chapterNumber = Number(record.chapterNumber)
    if (!Number.isSafeInteger(chapterNumber) || !allowed.has(chapterNumber) || seen.has(chapterNumber)) continue
    if (typeof record.smell !== 'boolean' || typeof record.taste !== 'boolean' || typeof record.sound !== 'boolean') continue
    seen.add(chapterNumber)
    result.push({ chapterNumber, smell: record.smell, taste: record.taste, sound: record.sound })
  }
  return result.sort((left, right) => left.chapterNumber - right.chapterNumber)
}

/** 去掉 ```json 围栏（模型常加，不影响语义）。 */
function stripFence(value: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(value)
  return fenced ? fenced[1]! : value
}

/**
 * 「这一段几乎没有气味」的判据（**只做算术**，判断在模型那一侧）。
 *
 * 阈值仍取 0.3：受测两本语料分别是 14% 与 17%（那时候是用词表数的，数字本身仍成立），
 * 0.3 是它们的两倍左右、不贴噪声线。它现在是「模型判定为真的章占比」的下限。
 */
export const SMELL_CHAPTER_SHARE_FLOOR = 0.3

/** 至少要有这么多章才判（样本不足时占比没有意义）。 */
export const SENSORY_MIN_CHAPTERS = 8

export interface SensoryVerdictSummary {
  total: number
  smellChapters: number[]
  tasteChapters: number[]
  soundChapters: number[]
  silentChapters: number[]
  /** 模型判定「有嗅觉」的章占比。 */
  smellShare: number
  /** 是否低于地板（= 这一段几乎没有气味）。 */
  sparse: boolean
}

/** 纯算术汇总（可直测，不含任何内容判断）。 */
export function summarizeSensoryVerdicts(
  verdicts: readonly SensoryChapterVerdict[],
  options: { floor?: number; minChapters?: number } = {},
): SensoryVerdictSummary {
  const floor = options.floor ?? SMELL_CHAPTER_SHARE_FLOOR
  const minChapters = options.minChapters ?? SENSORY_MIN_CHAPTERS
  const total = verdicts.length
  const smellChapters = verdicts.filter(item => item.smell).map(item => item.chapterNumber)
  const tasteChapters = verdicts.filter(item => item.taste).map(item => item.chapterNumber)
  const soundChapters = verdicts.filter(item => item.sound).map(item => item.chapterNumber)
  const silentChapters = verdicts
    .filter(item => !item.smell && !item.taste && !item.sound)
    .map(item => item.chapterNumber)
  const smellShare = total === 0 ? 0 : smellChapters.length / total
  return {
    total,
    smellChapters,
    tasteChapters,
    soundChapters,
    silentChapters,
    smellShare,
    sparse: total >= minChapters && smellShare < floor,
  }
}