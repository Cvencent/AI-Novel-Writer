/**
 * 从细纲章节文本抽取结构化摘要。
 *
 * 纯函数、无副作用：输入一章的标题与正文，输出可落库的摘要字段。
 * 抽取失败时返回空字段而不是抛错——摘要缺失不应阻断大纲生成。
 */
export interface OutlineChapterDigest {
  chapterNotes: string
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

export function extractChapterDigest(block: string, knownCharacterNames: readonly string[]): OutlineChapterDigest {
  const { body } = splitChapterBlock(block)
  const characterNames = [...new Set(knownCharacterNames.filter(name => name.trim().length >= 2 && body.includes(name)))]
  // 剥离签头行再取首句：否则「场景与出场人物」清单会顶掉真实情节成为所有出场角色
  // 共用的 recentEvents（issue #18：6/8 角色拿到同一句 50 字签头残段）。
  const narrativeBody = body.split(/\n+/u).filter(line => !HEADER_LINE.test(line.trim())).join('\n')
  const notes = firstSentences(narrativeBody, 4)
  // 事实：取含转折/结果词的句子，最多 3 条，作为可检索的连续性锚点。
  const facts = (body.match(/[^。！？!?]*[。！？!?]/gu) ?? [])
    .map(item => item.replace(/\s+/gu, ' ').trim())
    .filter(item => /(?:于是|因此|结果|最终|代价|暴露|发现|决定|失去|得到|留下|改变了)/u.test(item))
    .slice(0, 3)
  return { chapterNotes: notes, characterNames, continuityFacts: facts }
}
