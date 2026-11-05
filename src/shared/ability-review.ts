import type { ConsistencyFinding } from './consistency-preflight'

/**
 * 「世界观写死的限制有没有被正文绕过」——由**模型判断**（issue #163，用户 2026-11-05 规则）。
 *
 * ## 为什么这里没有词表
 *
 * 旧实现是这个形状（注释还写着「判据**不写题材词表**」）：
 *
 * ```ts
 * const RESTRICTED_VENUE = /(账房|办公室|售票亭|售票口|外廊|茶桌|后街|库房|档案房|柜台|铺子|市集…)/u
 * const CANONICAL_VENUE  = /(船舱|舱内|舱里|舱底|舱口|舷|舵|水隔|跳板|甲板|船尾|船头|铺位|隔板…)/u
 * const ABILITY_SUCCESS  = /(墨(?:翻|浮)上?来|浮出来|浮出|浮起|读出|半边浮|笔画浮|字浮)/u
 * ```
 *
 * 「账房／售票口／柜台／铺子」（换本书的场所）与「墨浮上来」（这本书的能力表现）都是**题材词**：
 * 换一本「能力是听见残响、场地是医院走廊／停尸房」的书，这些正则全部静默——
 * 而静默在预检里与「没问题」不可区分。
 *
 * ## 分工（与 `appearance-consistency.ts` / `sensory-review.ts` / `content-review.ts` 一致）
 *
 * | 步骤 | 谁做 |
 * |---|---|
 * | 从世界观里取**限制原文**、喂哪些章 | **规则**（本模块的取数 + `buildAbilityReviewPrompt`） |
 * | 要什么 JSON 形状、章号/引文能否核对 | **规则**（`parseAbilityReview`） |
 * | 「这一处成功用能力有没有违反那条限制」 | **模型** |
 * | 采纳 | **作者** |
 *
 * ⚠️ 限制原文必须是**世界观里真的写着**的句子（`LIMIT_SENTENCE` 只做「取含限制语素的句子」这种
 * **位置**判断，不判断限制内容本身）；取不到就不判——没有声明过的规则无所谓被绕过。
 */

export interface AbilityReviewChapter {
  chapterNumber: number
  content: string
}

/**
 * 从世界观文本里取**可能声明了限制**的句子。
 *
 * ⚠️ 这一步只做「挑候选句」，**不判断限制是什么**：判据是把这些句子原样交给模型，
 * 由它回答「正文里有没有违反」。因此这里只用**结构位置**（含否定/条件/衰减类语素的句子）
 * 做筛选，属于「减少 token」而非「下判断」。
 */
const LIMIT_CUE = /(?:不|无法|不能|失去|失效|衰减|为零|除非|只有|一旦|否则)/u

/**
 * **取数上限（字符数，不是句数）**——issue #171。
 *
 * 旧实现是 `slice(0, 8)`：按**文本顺序**取前 8 句，等于「世界观开头写了什么就判什么」。
 * 实测那本书 3480 字世界观里，唯一一条能力硬限制（触发条件／失效条件）在候选里排**第 11 位**，
 * 从没进过提示词；喂进去的 8 句有 4 句是制度简介、1 句是 Markdown 小标题、2 句是加粗残句。
 * 模型手上只剩另一条限制可当依据，于是把 10 处「明明先写了洇湿」的溯读全判成绕过。
 *
 * 改成按**字符预算**取，且**不再按顺序丢句**：世界观在这个量级（2–4k 字）本来就该全给——
 * 这个预算能覆盖约 12k 字，相对本章正文可以忽略。顺序截断的失败方式是**静默**的
 * （模型不报错，只是拿不到那条限制），所以宁可给多、让模型自己挑，也不替它决定哪几句重要。
 */
export const ABILITY_LIMIT_MAX_CHARS = 12_000

/**
 * Markdown 结构性残句：标题行、纯加粗短语、分隔线（issue #171 实测 8 句里 3 句是这类）。
 *
 * 它们被切句切成「### 2. 规则漏洞："湿票不入底"」「**名字**：……」这种片段——不是限制，
 * 却占掉原本给限制的名额。判据只看**形态**（行首标记、去掉符号后剩不下实质内容），不看词义。
 */
