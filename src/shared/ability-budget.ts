/**
 * 能力／资源上限的自相矛盾（issue #51）。
 *
 * 真实事故：本书的核心能力「溯读」按「水汽有限、每班次只能读一次」定价，第 13 章却在同一段里
 * 先写「最后一次溯读已经用尽，本班次再读不出第二处」，紧接着又写「一行字浮出来」——
 * 两句之间只隔几十个字。第 16–17 章更进一步：同一夜连读三次全成功，一次都没交代水汽从哪来。
 *
 * 只做**能直接机器判**的那一类：**同一章内先声明资源用尽、随后又成功使用**。
 * 「还剩几次」的跨章记账需要一个结构化字段（本章用几次、剩余几次、恢复条件），
 * 那是产品结构改动，不在本轮。
 *
 * 判据刻意做窄：声明句是明确的「用尽／用完／再读不出／只剩一次…」，
 * 成功动作句必须含具体的使用动词（浮出／读出／按上／压上／摸出），两句相距有限（默认 600 字内），
 * 避免把「他说再读不出第二处」之后的普通叙述当成矛盾。
 */
export interface AbilityReuseContradiction {
  /** 声明用尽的原句。 */
  declaration: string
  /** 其后成功使用的原句。 */
  reuse: string
  /** 声明句在本章里的字符序号。 */
  index: number
}

const EXHAUSTED_DECLARATION = /(?:最后一次[^。！？\n]{0,12}(?:用尽|用完|耗尽)|已(?:经)?用尽|用尽了|再读不出[^。！？\n]{0,6}|没有第二次|不可能有第二[次处])/gu
// 「只剩一次」是**额度声明**而不是「已用尽」：它仍然允许一次使用，
// 所以不进这一族判据（否则「只剩一次 → 用掉这一次」会被误报）。
const SUCCESSFUL_USE = /(?:浮出来|浮出|浮起|读出|按上|压上|蘸上|摸出)/gu
/** 声明与使用之间的最大字符距离：超过就不在同一处叙述里，不判。 */
const REUSE_WINDOW = 600

export function findAbilityReuseContradictions(content: string, window = REUSE_WINDOW): AbilityReuseContradiction[] {
  const text = String(content ?? '')
  const declarations = [...text.matchAll(EXHAUSTED_DECLARATION)]
    .map(match => ({ word: match[0], index: match.index ?? 0 }))
  if (!declarations.length) return []
  const uses = [...text.matchAll(SUCCESSFUL_USE)]
    .map(match => ({ word: match[0], index: match.index ?? 0 }))
  if (!uses.length) return []
  const findings: AbilityReuseContradiction[] = []
  const usedReuse = new Set<number>()
  for (const declaration of declarations) {
    const reuse = uses.find(use => use.index > declaration.index && use.index - declaration.index <= window)
    if (!reuse) continue
    // 同一段落里常有两句相邻的用尽声明（「已经用尽，本班次再读不出第二处」）：
    // 它们指向的是同一次矛盾，只报一条，避免同一处刷两遍。
    if (usedReuse.has(reuse.index)) continue
    usedReuse.add(reuse.index)
    findings.push({
      declaration: sentenceAround(text, declaration.index, declaration.word.length),
      reuse: sentenceAround(text, reuse.index, reuse.word.length),
      index: declaration.index,
    })
  }
  return findings
}

/** 取这一处动作所在的整句（到最近的句末标点），供作者核对。 */
function sentenceAround(text: string, at: number, length: number): string {
  const start = Math.max(0, Math.max(
    text.lastIndexOf('。', at - 1), text.lastIndexOf('！', at - 1), text.lastIndexOf('？', at - 1),
  ) + 1)
  const ends = ['。', '！', '？'].map(mark => text.indexOf(mark, at + length)).filter(index => index >= 0)
  const end = ends.length ? Math.min(...ends) + 1 : Math.min(text.length, at + length + 60)
  return text.slice(start, end).replace(/\s+/gu, ' ').trim().slice(0, 120)
}
