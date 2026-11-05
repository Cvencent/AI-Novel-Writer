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
  /**
   * 判据**点名的那个词/物**（issue #177）。
   *
   * 现场：5 次调用 40 条判据里，点名了词的 15 条中 7 条那个词在本章**只出现 2 次** ——
   * 正好是产品起草清单自订的上限（`builtin-prompt-templates.ts:879`「每个词在本章最多出现 2 次」）。
   * 起草侧把 2 次当上限、核实侧把 2 次当「反复」，两个口径直接打架。
   *
   * 还有一条「布角」连自己的引文里都没有这两个字（引文写的是「那角布」）——
   * 报告的词与引用的句子互不相干，作者照它去改会找不到。
   */
  subject?: string
  /** 这个词在**该章正文**里出现的次数（规则侧统计，只计数、不判多寡）。 */
  occurrences?: number
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
  // issue #177 建议 ④：「反复」在这里是**含糊的量**（2 次是呼应、6 次才是摩挲），
  // 而卡片要能对上起草清单「每词每章最多 2 次」那条上限。改成不含量级的说法，
  // 次数由卡片自己写出来（见 styleIssueFindings）。
  motif: ['同一个词被用来承载情绪', 'one word used to carry the feeling'],
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
      '"motif": one concrete word or object is used to carry the emotion of the chapter.',
      // issue #177: the drafting checklist caps a word at 2 uses per chapter, while this check
      // treated 2 as "repeatedly". Give the model the count axis instead of a word list.
      'When judging "motif" first count how many times it occurs in that chapter (report subject and occurrences; the rules recount them):',
      '- twice is an ECHO, not a problem (the drafting checklist itself caps a word at 2 per chapter);',
      '- 3–4 times is only a problem if every use carries emotion and could be swapped out;',
      '- 5 or more times, each used for mood, is what this axis is for.',
      '⚠️ Always give the exact word as subject, and that word MUST appear inside your own quote — the reported word and the quoted sentence have to match.',
      'When judging "motif", first rule out: (1) terminology, job titles or document names — repetition there is the plot needing precision, not style; (2) places — where things happen, not something being handled; (3) any concept the reader MUST remember to follow the events. Only report words that could be swapped out without losing meaning and exist purely for mood.',
      'Judge by meaning, not by a fixed word list: a simile written without a connective is still a simile; a body reaction specific to this character is NOT a cliché.',
      'Quote the exact sentence from the chapter for every issue. If you cannot quote it, do not report it.',
      'Output one JSON object: {"issues":[{"chapterNumber":<n>,"kind":"metaphor|physiological|summary-tail|motif","subject":"<the exact word/object, motif only>","occurrences":<how many times it occurs in that chapter, motif only>,"quote":"<exact sentence>","explanation":"<one sentence>"}]}',
      'Report at most 3 issues per chapter. If nothing qualifies, output {"issues":[]}. No commentary outside the JSON.',
    ].join('\n')
    : [
      '读这些章节，只报下面四类文风问题，每条都要**逐字引用**正文：',
      'metaphor（比喻堆叠）：这一章靠打比方推进，而不是把事情直接说出来——大致超过两处。',
      'physiological（模板化生理反应）：用通用的身体反应代替「紧张」的写法（喉结滚动、攥紧拳头、咬唇、耳鸣…）。**同一个反应反复用**才报；一次具体的动作不报。',
      'summary-tail（段尾总结腔）：一段的结尾替读者把这一段的意思说了一遍（哲理感悟、「这一切才刚刚开始」这类）。',
      'motif（同一个词被用来承载情绪）：一个具体的词或物件被用来**承载情绪**。',
      // issue #177：产品两个口径打架 —— 起草侧「每个词在本章最多出现 2 次」是**上限**，
      // 而核实侧把 2 次当成「反复」。所以提示词里给出可判的量纲，并把判断交给模型：
      '判 motif 时**先看它在那一章出现了几次**（JSON 里要给出 subject 与 occurrences，规则会核数）：',
      '- 2 次是**呼应**，不是问题（起草清单自己写着「每个词在本章最多出现 2 次」）；',
      '- 3–4 次要看它是不是每处都在扛情绪，只有都扛情绪且可替换时才报；',
      '- 5 次以上、且每处都在替作者抒情，才是这一档要报的。',
      '⚠️ 必须给出 **subject**（被点名的那个词/物，逐字照正文里的写法），且**这个词必须出现在你自己的 quote 里**——报告的词与引用的句子必须对得上。',
      '⚠️ 判 motif 时必须先分清这不是下面三种：①**术语/职务/单据名**（「经手人」「调阅条」这类——反复出现是案情需要在说清关系，不是文风）；②**场所**（「案桌上」「码头边」——它是事情发生的地方，不是被反复处置的东西）；③**推动情节的关键概念**（读者恰恰必须记住它才能跟上事件）。只报那些**换掉也不影响理解、纯粹用来抒情**的词。',
      '按**意思**判断，不要按固定词表：不写连接词的比喻仍是比喻；这个人特有的身体反应不算套话。',
      '每条都必须逐字引用正文里的一句。引不出来就不要报。',
      '输出一个 JSON 对象：{"issues":[{"chapterNumber":<章号>,"kind":"metaphor|physiological|summary-tail|motif","subject":"<被点名的词/物（仅 motif 需要）>","occurrences":<该词在该章出现的次数（仅 motif 需要）>,"quote":"<原句>","explanation":"<一句话>"}]}',
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
 * 一个词在一段正文里出现几次（issue #177）——**纯计数**，不是内容判断。
 *
 * 为什么由规则数而不信模型：这是可断言的事（同样的输入必有同样的输出），
 * 而模型给的数字经常和正文对不上（现场「布角 2 次」「绳 7 次」都是事后人去数的）。
 * ⚠️ 只数**逐字出现**的次数；换措辞指代同一件物不算——那是内容判断，归模型。
 */
export function countOccurrences(body: string, word: string): number {
  const target = String(word ?? '').trim()
  if (!target) return 0
  const source = String(body ?? '')
  let count = 0
  let from = 0
  for (;;) {
    const at = source.indexOf(target, from)
    if (at < 0) return count
    count += 1
    from = at + target.length
  }
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
    /**
     * issue #177：motif 这一档要**点名的词**，并且它必须出现在自己的引文里。
     *
     * 现场：一条判据写着「布角在本章反复出现」，引文却是「周叙看着那角布不见了。」——
     * 「布角」二字不在引文里（引文写的是「那角布」）。报告的词与引用的句子互不相干，
     * 作者照它去改会找不到。
     *
     * 三道校验（都是**结构**，不涉及内容判断）：
     * 1. motif 缺 `subject` → 丢弃（没有点是哪个词，作者无从核对）；
     * 2. `subject` 不出现在自己的 `quote` 里 → 丢弃；
     * 3. **出现次数由规则重新数**（`countOccurrences`），**不信模型报的数**——
     *    这是纯计数，可断言，而模型给的数字经常和正文对不上。
     */
    let subject: string | undefined
    let occurrences: number | undefined
    if (kind === 'motif') {
      subject = String(record.subject ?? '').trim()
      if (!subject || !quote.includes(subject)) continue
      occurrences = countOccurrences(body, subject)
    }
    const key = `${chapterNumber}:${kind}:${quote}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      chapterNumber,
      kind: kind as StyleIssue['kind'],
      quote,
      ...(subject === undefined ? {} : { subject }),
      ...(occurrences === undefined ? {} : { occurrences }),
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
    /**
     * motif 这一档必须写明**出现几次**（issue #177 建议 ②）：作者才有依据决定改不改。
     * 现场：47% 的 motif 判据点名的是只出现 2 次的词——那是起草清单自订的上限，不是「反复」。
     * 卡片上不给次数，作者只能自己回正文里数。
     */
    const quotes = list.map(item => (item.subject !== undefined && item.occurrences !== undefined
      ? `「${item.quote}」（\`${item.subject}\` 在本章出现 ${item.occurrences} 次）`
      : `「${item.quote}」`)).join('、')
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
        zhCN: `${first.kind === 'motif'
          ? '先看出现次数：**2 次是呼应，不用改**（起草清单自订的上限就是每词每章 2 次）；3–4 次只有每处都在扛情绪时才值得动；5 次以上才是这一档要处理的。'
          : ''}把这一处换成**具体的、这一章独有的东西**：一个动作、一个数字、一件道具的位置，或这个人特有的反应——而不是通用的比喻或身体反应。`,
        enUS: `Replace it with something concrete and specific to this chapter: an action, a number, where an object ended up, or this character's own reaction — rather than a stock simile or body beat.`,
      },
    }
  })
}