function isStructuralFragment(sentence: string): boolean {
  if (/^#{1,6}\s/u.test(sentence)) return true
  if (/^[-*_]{3,}$/u.test(sentence)) return true
  const bare = sentence.replace(/[*`#>\-_"'“”「」『』：:，,。．.\s]/gu, '')
  return bare.length < 4
}

export function limitSentencesOf(worldbuilding: string): string[] {
  const picked: string[] = []
  let used = 0
  for (const raw of String(worldbuilding ?? '').split(/(?<=[。！？\n])/u)) {
    const sentence = raw.trim()
    if (sentence.length < 6) continue
    if (isStructuralFragment(sentence)) continue
    if (!LIMIT_CUE.test(sentence)) continue
    if (used + sentence.length > ABILITY_LIMIT_MAX_CHARS) break
    used += sentence.length
    picked.push(sentence)
  }
  return picked
}

export interface AbilityReviewIssue {
  chapterNumber: number
  quote: string
  /** 违反的是哪一条限制（模型从给的限制句里挑，或复述）。 */
  violatedLimit: string
  explanation: string
}

export interface AbilityReviewRequest {
  limits: readonly string[]
  chapters: readonly AbilityReviewChapter[]
  recentChapters?: number
  language: 'zh-CN' | 'en-US'
}

export const ABILITY_REVIEW_RECENT_CHAPTERS = 20

export function buildAbilityReviewPrompt(request: AbilityReviewRequest): { system: string, user: string } {
  const en = request.language === 'en-US'
  const limit = request.recentChapters ?? ABILITY_REVIEW_RECENT_CHAPTERS
  const chapters = [...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)

  const system = en
    ? [
      'You are given the limits the author wrote into the worldbuilding, and some chapters.',
      'Report ONLY places where the prose shows the ability succeeding in a way those limits forbid.',
      'Do not report a chapter that merely fails to mention the limit — silence is not a violation.',
      // issue #171：限制多数是**条件式**的（「靠岸且干燥之后」才失效）。前置条件不成立时，
      // 正文里能力成功**不是**绕过——而那本书 10 条误报全部是这一形态。
      'Most limits are CONDITIONAL: read the condition in the quoted limit, then check whether the prose actually satisfies it.',
      'If the prose shows the condition failing to hold (the paper was wetted again, the character was still aboard), the ability succeeding is NOT a violation.',
      'Do not invent limits: quote one from the list you were given.',
      'Every report must quote the exact sentence from that chapter. If you cannot quote it, do not report it.',
      'If the prose shows the character supplying the missing condition themselves, say so in the explanation — that is the same violation.',
      'Output one JSON object: {"issues":[{"chapterNumber":<n>,"quote":"<exact sentence>","violatedLimit":"<one of the limits>","explanation":"<one sentence>"}]}',
      'If nothing violates, output {"issues":[]}. No commentary outside the JSON.',
    ].join('\n')
    : [
      '下面是作者写进世界观里的**限制**，以及要核对的章节正文。',
      '只报**正文明确写出了「限制之下能力仍然成功」**的地方。',
      '不要报「这一章没有提到那条限制」——没写不等于绕过。',
      // issue #171：10 条误报全部出在这一条上——限制写的是「靠岸且干燥之后」，
      // 而正文每次都先写了纸面被洇湿（条件不成立），溯读成功并不绕过限制。
      '细读限制里的**条件**：多数限制是条件式的（「靠岸且干燥之后才失效」「离船上岸才衰减」）。',
      '**前置条件不成立时，能力成功不算绕过**——正文若写明条件并未满足（纸又被洇湿、人还在船上），那是符合限制的，不要报。',
      '不要自己造限制：`violatedLimit` 必须来自给你的限制清单。',
      '每条都必须**逐字引用**该章正文里的一句。引不出来就不要报。',
      '如果正文里是角色**自己补上了缺失的条件**（自带水／换到别处／临时借用），要在 explanation 里写出来——那同样算绕过。',
      '输出一个 JSON 对象：{"issues":[{"chapterNumber":<章号>,"quote":"<原句>","violatedLimit":"<来自限制清单的一条>","explanation":"<一句话>"}]}',
      '没有就输出 {"issues":[]}。JSON 之外不要写任何解释。',
    ].join('\n')

  const limitText = request.limits.map((item, index) => `${index + 1}. ${item}`).join('\n')
  const chapterText = chapters.map(chapter => [
    en ? `### Chapter ${chapter.chapterNumber}` : `### 第${chapter.chapterNumber}章`,
    String(chapter.content),
  ].join('\n')).join('\n\n')
  const user = en
    ? ['## Declared limits', limitText, '## Chapters', chapterText].join('\n\n')
    : ['## 世界观里声明的限制', limitText, '## 章节正文', chapterText].join('\n\n')
  return { system, user }
}

/**
 * 解析并校验模型输出（规则侧）。
 *
 * 四道收窄：坏 JSON → null；章号不在送进去的范围里 → 丢弃；
 * **引文必须在该章正文里逐字存在** → 否则丢弃（作者据此定位）；
 * `violatedLimit` 必须能在给的限制里找到（否则模型在编限制）。
 */
export function parseAbilityReview(
  raw: string,
  request: Pick<AbilityReviewRequest, 'limits' | 'chapters' | 'recentChapters'>,
): AbilityReviewIssue[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFence(String(raw ?? '').trim()))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const list = (parsed as { issues?: unknown }).issues
  if (!Array.isArray(list)) return null
  const limit = request.recentChapters ?? ABILITY_REVIEW_RECENT_CHAPTERS
  const byNumber = new Map([...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)
    .map(chapter => [chapter.chapterNumber, String(chapter.content)]))
  const limits = request.limits.map(item => String(item).trim()).filter(Boolean)
  const result: AbilityReviewIssue[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const chapterNumber = Number(record.chapterNumber)
    const quote = String(record.quote ?? '').trim()
    const violatedLimit = String(record.violatedLimit ?? '').trim()
    if (!Number.isSafeInteger(chapterNumber) || !byNumber.has(chapterNumber)) continue
    const body = byNumber.get(chapterNumber)!
    if (!quote || !body.includes(quote)) continue
    if (!violatedLimit || !limits.some(item => item === violatedLimit || item.includes(violatedLimit) || violatedLimit.includes(item))) continue
    const key = `${chapterNumber}:${quote}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ chapterNumber, quote, violatedLimit, explanation: String(record.explanation ?? '').trim() })
  }
  return result
}

function stripFence(value: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(value)
  return fenced ? fenced[1]! : value
}

/** 把模型判出的「限制被绕过」转成一致性发现。 */
export function abilityReviewFindings(issues: readonly AbilityReviewIssue[]): ConsistencyFinding[] {
  return issues.map(issue => ({
    // 章号是既成事实；不带当前章（#86/#89/#98/#108）。
    stableFactKey: `ability:limit-bypassed:${issue.chapterNumber}`,
    severity: 'warning' as const,
    sourceChapter: issue.chapterNumber,
    evidence: `第${issue.chapterNumber}章：「${issue.quote}」（世界观写的限制：${issue.violatedLimit}）`,
    issue: {
      zhCN: `世界观写死的限制在正文里被绕过了：作者声明「${issue.violatedLimit}」，而第${issue.chapterNumber}章的正文写「${issue.quote}」——${issue.explanation || '这一处在限制之下仍然成功。'}。限制一旦被静默绕过，后面每次「能力有代价」的紧张感都会打折：读者第一次看到有人凭空破了规矩，就会怀疑规矩还管不管用。`,
      enUS: `A limit declared in the worldbuilding is bypassed on the page: the author wrote “${issue.violatedLimit}”, but chapter ${issue.chapterNumber} says “${issue.quote}” — ${issue.explanation || 'the ability succeeds under conditions the limit forbids.'} Once a limit is silently bypassed, every later cost loses its weight.`,
    },
    suggestion: {
      zhCN: `二选一：① 让这一次**付出代价**再成功（角色自己补上缺失条件的过程要写出来，并且花掉别的东西）；② 若这条限制已不打算要了，就回去**改世界观**与相关伏笔，别让章程和正文各说一套。`,
      enUS: `Either make this instance pay first (show the character supplying the missing condition and spending something for it), or, if the limit is no longer wanted, go back and change the worldbuilding and its foreshadowing so the rule and the prose agree.`,
    },
  }))
}