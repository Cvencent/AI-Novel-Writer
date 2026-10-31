/**
 * 年龄字段的数值归一化。
 *
 * 模型产出的年龄一半是阿拉伯数字、一半是中文数字，还夹着「约」「外表约」
 * 「（死者，殁于三十年前）」这类修饰（见 characters 表实测：28 / 五十七岁 /
 * 约二十六岁 / 外表约二十四岁（死者，殁于三十年前））。同一个字段三种写法，
 * 写正文时模型看到一份混排清单，要么忽略要么自己换算，两种都会引出漂移；
 * 按年龄做的比较与校验也无从下手。
 *
 * 归一化只做「数值可比较」这一件事：
 * - 中文/阿拉伯数字统一成阿拉伯数字；
 * - 「约 / 近 / 快 / 不到 / 二十有余」这类估计词保留为 `约N` 前缀，估计语义不能丢；
 * - 「六十余 / 三十多」这类约数落成 `约N`（有余数就不再声称精确值）；
 * - 「外表约24岁（死者，殁于三十年前）」这类修饰语按原文保留在括号里——
 *   死亡信息是设定事实，只归一数值部分；
 * - 解析不出数字时原样返回，不做有损改写。
 */

const CHINESE_DIGITS: Readonly<Record<string, number>> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}

/** 「二十三」这类纯位数中文数（不含 亿/万，年龄用不到更大的单位）。 */
function parseChineseNumber(text: string): number | null {
  if (!/^[零一二两三四五六七八九十百]+$/.test(text)) return null
  if (/^十/.test(text)) {
    const rest = text.slice(1)
    const ones = rest ? CHINESE_DIGITS[rest] : 0
    return ones === undefined ? null : 10 + ones
  }
  const tenIndex = text.indexOf('十')
  if (tenIndex === -1) return CHINESE_DIGITS[text] ?? null
  const tens = CHINESE_DIGITS[text.slice(0, tenIndex)]
  if (tens === undefined) return null
  const rest = text.slice(tenIndex + 1)
  if (!rest) return tens * 10
  const ones = CHINESE_DIGITS[rest]
  return ones === undefined ? null : tens * 10 + ones
}

/** 从字段文本里取出年龄数值；解析不出返回 null。 */
export function parseAgeValue(raw: string): { value: number; approximate: boolean } | null {
  const text = raw.trim()
  if (!text) return null
  const approximate = /约|近|快|不到|有余|多$|出头/.test(text)
  // 「三十多」「六十余」「二十出头」：约数没有精确值。
  const rounded = /[余多]|出头/.test(text)
  const arabic = /\d{1,3}/.exec(text.replace(/[，,]/gu, ''))
  if (arabic) return { value: Number(arabic[0]), approximate: approximate || rounded }
  const chinese = /[零一二两三四五六七八九十百]{1,4}/.exec(text)
  if (!chinese) return null
  const value = parseChineseNumber(chinese[0])
  if (value === null || value <= 0 || value > 300) return null
  return { value, approximate: approximate || rounded }
}

export function normalizeAgeField(raw: string): string {
  const text = raw.trim()
  if (!text) return ''
  const parsed = parseAgeValue(text)
  if (!parsed) return text
  // 括号里的修饰（死者、殁年、外表说明……）是设定事实，原样保留。
  const parenthetical = text.match(/[（(][^）)]*[)）]/gu)?.join('') ?? ''
  // 括号外的「约」类前缀体现在 approximate 上；「外表」这类非数值修饰也保留。
  const prefix = text.slice(0, text.search(/[（(]/u) === -1 ? text.length : text.search(/[（(]/u))
    .replace(/约|近|快|不到|岁|余|多|出头|的|[零一二两三四五六七八九十百\d]+/gu, '')
    .trim()
  const leading = prefix && !/^\d/.test(prefix) ? `${prefix}` : ''
  const body = parsed.approximate ? `约${parsed.value}` : String(parsed.value)
  const suffix = parenthetical
  return [leading + body, suffix].filter(Boolean).join('')
}
