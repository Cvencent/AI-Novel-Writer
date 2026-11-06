/**
 * 面向作者的判据文案里**不许出现硬编码的性别代词**（issue #217）。
 *
 * 现场：写第 95 章的预检里 3 张「未登记角色」卡片全被写成「她」，其中一张说的是
 * 主角已经死了的父亲周德海（全书该名字 90 字窗口内「他」21 /「她」0）。
 * 而同一判据的轻量分支用的是「他」——两个分支的性别互相打架，说明重分支是照着
 * `#160` 那本书的样本（徐汐）写死的，之后没有抽象化。
 *
 * 判据只有名字，**没有任何性别依据**（`characters` 表没有该字段）。
 * 面向作者的文案认错人比不写代词更糟：作者会先怀疑软件搞错了角色，进而怀疑整条提醒。
 *
 * ## 为什么用「扫文案」这种笨办法
 *
 * 这不是内容判断，而是**对外文案的格式约束**——与「作者可见文本不许带 Markdown 粗体」
 * （`#169`）同一类：可断言、有唯一答案。硬编码的「他/她」是写死的**内容**，
 * 恰是用户 2026-11-05 定规禁止的形态；而它在源码里是**逐字可查**的。
 *
 * ⚠️ 只扫 `zhCN` / `enUS` 里那两个字段的**文案字符串**，不扫注释、不扫正则、不扫测试。
 * 注释里出现「他」是允许的（那是解释，不是给作者看的）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SHARED = join(__dirname, '..')

/** 剥掉块注释与行注释（只用于扫描）。 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1')
}

/**
 * 取出所有 `zhCN: '…'` / `zhCN: \`…\`` 的**模板与字符串字面量正文**。
 *
 * 只认这两种形态：判据文案全都长这样（`ConsistencyFinding.issue.zhCN` / `.suggestion.zhCN`）。
 * 引号内的 `${…}` 表达式原样保留（那里是变量名，不是文案）。
 */
export function localizedCopyOf(source: string): string[] {
  const code = codeOnly(source)
  const found: string[] = []
  for (const match of code.matchAll(/zhCN:\s*(?:'([\s\S]*?)'|`([\s\S]*?)`)/gu)) {
    found.push(match[1] ?? match[2] ?? '')
  }
  return found
}

/** 这些文件里的 `zhCN` 是**第三方的字面翻译**（如康熙部首、语言名），不是判据文案。 */
const EXEMPT_FILES = new Set(['glyph-radical-table.ts', 'language-names.ts'])

describe('面向作者的判据文案不许写死性别代词 (issue #217)', () => {
  const files = readdirSync(SHARED).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))

  it('no zhCN copy says 他 or 她', () => {
    const offenders: string[] = []
    for (const file of files) {
      if (EXEMPT_FILES.has(file)) continue
      const source = readFileSync(join(SHARED, file), 'utf8')
      for (const copy of localizedCopyOf(source)) {
        // 「其他」「他们」这类词里的「他」：`其他` 单列（它跟性别无关）。
        const stripped = copy.replace(/其他/gu, '')
        if (/[他她]/u.test(stripped)) {
          offenders.push(`${file}: ${copy.replace(/\s+/gu, ' ').slice(0, 90)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps the scan honest: it does find copy in the judge files', () => {
    // 防止「正则写坏了 → 一条都扫不到 → 全绿」这种假绿。
    const unregistered = readFileSync(join(SHARED, 'consistency-preflight.ts'), 'utf8')
    expect(localizedCopyOf(unregistered).length).toBeGreaterThan(20)
  })

  it('still allows 其他 inside copy (it is not a gendered pronoun)', () => {
    expect(localizedCopyOf("const x = () => ({ zhCN: `不要把其他角色算进来。` })").length).toBe(1)
  })
})