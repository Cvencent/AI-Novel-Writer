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
export function extractChapterDigest(block: string, knownCharacterNames: readonly string[]): OutlineChapterDigest {
  const { body } = splitChapterBlock(block)
  const characterNames = [...new Set(knownCharacterNames.filter(name => name.trim().length >= 2 && body.includes(name)))]
  const notes = firstSentences(body, 4)
  // 事实：取含转折/结果词的句子，最多 3 条，作为可检索的连续性锚点。
  const facts = (body.match(/[^。！？!?]*[。！？!?]/gu) ?? [])
    .map(item => item.replace(/\s+/gu, ' ').trim())
    .filter(item => /(?:于是|因此|结果|最终|代价|暴露|发现|决定|失去|得到|留下|改变了)/u.test(item))
    .slice(0, 3)
  return { chapterNotes: notes, characterNames, continuityFacts: facts }
}
