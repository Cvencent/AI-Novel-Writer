/**
 * 从细纲正文里删掉选中的章节块：从该章标题起，删到下一个章节标题之前。
 *
 * 标题匹配是「逐字相等或以前缀开头」，不做子串包含——否则「第1章：入学」
 * 会误伤「第1章：入学（旧）」以外的无关章节。找不到任何匹配时返回原字符串
 * （引用相等），调用方据此提示「没有匹配到」。
 */
export function removeOutlineChapters(content: string, headings: ReadonlySet<string>): string {
  if (headings.size === 0) return content
  const wanted = [...headings].map(heading => heading.trim()).filter(Boolean)
  if (wanted.length === 0) return content
  const newline = String.fromCharCode(10)
  const lines = content.replace(/\r\n?/gu, newline).split(newline)
  const out: string[] = []
  let skipping = false
  let matched = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^#{1,4}\s*第\s*\d+/u.test(trimmed)) {
      skipping = wanted.some(heading => trimmed === heading || trimmed.startsWith(heading))
      if (skipping) matched = true
    }
    if (!skipping) out.push(line)
  }
  if (!matched) return content
  return out.join(newline).replace(/\n{3,}/gu, newline + newline).trim()
}
