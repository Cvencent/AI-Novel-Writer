/**
 * 「N 个字」自报计数与紧随其后的实体不符（issue #131）。
 *
 * 真实形态是推理小说的核心证据写法——**声明字数后紧接着由正文自己写出那串字**：
 *
 *   在「核清」后头添了六个字——核至本班次为止。    声明 6，实际 7
 *   底下三个字：三日内化浆。                      声明 3，实际 5
 *   名字栏三个字：徐哥。                          声明 3，实际 2
 *
 * 而同一本书里对得上的写法也有（「名字栏两个字写得稳：周叙」「盯着那四个字：完整无缺」）。
 * 也就是说这不是「模型不会数」，是**没有任何一处拦得住**。读者跟着数来对账，
 * 数不上就会回头翻两遍——推理爽感在这里漏掉。
 *
 * 判据完全机械化，不需要词表：
 * 1. 命中「数量词 + 量词」的**自报计数**（两个/三位/五名…），量词取「字」这一族；
 * 2. 只认**实体由正文自己引出**的写法（冒号、破折号、引号引渡），这样没有歧义；
 * 3. 实际字数 = 引出实体的汉字个数（**只数汉字**，标点不算——「下三个字」里的标点不是字）；
 * 4. 相等即不报。
 *
 * 刻意不做的：
 * - 正在被「刮断/残缺/只剩下」修饰的句子不判（本书 ch21「两个名字，中间被刮断，
 *   只剩半边『余』」声明的是原字数、后面写的是残留字数，两者都成立）；
 * - 不扩展到「N 行 / N 句」等其他量词（那是另一族的排版口径，判据不同）。
 */
export interface DeclaredCharacterCountMismatch {
  /** 声明的字数。 */
  declared: number
  /** 紧随其后实体里的汉字数。 */
  actual: number
  /** 触发位置的原文片段（供作者核对）。 */
  evidence: string
  /** 触发位置在这一章里的字符序号。 */
  index: number
}

const CHINESE_DIGITS: Record<string, number> = {
  〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}
const CHINESE_NUMERAL = '〇零一二两三四五六七八九十'
/** 汉字（不含标点、数字、拉丁字母）。实体的字数按它算。 */
const HAN_CHARACTER = /[\u4e00-\u9fff\u3400-\u4dbf]/gu

/**
 * 「六个字」「3 个字」「两字」这类声明，后接冒号/破折号/引号引出的实体。
 *
 * 引渡符只认**开引号**（「『“”）与冒号/破折号——闭引号不是引渡：实测
 * 「三个字，”他说，“存根上写的是我爸」里第一个引号是**对话打断**，
 * 实体其实根本没写出来；若把闭引号也当引渡，就会从后面的开引号重新取一段，
 * 把别人的话算成这处的字数。
 *
 * 声明与引渡符之间只允许极少量的过渡字（上限 6 个字），避免跨句误配。
 * 实体必须**整段结束在标点上**：字符类排除逗号/顿号/分号与全部引号，
 * 并用 lookahead 要求紧接着句末标点、任意引号或行尾——「一串连续的字」
 * 这个语义由标点自己界定，不靠长度上限猜。
 */
const DECLARED_ENTITY = new RegExp(
  `([0-9${CHINESE_NUMERAL}]{1,3})\\s*[个名]?\\s*字\\s*[^。！？\\n，、；]{0,6}?(?:[：:]|——?|—|「|『|“|”)([^。！？；，、\\n」』””“「『]+?)(?=[。！？\\n」』””“「『]|$)`,
  'gu',
)

function declaredCount(value: string): number | null {
  if (/^\d+$/u.test(value)) return Number(value)
  if (value.length === 1) return CHINESE_DIGITS[value] ?? null
  // 「一十」之外的两位数写法不是字数声明，放弃（与编号位数同一口径）。
  return null
}

function countHan(value: string): number {
  return (value.match(HAN_CHARACTER) ?? []).length
}

/** 「被刮断/残缺」这类句子声明的是原字数、写出的是残留字数，两者都成立，不判。 */
const RESIDUAL_MARKERS = /(?:刮断|刮去|残缺|只剩|剩下|磨掉|蚀掉|泡烂|化掉)/u

export function findDeclaredCharacterCountMismatches(content: string): DeclaredCharacterCountMismatch[] {
  const text = String(content ?? '')
  const mismatches: DeclaredCharacterCountMismatch[] = []
  for (const match of text.matchAll(DECLARED_ENTITY)) {
    const index = match.index ?? 0
    const declared = declaredCount(match[1]!)
    const entity = (match[2] ?? '').trim()
    if (declared === null || !entity) continue
    // 实体必须是纯汉字串（引号里的台词会带别的字，长度语义不同）。
    const actual = countHan(entity)
    if (actual === 0 || actual === declared) continue
    // 残句（刮断/只剩…）声明的是原本的字数，不判。
    const context = text.slice(Math.max(0, index - 24), index + match[0].length)
    if (RESIDUAL_MARKERS.test(context)) continue
    mismatches.push({
      declared,
      actual,
      evidence: match[0].trim().slice(0, 60),
      index,
    })
  }
  return mismatches
}