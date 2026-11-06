import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 面向用户的预检文案里不得混进**开发者内部产物**（issue #112 / #138）。
 *
 * ⚠️ #138 的教训：#112 修完后又漏了两处，其中一处是**裸编号**（`若怕落回 #66 的通牒`，
 * 不含「issue」二字，按关键字扫会漏），另一处是**标定样本里的物名**
 * （`墨盒、舵轮、茶碗盖`，作者的书里根本没有这些道具）。
 *
 * 本测试能机械判的是前者（裸编号）与「样本」字样；**后者判不了**——要判「这个专名不属于
 * 作者这本书」需要一份该书自己的专名表，而 finding 文案是静态字符串、不含书名/名册。
 * 所以那条只能靠人工写作纪律：**finding 文案里举例子时，只许举抽象形态或指向本条 evidence，
 * 不许举具体道具名**。已在 `automation-find-issues.md` 的自查项里写明。
 *
 * 原文档（issue #112）：

 *
 * 实测：那本 50 章的书点「写第 50 章」时弹出的 29 条提醒里，约 5 条带着
 * ① `（issue #28）`／`（issue 建议 1）` 这类仓库内部编号（产品里没有对应入口，作者点不了也看不懂）；
 * ② `全叔 last scheduled in chapter 32` 这种英文内部表达式（渲染层直接拼在「来源：」后面）；
 * ③ **另一本书（标定样本）的角色与情节**——「像样本第 18 章对配角邵德昌做的『搬去码头另一头养老』那样」，
 *    而作者的书里「邵德昌」出现 0 次、第 18 章也没有那件事。这会让他以为软件记错了稿子，比看不懂更伤信任。
 *
 * 判据是**结构性的**（不枚举某一条文案）：扫 `src/shared/*.ts` 里所有
 * `zhCN` / `enUS` / `evidence` 字符串，禁止出现内部产物标记。
 * ⚠️ 只看**面向用户的那三个字段**——文件头的实现注释里保留 issue 编号是**对**的
 * （那是给维护者看的），一刀切全禁会把说明性注释也判死。
 */
const USER_FACING_FIELDS = /\b(zhCN|enUS|evidence)\s*:/u

/** 内部产物标记：仓库编号、英文内部表达式、以及「样本/标定书」这类词。 */
const FORBIDDEN_IN_COPY: ReadonlyArray<{ label: string, pattern: RegExp }> = [
  { label: '仓库内部 issue 编号', pattern: /issue\s*#\d+/u },
  { label: '仓库内部「issue 建议」编号', pattern: /issue\s*建议/u },
  // 裸编号（`#66`）：实测这是最容易漏的一类——#111 新加的文案里就有一条
  // 「若怕落回 #66 的通牒」，不含「issue」二字，静态扫关键字会漏。
  { label: '裸仓库编号（#数字）', pattern: /#\d+/u },
  { label: '引用标定样本（「样本」二字）', pattern: /样本/u },
  { label: '英文内部表达式（sample book / in the sample）', pattern: /\b(sample book|in the sample)\b/iu },
  // ⚠️ evidence 会被渲染成「来源：…」，必须是作者读得懂的中文/原句，
  // 不能是 `${name} last scheduled in chapter N` 这类内部字段拼接。
  { label: 'evidence 里的英文内部短语', pattern: /\b(last scheduled in|motivation is empty|last in chapter)\b/u },
]

/**
 * 把源码切成「面向用户的字段块」。
 *
 * ⚠️ 必须按**块**扫，不能按行：这些文案是大段模板字符串，一句常常跨 3–6 行。
 * #112 的旧版按行扫，于是「若怕落回 #66 的通牒」与「墨盒、舵轮、茶碗盖」都没被抓到
 * ——它们与字段名不在同一行（issue #138 的漏因）。
 *
 * 分块方式：从 `zhCN:`/`enUS:`/`evidence:` 起，到下一个同级字段名或 `}` 为止（上限 40 行），
 * 用大括号深度把模板字符串里的 `${…}` 也算在同一块里。
 */
export function userFacingBlocks(source: string): Array<{ line: number, text: string }> {
  const lines = source.split(String.fromCharCode(10))
  const blocks: Array<{ line: number, text: string }> = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!USER_FACING_FIELDS.test(lines[index]!)) continue
    const collected: string[] = []
    let depth = 0
    let opened = false
    for (let cursor = index; cursor < lines.length && cursor - index < 40; cursor += 1) {
      const line = lines[cursor]!
      // ⚠️ **注释不是文案**（issue #112 的文档明说：维护者注释里保留 issue 编号是对的）。
      // 旧版会从 `evidence:` 那一行继续吃进 `issue: {` 之后的注释——因为 `${…}` 让
      // `opened` 为真、单行字段的早退又不成立——于是 #217 加的
      // 「// ⚠️ 不写「她」/「他」（issue #217）」把这条守卫判红。那是**假阳性**，
      // 不是文案里漏了编号；这一行在 2026-11-06 之后一直是红的（issue #163 本轮顺手修）。
      if (cursor > index && /^\s*(?:\/\/|\/\*|\*)/u.test(line)) break
      collected.push(line)
      for (const character of line) {
        if (character === '{' || character === '(' || character === '[') { depth += 1; opened = true }
        else if (character === '}' || character === ')' || character === ']') depth -= 1
      }
      if (cursor > index && opened && depth <= 0) break
      // 单行字段（`evidence: '…',`）：本行就结束。
      if (cursor === index && /,\s*$/u.test(line) && !opened) break
    }
    blocks.push({ line: index + 1, text: collected.join(String.fromCharCode(10)) })
  }
  return blocks
}

