/**
 * 从细纲章节文本抽取结构化摘要。
 *
 * 纯函数、无副作用：输入一章的标题与正文，输出可落库的摘要字段。
 * 抽取失败时返回空字段而不是抛错——摘要缺失不应阻断大纲生成。
 */
export interface OutlineChapterDigest {
  chapterNotes: string
  /** 剥掉签头行后的全章叙事文本：逐角色取「最近事件」的取值窗口（issue #24）。 */
  narrativeBody: string
  /**
   * 只保留**事件型小节**（转折与代价 / 结尾钩子）的文本，供角色「最近事件」取值（issue #45）。
   *
   * 「本章目标」是计划、「场景与出场人物」是名单、「伏笔」是待兑现的坑——都不是本章发生了什么。
   * 用全章文本取值会把计划写进 `recentEvents`，还会给只在名单里被提一句的人写上「刚参与过」。
   */
  eventBody: string
  characterNames: string[]
  continuityFacts: string[]
}

/**
 * 细纲推进角色状态时只写一句「本章发生了什么」。
 *
 * `chapterNotes` 是四句话的摘要，直接写进 `recentEvents` 会让角色卡的「最近事件」
 * 变成一坨计划文本（实测会整段顶掉前一章的真实事件）。按首个句末截断并限长。
 */
export function outlineRecentEvent(notes: string, maxLength = 50): string {
  const normalized = notes.replace(/\s+/gu, ' ').trim()
  if (!normalized) return ''
  const firstSentence = (/^[^。！？!?]*[。！？!?]/u.exec(normalized)?.[0] ?? normalized).trim()
  if (firstSentence.length <= maxLength) return firstSentence
  // 超长时在句末标点处截断，不产生「…」半句（issue #18）。
  const clipped = firstSentence.slice(0, maxLength)
  const lastStop = Math.max(clipped.lastIndexOf('。'), clipped.lastIndexOf('！'), clipped.lastIndexOf('？'), clipped.lastIndexOf('；'))
  const stopIndex = lastStop >= Math.floor(maxLength / 2) ? lastStop + 1 : 0
  return stopIndex > 0 ? firstSentence.slice(0, stopIndex) : clipped
}



/**
 * 逐角色取「要点里与该角色相关的句子」作为细纲推进的 recentEvents。
 *
 * 细纲要点是章级文本：同一句写给本章每个出场角色，角色卡的「最近事件」
 * 就成了没有信息的一栏（issue #18：8 个角色 5 个同值）。规则：
 * - 只取**提到该角色名**的句子；一句提到多人时各自都能用（说的是他们共同的事）；
 * - 该角色没有任何专属句子时留空——宁缺毋滥，不把章级描述冒充角色事件；
 * - 同章算出的值与他人重复（如两人始终同句）时后写者留空。
 */
