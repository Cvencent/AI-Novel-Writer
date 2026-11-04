import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 内容判断不得靠写死的逻辑——**词表不许、短语匹配也不许**（用户 2026-11-05，两轮追加）。
 *
 * **用户原话（第一轮）**：「不要有这种写死的标记词……不要有任何写死的这种内容的逻辑。
 * 内容全让模型去处理，你只负责让模型怎么去生成。」
 *
 * **用户原话（第二轮，更严）**：「不要有任何那个内容上的文字类的写死的判断逻辑，
 * 不能去设计词表，也不能用任何的短语匹配，就是不能有这类的逻辑，内容类的全部让模型判断。」
 *
 * 这条守卫的来历：我先后交付过两份被否掉的判据——
 * `body-mark-consistency.ts`（`缺|断|疤|伤` + `小指|虎口`）与
 * `sensory-channel.ts`（`腥气|霉味|墨味…`）。两次我都给自己找了同一个理由
 * （「这是封闭词类 / 这是计数不是判断」），两次都被否。它们都已改成模型判断
 * （`appearance-consistency.ts` / `sensory-review.ts`）。
 *
 * ⚠️ 守卫只守**内容语义**这一侧，不禁形式类的东西：
 * 引号族、句末标点、康熙部首表、时间单位、序数词、虚词表——那些是判据的合法基础。
 */
describe('内容判断不写死词表/短语 (用户 2026-11-05)', () => {
  const srcRoot = join(__dirname, '..', '..')
  const sharedDir = join(srcRoot, 'shared')

  const files = readdirSync(sharedDir)
    .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))

  /**
   * 题材词：**内容**词汇，不是语法类。
   *
   * 这些是「人/物/感受」的词——要判一段文字里有没有它们、说的是不是同一件事，
   * 必须理解内容，而那是模型的事。
   */
  const CONTENT_WORDS = [
    // 感官/气味/味觉
    '腥', '霉', '香', '臭', '味',
    // 身体部位与痕迹
    '小指', '拇指', '虎口', '肩', '疤', '茧',
    // 生理反应
    '喉结', '耳鸣', '痉挛', '瞳孔',
  ]

  /** 零豁免：规则是「不能有」，就不该有名单。曾经的白名单（`sensory-channel.ts`）已改成模型判断。 */
  const ALLOWED_IN: Readonly<Record<string, string>> = Object.freeze({})

  /** 剥掉 `//` 行注释与 `/* … *\/` 块注释（只用于扫描，不改文件）。 */
  function codeOnly(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/(^|[^:])\/\/[^\n]*/gu, '$1')
  }

  it('no shared module judges content by a hard-coded topic word list', () => {
    const offenders: string[] = []
    for (const file of files) {
      if (file in ALLOWED_IN) continue
      const source = readFileSync(join(sharedDir, file), 'utf8')
      const literalArrays = [...source.matchAll(/Object\.freeze\(\s*\[([\s\S]{0,600}?)\]\s*\)/gu)]
      for (const block of literalArrays) {
        const body = block[1]!
        const hits = CONTENT_WORDS.filter(word => body.includes(`'${word}`) || body.includes(`"${word}`))
        if (hits.length > 0) offenders.push(`${file} :: ${hits.join('、')}`)
      }
    }
    expect(offenders).toEqual([])
  })

  /**
   * 第二个维度：**短语匹配**。
   *
   * 第二句话说「也不能用任何的短语匹配」——它不会被上面那条抓（那是数组形态）。
   * 典型形态：`content.includes('那句话')` / `new RegExp('不改口|不松口')`
   * 当作「正文里发生了这件事」的证据。
   *
   * ⚠️ 这一条**判不彻底**：`indexOf` 也用于**引文定位**（合法）、
   * `includes` 也用于字符串判断（合法）。所以只针对**中文字面量**：
   * 在 includes/indexOf/startsWith/endsWith 的参数里出现**连续 3 个以上汉字**。
   * （引文定位的实参是变量不是字面量，所以不会误伤。）
   */
  it('no shared module decides content by matching a Chinese phrase literal', () => {
    const offenders: string[] = []
    for (const file of files) {
      // ⚠️ 先剥注释：注释里会**举例说明**这条规则（`includes('那句话')`），
      // 不剥就会把说明文字自己判死——本仓栽过同类假命中（#120/#137 的键字面量扫描）。
      const source = codeOnly(readFileSync(join(sharedDir, file), 'utf8'))
      for (const match of source.matchAll(/(?:includes|indexOf|lastIndexOf|startsWith|endsWith)\(\s*(['"`])([^'"`]{2,80})\1/gu)) {
        const literal = match[2]!
        if (/[\u4e00-\u9fff]{3,}/u.test(literal)) offenders.push(`${file} :: ${literal.slice(0, 30)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('records the remaining technical debt explicitly instead of hiding it', () => {
    // 白名单必须写明「为什么还留着」——不写就成了静默豁免。
    for (const [file, note] of Object.entries(ALLOWED_IN)) {
      expect(files, `${file} 已不存在，请删掉白名单条目`).toContain(file)
      expect(note.trim().length).toBeGreaterThan(0)
    }
  })
})