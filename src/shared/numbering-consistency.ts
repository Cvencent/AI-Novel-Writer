/**
 * 贯穿性编号（票号 / 编号 / 代号）的自洽检测（issue #47）。
 *
 * 真实事故：同一本书的票号在 4 章里出现 4 种互不相容的写法（「丁段一四」「零三一七」「零三〇一」「一七四」），
 * 而且第 16 章标称「编号五位」却只写出四位；第 16 章把空号定义成 0315–0318 之间那段，
 * 第 17 章又说 174「正落在中间」——第 17 章整章的证据链架在这句不成立的话上。
 *
 * 只做**能直接机器判**的那一类：**声明的位数与紧随其后的数字位数不符**。
 * 这类判据不需要词表、不需要抽取规则，命中即错，正是 issue 建议 3 说的那条。
 *
 * 刻意不做的：把全文的编号值抽出来比较「形式是否一致」。编号是开放集合，
 * 中文里「丁段一四」与「零三一七」是否属同一体系无法用字符层判据决定
 * （#20 的教训：关键词方案 4 次触发 3 次是同一剧情换措辞，最终整案回滚）。
 */
export interface NumberingMismatch {
  /** 声明里写的位数（如「编号五位」→ 5）。 */
  declaredDigits: number
  /** 紧随其后的数字实际位数。 */
  actualDigits: number
  /** 触发位置的原文片段（供作者核对）。 */
  evidence: string
  /** 触发位置在这一章里的字符序号（同一章可能多处）。 */
  index: number
}

/** 汉字数字 → 数值；只处理位数声明里会用到的一到十。 */
const CHINESE_DIGITS: Record<string, number> = {
  〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}
const CHINESE_NUMERAL = '〇零一二两三四五六七八九十'
/** 阿拉伯数字与汉字数字混写的编号（「零三一七」四位、「一七四」三位）。 */
const NUMBER_TOKEN = new RegExp(`[0-9${CHINESE_NUMERAL}]+`, 'u')

/**
 * 「…编号五位，零三一七…」/「（编号 5 位）：0317」这类声明 + 数字的写法。
 * 声明与数字之间允许标点、量词与极短修饰（「编号为五位，」「编号共 5 位：」），
 * 最多隔 4 个非数字字符，避免跨句误配。
 */
const DECLARED_DIGITS = new RegExp(
  `(?:编号|票号|代号|号码|号段|编码)?[^0-9${CHINESE_NUMERAL}。！？\\n]{0,4}([0-9${CHINESE_NUMERAL}]{1,3})\\s*位(?:数)?[^0-9${CHINESE_NUMERAL}。！？\\n]{0,4}([0-9${CHINESE_NUMERAL}]+)`,
  'gu',
)

function digitCount(value: string): number | null {
  if (/^\d+$/u.test(value)) return value.length
  const digits = [...value]
  if (value.length <= 8 && digits.every(character => character in CHINESE_DIGITS)) {
    // 汉字数字的位数按「字面个数」算：「零三一七」是四位，「一七四」是三位。
    // 「十」在位数声明里写作 10（如「十位」），不做特殊展开——超出 1–9 的声明本就少见。
    if (value.length === 1 && value === '十') return 10
    return value.length
  }
  return null
}

function declaredValue(value: string): number | null {
  if (/^\d+$/u.test(value)) return Number(value)
  if (![...value].every(character => character in CHINESE_DIGITS)) return null
  if (value.length === 1) return CHINESE_DIGITS[value] ?? null
  // 「一十」之外的两位数写法（如「一四」）不是位数声明，放弃。
  return null
}

/**
 * 找出「声明 N 位、但紧随其后的编号不是 N 位」的位置。
 * 返回空数组表示没有这类矛盾——这是常态。
 */
export function findDeclaredDigitCountMismatches(content: string): NumberingMismatch[] {
  const text = String(content ?? '')
  const mismatches: NumberingMismatch[] = []
  for (const match of text.matchAll(DECLARED_DIGITS)) {
    const declared = declaredValue(match[1]!)
    const actual = digitCount(match[2]!)
    if (declared === null || actual === null || declared === actual) continue
    // 只报「编号这一侧」的写法，避免把「十位乘客，其中 3 人」这类普通量词当成编号声明。
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 6), match.index ?? 0)
    if (!/(?:编号|票号|代号|号码|号段|编码|位)/u.test(prefix + match[0])) continue
    if (!NUMBER_TOKEN.test(match[2]!)) continue
    mismatches.push({
      declaredDigits: declared,
      actualDigits: actual,
      evidence: match[0].trim().slice(0, 60),
      index: match.index ?? 0,
    })
  }
  return mismatches
}