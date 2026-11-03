import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 面向用户的预检文案里不得混进**开发者内部产物**（issue #112）。
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
  { label: '引用标定样本（「样本」二字）', pattern: /样本/u },
  { label: '英文内部表达式（sample book / in the sample）', pattern: /\b(sample book|in the sample)\b/iu },
  // ⚠️ evidence 会被渲染成「来源：…」，必须是作者读得懂的中文/原句，
  // 不能是 `${name} last scheduled in chapter N` 这类内部字段拼接。
  { label: 'evidence 里的英文内部短语', pattern: /\b(last scheduled in|motivation is empty|last in chapter)\b/u },
]

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
      const lines = readFileSync(join(SHARED_DIR, name), 'utf8').split('\n')
      for (const [index, line] of lines.entries()) {
        if (!USER_FACING_FIELDS.test(line)) continue
        for (const { label, pattern } of FORBIDDEN_IN_COPY) {
          if (pattern.test(line)) offenders.push(`${name}:${index + 1} [${label}]`)
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
    // 正常文案不能命中。
    expect(FORBIDDEN_IN_COPY.some(({ pattern }) => pattern.test('zhCN: `在正文里写明他的退场及其原因`'))).toBe(false)
  })
})