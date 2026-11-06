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
 * ⚠️ 置位守卫必须**真的能拒绝**（issue #221）：`DECLARED_DIGITS` 里已含「位」，
 * 守卫字符类再写一个 `位` 就恒为真、整个 if 成了死代码，任何「N 位 + 数字」都能过。
 * 判据的守卫正则自己也要能被证伪——写完之后**喂一句反例看它拒不拒**。
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
    /**
     * 只报「编号这一侧」的写法，避免把「十位乘客，其中 3 人」这类普通量词当成编号声明。
     *
     * ⚠️ **这里原来多了一个 `位`，而它是死代码 —— 反而把守卫整个架空了**（issue #221）：
     *
     * `DECLARED_DIGITS` 的模式本身含 `s*位(?:数)?`，所以 `match[0]` **必然**包含「位」，
     * 于是字符类里那个 `位` 分支**恒为真** → 这个 if 从来不会拒绝任何东西。
     * 结果是**任何**「N 位 + 数字」都能过守卫，包括序数词：
     *
     *   「头一位先露，随后**三位一**口气浮出来。」 → 报「声明 3 位、实际 1 位」
     *
     * ——「位」在这里是序数词的量词，被当成「实际数字」的「一」是「一口气」的首字，
     * 而整句讲的是**溯读时数字显现的次序**，与编号体系无关（全语料 2 条命中里 1 条是它）。
     * 作者照卡片改哪一边都会把一句本来正确的句子改坏。
     *
     * 去掉 `位` 之后守卫才真的在起作用：要求「编号/票号/代号/号码/号段/编码」这类
     * **编号上下文**出现在声明附近。消融验证：假阳性归零、真阳性（第 16 章
     * 「编号五位，零三一七」）保留。
     */
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 6), match.index ?? 0)
    if (!/(?:编号|票号|代号|号码|号段|编码)/u.test(prefix + match[0])) continue
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