import type { ConsistencyFinding } from './consistency-preflight'

/**
 * 「记得 / 想起」这类**记忆回指**有没有前文锚点——由**模型判断**（issue #167）。
 *
 * ## 现场
 *
 * 第 78 章：「他记得渔棚里的灯，记得温珩**摆手让他别停**。中间那一句，不在了。」
 *
 * 而全书 78 章里「摆手」只出现这一次、「别停」也只出现这一次；第 77 章温珩的动作是
 * 蹲着收网、把纸压回夹层、说「我带她走」，章末还明写「棚口空着」。
 * 也就是说：读者被要求回忆起一件**从未发生过**的护送动作，倒回去翻第 77 章找不到。
 *
 * ## 为什么这是机制缺口，而不是「模型写错了一句」
 *
 * 同一本书里同族句式（「他记得 A，记得 B，中间空了」）**是有锚点的**——
 * 抽查 12 条带「具名角色 + 动作」的，11 条能在同章上文或前章找到对应动作，
 * 只有这一条没有。所以「回指必须有锚点」本来就是这个产品在别处做到的事，
 * 只是**没有任何一层检查它**：审稿 17 维里没有这一条，账本把它当 `plot` 逐字收进去
 * （`chapter_commits.facts_json` 的 evidence 就是这句），下一章起草又会把它当摘要注入。
 *
 * ## 分工（与 `appearance-consistency` / `sensory-review` / `content-review` 同一形态）
 *
 * | 步骤 | 谁做 |
 * |---|---|
 * | 从本章正文里取出「记忆回指句」（句中出现记忆动词）、喂哪几章作为检索范围 | **规则** |
 * | 要什么 JSON 形状、章号/引文能否核对 | **规则** |
 * | 「这句记忆描述的动作在前文有没有发生」 | **模型** |
 * | 采纳 | **作者** |
 *
 * ⚠️ 取「记忆回指句」靠的是**记忆动词这一类**（记得/想起/回忆起/记不清…）——它是
 * **语法/功能类**（判断「这一句是不是在回指」），不是题材词表；而「所指的事情有没有发生」
 * 是内容判断，必须交模型。
 */

export interface MemoryCallbackChapter {
  chapterNumber: number
  content: string
}

/** 记忆动词（**功能类**）：出现即视为「这一句在回指某件已发生的事」。 */
const MEMORY_VERB = /(?:记得|想起|回忆起|想起来|记不清|记不得|忘了|忘记)/u

/** 切句（与其它判据同一口径）。 */
function sentencesOf(content: string): string[] {
  return String(content ?? '').split(/(?<=[。！？])|\n+/u).map(sentence => sentence.trim()).filter(Boolean)
}

/**
 * 「时间状语 + 事件」式回指（issue #175 建议 ③）——**形式类**，不是题材词。
 *
 * 现场（第 80 章）两句都是这一形态，而 `MEMORY_VERB` 一个都不认：
 *
 * ```
 * 周叙盯着放平的绳圈。昨晚在船舱口，他试打了几遍，最后一道收不紧。
 * 「停船那晚，」他忽然开口，嗓子哑，「他从货舱取了个油布包。」
 * ```
 *
 * 它们恰好是最容易与前文对不上的写法（「昨晚」指第 79 章章末那一场）。
 *
 * ⚠️ 这里只认**指向前文的时间标记**（相对日 / 序数日 / 完成态的「那晚」「当时」），
 * 与 `chapter-time-anchor.ts` 同一套形式类。它只决定「把哪一句喂给模型」，
 * 不判断「这件事在前文有没有发生」——那仍然是模型的活。
 */
const PAST_TIME_MARKER = /(?:昨晚|昨夜|昨天|前天|今早|今晨|那天|那晚|当晚|那一夜|那日|那年|头天|先前|早先|上一次|上回|前几天|前些天|此前|当时|过了?(?:一|两|二|三|几|数|半)?(?:夜|天|日|晚)|第[一二三四五六七八九十百千0-9]+(?:天|日|夜|回))/u

/**
 * 从一章里取出**回指句**（issue #167 的原始口径 + issue #175 的扩展）。
 *
 * 两类都收：
 * 1. 含**记忆动词**的句子；
 * 2. 含**指向前文的时间状语**的句子（「昨晚在船舱口，他试打了几遍」）。
 *
 * ⚠️ 只做**位置/形态**筛选（句长下限 + 上述两类标记），不判断这句话说的是不是真事。
 */
export function memoryCallbackSentences(chapterNumber: number, content: string): Array<{ chapterNumber: number, sentence: string }> {
  return sentencesOf(content)
    .filter(sentence => sentence.length >= 8 && (MEMORY_VERB.test(sentence) || PAST_TIME_MARKER.test(sentence)))
    .map(sentence => ({ chapterNumber, sentence }))
}