const SHARED_DIR = join(__dirname, '..')

describe('面向用户的预检文案不含开发者内部产物 (issue #112)', () => {
  const files = readdirSync(SHARED_DIR).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))

  it('has user-facing copy to check (guards against a vacuous test)', () => {
    // 否则「没命中」可能只是因为这些文件里根本没有 zhCN/enUS。
    const withCopy = files.filter(name => USER_FACING_FIELDS.test(readFileSync(join(SHARED_DIR, name), 'utf8')))
    expect(withCopy.length).toBeGreaterThan(5)
  })

  it('no user-facing string carries an internal artifact', () => {
    const offenders: string[] = []
    for (const name of files) {
      for (const block of userFacingBlocks(readFileSync(join(SHARED_DIR, name), 'utf8'))) {
        for (const { label, pattern } of FORBIDDEN_IN_COPY) {
          if (pattern.test(block.text)) offenders.push(`${name}:${block.line} [${label}]`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the checker itself catches each forbidden pattern', () => {
    // 反例自检：判据必须真的能认出来（本仓吃过「空转测试」的亏）。
    const sample = 'zhCN: `…（issue #28）…`'
    expect(FORBIDDEN_IN_COPY.some(({ pattern }) => pattern.test(sample))).toBe(true)
    expect(FORBIDDEN_IN_COPY.some(({ pattern }) => pattern.test('evidence: `${name} last scheduled in chapter 32`'))).toBe(true)
    expect(FORBIDDEN_IN_COPY.some(({ pattern }) => pattern.test('zhCN: `像样本第 18 章那样`'))).toBe(true)
    // 裸编号（issue #138 的漏网形态）：不含「issue」二字。
    expect(FORBIDDEN_IN_COPY.some(({ pattern }) => pattern.test('zhCN: `若怕落回 #66 的通牒`'))).toBe(true)
    // 正常文案不能命中。
    expect(FORBIDDEN_IN_COPY.some(({ pattern }) => pattern.test('zhCN: `在正文里写明他的退场及其原因`'))).toBe(false)
  })

  it('does not swallow maintenance comments that follow a field (#217 regression)', () => {
    // 复刻真实形态：`evidence:` 里带 `${…}`（opened 为真），下一行是 `issue: {`，
    // 再下一行是维护者注释，里面写着自己的 issue 编号。
    const source = [
      '      evidence: `第${chapter.chapterNumber}章写了年龄`,',
      '      issue: {',
      '        // ⚠️ 不写「她」/「他」（issue #217）',
      '        zhCN: `第 ${chapter.chapterNumber} 章写了年龄。`,',
      '      },',
    ].join(String.fromCharCode(10))
    const blocks = userFacingBlocks(source)
    expect(blocks.length).toBeGreaterThan(0)
    // 注释不是文案：它不该进入任一字段块，否则守卫会把「维护者注释里有编号」判成文案泄漏。
    for (const block of blocks) expect(block.text).not.toContain('issue #217')
    // 但真正的文案仍然被扫到（否则上面的断言凭「什么都没扫」也能绿）。
    expect(blocks.some(block => block.text.includes('章写了年龄。'))).toBe(true)
  })
})