export function outlineRecentEventForCharacter(notes: string, characterName: string,
  taken: ReadonlySet<string>, maxLength = 50): string {
  if (!characterName) return ''
  const sentences = notes.replace(/\s+/gu, ' ').match(/[^。！？!?]*[。！？!?]?/gu)
    ?.map(item => item.trim().replace(/^["'“”「」『』\s]+/u, ''))
    .filter(Boolean) ?? []
  const related = sentences.filter(sentence => sentence.includes(characterName))
  for (const sentence of related) {
    const event = outlineRecentEvent(sentence, maxLength)
    if (event && !taken.has(event)) return event
  }
  return ''
}

/**
 * 从一章的细纲摘要里算出每个出场角色要推进的「最近事件」（issue #24）。
 *
 * 取值窗口是**事件型小节**（`eventBody`），既不是前 4 句的 `chapterNotes`，也不再是整章
 * `narrativeBody`（issue #45）：
 * - 「本章目标」是计划、「场景与出场人物」是名单、「阻力与升级」是障碍清单——把它们写进
 *   `recentEvents`，下一章起草读到的就是「上一章还没发生的事」，模型容易当成已发生；
 * - 只在名单里被提一句的人（本章 0 出场）会因此拿到「刚参与过」的假标记。
 * 只有「转折与代价」「结尾钩子」两节写的是本章真正发生的结果。
 *
 * 规则：
 * - 提到该角色名的句子才取值；取不到的**不进写库清单**（返回 undefined），
 *   调用方据此跳过该角色，避免把上一章已有的值无条件覆盖成空；
 * - 同章算出的值与他人重复（如两人始终同句）时后写者返回 undefined。
 * - 调用方没给 `eventBody` 时退回 `narrativeBody`（保持既有调用点可用）。
 */
export function outlineCharacterStateWrites(
  digest: Pick<OutlineChapterDigest, 'narrativeBody' | 'characterNames'> & { eventBody?: string },
  maxLength = 50,
): Array<{ characterName: string; recentEvents: string }> {
  const window = digest.eventBody?.trim() ? digest.eventBody : digest.narrativeBody
  const writes: Array<{ characterName: string; recentEvents: string }> = []
  const taken = new Set<string>()
  for (const name of digest.characterNames) {
    const recentEvents = outlineRecentEventForCharacter(window, name, taken, maxLength)
    if (!recentEvents) continue
    taken.add(recentEvents)
    writes.push({ characterName: name, recentEvents })
  }
  return writes
}
const CHAPTER_HEADING = /^#{0,4}\s*(?:第\s*(\d+)\s*章|Chapter\s+(\d+))\s*[:：]?\s*(.*)$/u

/** 从一章的 Markdown 分块中取出标题与正文。 */
export function splitChapterBlock(block: string): { chapterNumber: number | null; title: string; body: string } {
  const lines = block.replace(/\r\n?/gu, '\n').split('\n')
  let chapterNumber: number | null = null
  let title = ''
  let bodyStart = 0
  for (let index = 0; index < lines.length; index += 1) {
    const match = CHAPTER_HEADING.exec(lines[index]!.trim())
    if (match) {
      chapterNumber = Number(match[1] ?? match[2])
      title = (match[3] ?? '').trim()
      bodyStart = index + 1
      break
    }
  }
  return { chapterNumber, title, body: lines.slice(bodyStart).join('\n').trim() }
}

function firstSentences(text: string, count: number): string {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  if (!normalized) return ''
  const sentences = normalized.match(/[^。！？!?]*[。！？!?]?/gu)?.filter(item => item.trim()) ?? [normalized]
  return sentences.slice(0, count).join('').trim()
}

/**
 * 抽取摘要。人物名由调用方传入已知名单，避免把普通词误判成人名。
 */
/** 章节签头段（「**场景与出场人物**：…」这类粗体标签行）：是场景清单不是情节，不进摘要。 */
const HEADER_LINE = /^\*?\*?(?:场景与出场人物|场景|出场人物)\*?\*?\s*[:：]/u
/**
 * 事件型小节（issue #45）：只有这两节写「本章真正发生了什么」。
 * 「本章目标」是计划、「阻力与升级」是障碍、「伏笔」是待兑现的坑——都不算事件。
 */
const EVENT_SECTION = /^\*?\*?(?:转折与代价|结尾钩子)\*?\*?\s*[:：]/u
/** 任一固定小节标题：用于判断「事件型小节到哪里结束」。 */
const ANY_SECTION = /^\*?\*?(?:场景与出场人物|本章目标|阻力与升级|转折与代价|结尾钩子|伏笔)\*?\*?\s*[:：]/u
/** 小节标题开头的粗体标签（**转折与代价**、**结尾钩子**）：取值时剥掉，它不是内容。 */
const SECTION_LABEL_PREFIX = /^\s*\*\*[^*]{1,12}\*\*\s*[:：]\s*/u

/** 只保留事件型小节的文本（issue #45）；没有这些小节时返回空串，由调用方决定退路。 */
export function outlineEventBody(narrativeBody: string): string {
  const lines = narrativeBody.split(/\n+/u).map(line => line.trim()).filter(Boolean)
  const kept: string[] = []
  // 'event' 事件型小节内 / 'other' 计划类小节内 / 'none' 不属于任何小节（裸叙述）
  let inside: 'event' | 'other' | 'none' = 'none'
  for (const line of lines) {
    if (ANY_SECTION.test(line)) {
      inside = EVENT_SECTION.test(line) ? 'event' : 'other'
      if (inside === 'event') kept.push(line.replace(SECTION_LABEL_PREFIX, ''))
      continue
    }
    // 裸叙述（没有小节标签包着的那几句）本身就是正文写法，不算计划，保留；
    // 计划类小节（本章目标/阻力与升级/伏笔/场景名单）里的句子一律不收。
    if (inside !== 'other') kept.push(line)
  }
  return kept.join('\n')
}

export function extractChapterDigest(block: string, knownCharacterNames: readonly string[]): OutlineChapterDigest {
  const { body } = splitChapterBlock(block)
  const characterNames = [...new Set(knownCharacterNames.filter(name => name.trim().length >= 2 && body.includes(name)))]
  // 剥离签头行再取首句：否则「场景与出场人物」清单会顶掉真实情节成为所有出场角色
  // 共用的 recentEvents（issue #18：6/8 角色拿到同一句 50 字签头残段）。
  const narrativeBody = body.split(/\n+/u).filter(line => !HEADER_LINE.test(line.trim())).join('\n')
  const eventBody = outlineEventBody(narrativeBody)
  const notes = firstSentences(narrativeBody, 4)
  // 事实：取含转折/结果词的句子，最多 3 条，作为可检索的连续性锚点。
  const facts = (body.match(/[^。！？!?]*[。！？!?]/gu) ?? [])
    .map(item => item.replace(/\s+/gu, ' ').trim())
    .filter(item => /(?:于是|因此|结果|最终|代价|暴露|发现|决定|失去|得到|留下|改变了)/u.test(item))
    .slice(0, 3)
  return { chapterNotes: notes, narrativeBody, eventBody, characterNames, continuityFacts: facts }
}