export interface MemoryCallbackIssue {
  /** 回指句所在的章。 */
  chapterNumber: number
  /** 回指句原文（必须能在该章正文里逐字找到）。 */
  quote: string
  /** 模型认为「所指的那件事」在前文找不到的具体描述。 */
  missingAnchor: string
  explanation: string
}

export interface MemoryAnchorRequest {
  /** 要检查的章（通常是最新一章；可给最近几章）。 */
  chapters: readonly MemoryCallbackChapter[]
  /** 作为**检索范围**的前文章（不含被检查章本身）。 */
  earlierChapters: readonly MemoryCallbackChapter[]
  language: 'zh-CN' | 'en-US'
  /** 前文最多喂多少字（防止长篇把上下文撑爆）。 */
  maxEarlierChars?: number
}

/**
 * 被检查的章数（issue #175 建议 ②）：回指可以指向任意前文，没理由只查上一章。
 *
 * 现场实测：81 个写作时点里只有 30 个（37%）的**上一章**含回指句，其余 51 个点一次
 * 模型调用都不发；而最近 21 个时点里只有 7 个能真跑。取最近 3 章能把「上一章没回指句」
 * 这一类空转挡掉大半——而检索范围（前文全量）本来就是喂进去的。
 */
export const MEMORY_ANCHOR_TARGET_CHAPTERS = 3

/** 前文喂入上限：约 12 万字符（≈ 六七十章 800 字正文）。 */
export const MEMORY_ANCHOR_MAX_EARLIER_CHARS = 120_000

export function buildMemoryAnchorPrompt(request: MemoryAnchorRequest): { system: string, user: string, callbacks: Array<{ chapterNumber: number, sentence: string }> } {
  const en = request.language === 'en-US'
  const callbacks = request.chapters.flatMap(chapter => memoryCallbackSentences(chapter.chapterNumber, chapter.content))
  const cap = request.maxEarlierChars ?? MEMORY_ANCHOR_MAX_EARLIER_CHARS
  // 由近及远保留（越近的章越可能是锚点所在），超限则截断并告知模型。
  const earlier = [...request.earlierChapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => right.chapterNumber - left.chapterNumber)
  let used = 0
  const kept: string[] = []
  for (const chapter of earlier) {
    const block = en ? `### Chapter ${chapter.chapterNumber}\n${chapter.content}` : `### 第${chapter.chapterNumber}章\n${chapter.content}`
    if (used + block.length > cap) break
    used += block.length
    kept.push(block)
  }

  const system = en
    ? [
      'You are given sentences that look BACKWARD — either a character remembering something, or a sentence anchored by a past time phrase ("last night", "the night the boat stopped") — and the earlier chapters.',
      // issue #175：取句口径含「时间状语 + 事件」，其中难免混入**将来**的句子（「开箱那天」）。
      // 将来不是回指——由模型判断，不写时间词表。
      'Some of these sentences may point FORWARD (something that will happen later). Do not report those; only look backward.',
      'For each remembered sentence, decide whether the thing being remembered actually happens in the earlier chapters.',
      'Report ONLY those memories whose described action, object, or scene cannot be found in the earlier chapters.',
      'A memory of something that happened in an earlier chapter is fine, even if it is described in different words — judge by meaning.',
      'A paraphrase counts as found. A memory that mixes real details in a way that never happened counts as not found.',
      'Every report must quote the remembering sentence verbatim and name what is missing.',
      'If unsure, do not report — a false alarm sends the author hunting for a scene that exists.',
      'Output one JSON object: {"issues":[{"chapterNumber":<n>,"quote":"<exact remembering sentence>","missingAnchor":"<what is remembered that never happened>","explanation":"<one sentence>"}]}',
      'If nothing is missing, output {"issues":[]}. No commentary outside the JSON.',
    ].join('\n')
    : [
      '下面是一组**指向前文**的句子（人物在回忆某件事，或句子带过去的时间状语，如「昨晚」「停船那晚」），以及前文章节正文。',
      // issue #175：取句口径含「时间状语 + 事件」，其中难免混入**将来**的句子（「开箱那天，页角印」）。
      // 将来不是回指——这条由模型判断，不写时间词表。
      '有些句子其实指向**将来**（后面才会发生的事）。那些不要报，只看指向过去的。',
      '逐句判断：**被回忆的那件事，在前文里真的发生过吗**。',
      '只报**在被检查章之前的章节正文里找不到**的那些回忆。',
      '前文里确实写过的回忆是对的——哪怕这一句换了措辞；**按意思判断，不按字面**。',
      '但「把几件真实细节拼成一件没发生过的事」算找不到。',
      '每条都必须**逐字引用**那一句回忆，并写明「回忆的是什么、前文找不到什么」。',
      '不确定就不要报——误报会让作者去翻一个其实存在的场景。',
      '输出一个 JSON 对象：{"issues":[{"chapterNumber":<章号>,"quote":"<那句回忆原文>","missingAnchor":"<被回忆却从未发生的事>","explanation":"<一句话>"}]}',
      '没有就输出 {"issues":[]}。JSON 之外不要写任何解释。',
    ].join('\n')

  const callbackText = callbacks.map(item => `- [第${item.chapterNumber}章] ${item.sentence}`).join('\n')
  const user = [
    en ? '## Remembering sentences' : '## 记忆回指句',
    callbackText,
    en ? '## Earlier chapters (search scope)' : '## 前文章节正文（检索范围）',
    kept.join('\n\n'),
    ...(kept.length < earlier.length
      ? [en
        ? `(Only the most recent ${kept.length} of ${earlier.length} earlier chapters are shown; assume the text before them was not provided.)`
        : `（只给了最近 ${kept.length} 章，共 ${earlier.length} 章；更早的内容未提供。）`]
      : []),
  ].join('\n\n')
  return { system, user, callbacks }
}

