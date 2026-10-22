/**
 * 大纲导航：把一篇大纲切成可以点击的条目。
 *
 * 背景：粗纲与细纲都是以「一整篇 Markdown」的形式放进编辑器标签的。作品写到几百章后
 * 这篇文本会长到几万字，作者想回看「第 180 章那一段」只能从头往下滚——右侧没有列表可以跳。
 *
 * 本模块只做一件事：把文本切成条目（粗纲按段、细纲按章），给界面用来生成右侧目录。
 * 条目的 heading 是原文里逐字出现的那一行，界面据此把编辑器滚动/光标定位过去。
 *
 * 关键点：只认真正的章/段标题，不把小节标题（如「一句话前提」）当成条目，
 * 否则目录会被结构性小节淹没。
 */
export interface OutlineNavigationItem {
  /** synopsis 的条目是单章，arc 的条目是一段区间。 */
  kind: 'chapter' | 'segment'
  /** 目录上显示的文字：标题行去掉 # 之后的原文（含章号，例如「第 1–20 章：废核与第一块残片」）。 */
  label: string
  chapterFrom: number
  chapterTo: number
  /** 原文里那一整行标题，用于在编辑器中定位。 */
  heading: string
}

/** ## 第N章：标题 —— 单章。 */
const CHAPTER_HEADING = /^\s{0,3}#{1,6}\s*第\s*(\d+)\s*章\s*[:：]\s*(.+?)\s*$/
/** ## 第N–M章：标题 —— 区间段。半角/全角/波浪/短横线都认。 */
const SEGMENT_HEADING = /^\s{0,3}#{1,6}\s*第\s*(\d+)\s*[–—~-]\s*(\d+)\s*章\s*[:：]\s*(.+?)\s*$/

/**
 * 解析出一篇大纲的条目列表。
 *
 * 区间标题（第 N–M 章）与单章标题（第 N 章）都由标题行本身区分，不需要调用方声明模式：
 * 粗纲文本里全是区间标题，细纲里全是单章标题，两种混排也能正确归类。
 * 顺序就是原文顺序；解析不出任何条目时返回空数组。
 */
export function parseOutlineNavigation(markdown: string): OutlineNavigationItem[] {
  if (!markdown) return []
  const items: OutlineNavigationItem[] = []
  for (const rawLine of markdown.replace(/\r\n?/gu, '\n').split('\n')) {
    // 段标题优先：arc 的「第 1–20 章：X」也符合单章正则的前缀形状，
    // 所以区间必须先判，否则会被拆成 from=1。
    const segment = SEGMENT_HEADING.exec(rawLine)
    if (segment) {
      const chapterFrom = Number(segment[1])
      const chapterTo = Number(segment[2])
      if (chapterTo < chapterFrom) continue
      const heading = rawLine.trim()
      items.push({
        kind: 'segment',
        label: heading.replace(/^#{1,6}\s*/u, ''),
        chapterFrom,
        chapterTo,
        heading,
      })
      continue
    }
    const chapter = CHAPTER_HEADING.exec(rawLine)
    if (!chapter) continue
    const chapterFrom = Number(chapter[1])
    const heading = rawLine.trim()
    items.push({
      kind: 'chapter',
      label: heading.replace(/^#{1,6}\s*/u, ''),
      chapterFrom,
      chapterTo: chapterFrom,
      heading,
    })
  }
  return items
}