/**
 * 解析并校验模型输出（规则侧）。
 *
 * 四道收窄：坏 JSON → null；章号不在被检查的章里 → 丢弃；
 * **回指句必须能在该章正文里逐字找到** → 否则丢弃（作者据此定位）；
 * `missingAnchor` 为空 → 丢弃（没说出缺什么，等于没报）。
 */
export function parseMemoryAnchorReview(
  raw: string,
  request: Pick<MemoryAnchorRequest, 'chapters' | 'language'>,
): MemoryCallbackIssue[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFence(String(raw ?? '').trim()))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const list = (parsed as { issues?: unknown }).issues
  if (!Array.isArray(list)) return null
  const byNumber = new Map(request.chapters.map(chapter => [chapter.chapterNumber, String(chapter.content ?? '')]))
  const result: MemoryCallbackIssue[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const chapterNumber = Number(record.chapterNumber)
    const quote = String(record.quote ?? '').trim()
    const missingAnchor = String(record.missingAnchor ?? '').trim()
    if (!Number.isSafeInteger(chapterNumber) || !byNumber.has(chapterNumber)) continue
    if (!quote || !byNumber.get(chapterNumber)!.includes(quote)) continue
    if (!missingAnchor) continue
    const key = `${chapterNumber}:${quote}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ chapterNumber, quote, missingAnchor, explanation: String(record.explanation ?? '').trim() })
  }
  return result
}

function stripFence(value: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(value)
  return fenced ? fenced[1]! : value
}

/**
 * 把模型判出的「记忆无锚点」转成一致性发现。
 *
 * ⚠️ 每章合并成一条（与 `contentReviewFindings` 同一口径，issue #164 的教训）：
 * 同一章可能有多处无锚点的回忆，key 只含章号的话会撞车，ack 会静默掉没修的那条。
 */
export function memoryAnchorFindings(issues: readonly MemoryCallbackIssue[]): ConsistencyFinding[] {
  const grouped = new Map<number, MemoryCallbackIssue[]>()
  for (const issue of issues) {
    const list = grouped.get(issue.chapterNumber) ?? []
    list.push(issue)
    grouped.set(issue.chapterNumber, list)
  }
  return [...grouped.entries()].map(([chapterNumber, list]) => {
    const quotes = list.map(item => `「${item.quote}」`).join('、')
    const missing = list.map(item => item.missingAnchor).join('；')
    return {
      // 章号是既成事实；合并后天然唯一（#164 的教训）。
      stableFactKey: `prose:memory-anchor-missing:${chapterNumber}`,
      severity: 'warning' as const,
      sourceChapter: chapterNumber,
      evidence: `第${chapterNumber}章 ${list.length} 处回忆在前文找不到对应：${missing}（原文${quotes}）`,
      issue: {
        zhCN: `本章让人物回忆起一件**前文没发生过**的事：${missing}（原文${quotes}）。读者会去翻前面找这一幕，找不到时的第一反应是「我看漏了？」——这是长篇里最伤信任的一种错；而账本还会把这句当成事实收进去，下一章起草时当成最近摘要注入，错误开始复利。`,
        enUS: `This chapter has the character remember something that never happened earlier: ${missing} (${quotes}). Readers will page back to find that scene; when they cannot, they assume they missed it — the most trust-damaging kind of error in a long book, and the fact ledger will carry it forward as a recent summary.`,
      },
      suggestion: {
        zhCN: `二选一：① 把这一处回忆换成**前文真的写过**的细节（同一场景里的另一个动作、另一件物、另一个人说的话）；② 若这次回忆本来就是本章新交代的，就别用「记得」这个句式——直接写成当事人在这一章说出口。改完顺带看一眼蓝图 costsAndTurns 里写的「这次忘掉的是什么」：正文忘掉的东西要和它对得上。`,
        enUS: `Either replace this memory with a detail that really was written earlier (another action, another object, another line in the same scene), or, if this recollection is new information, drop the "remembered" framing and have the character say it in this chapter. Then check the blueprint's costsAndTurns: what the chapter forgets should match what it declared.`,
      },
    }
  })
}