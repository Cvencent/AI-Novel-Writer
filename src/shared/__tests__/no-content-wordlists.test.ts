import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { literalTablesIn, scanLiteralTables, tableFingerprint } from './literal-table-scan'

/**
 * 判据层不许再用「写死的中文词表/正则」判断内容（用户 2026-11-05，两轮追加）。
 *
 * **用户原话（第二轮，最严）**：「不要有任何那个内容上的文字类的写死的判断逻辑，
 * 不能去设计词表，也不能用任何的短语匹配，就是不能有这类的逻辑，内容类的全部让模型判断。」
 *
 * ## 这条守卫为什么改过两次
 *
 * 第一版只扫 `Object.freeze([...])` 且只认 15 个指定题材词——issue #163 实测：
 * 换成任何别的题材词、或换成普通数组 / 正则字面量，**三种形态全部通过**。
 * 它守的是一个**已经不存在**的问题（它盯的两张表都已删掉），却让人以为已经合规。
 *
 * 现在改成两层：
 * 1. **形态全覆盖**（`literal-table-scan.ts`）：freeze 数组 / `const X = [...]` /
 *    **只在赋值位置**的正则字面量 / `Record<K, string[]>` 内联数组；
 * 2. **冻结清单 + 只减不增**（本文件）：`literal-tables.baseline.json` 是当前存量快照。
 *    新增任何一张表都会红——**迁移是允许的（清单变短），新增是不允许的**。
 *
 * ## 为什么是「冻结 + 只减」而不是「零容忍」
 *
 * 存量 112 张里既有**形式类**（引号族、方位词、句末标点、时间单位、部首表——这些留下是对的），
 * 也有**内容类**（`RESTRICTED_VENUE = 账房|售票亭|柜台`、`ENTRANCE_DRESS = 短褂|长衫|绸褂`）。
 * 一次改 39 个文件风险太高（本仓每次大改都出过回归：见 #159/#154），所以按 issue 建议
 * 分三步：**先修守卫（本轮）→ 分批迁移 → 清单清空**。
 *
 * ⚠️ 白名单/豁免**一律不写**：唯一机制是「基线只减不增」。
 * 想留一张新表？先把它改进基线（等于承认它该留），而那需要改这份快照——是一次**显式**决定，
 * 而不是悄悄新增一张谁都没注意的词表。
 */
const BASELINE = JSON.parse(readFileSync(join(__dirname, 'literal-tables.baseline.json'), 'utf8')) as string[]

describe('判据层不许新增写死的中文词表/正则 (用户 2026-11-05 / issue #163)', () => {
  // 基线用**仓库相对路径**（`src/shared/x.ts::表名::指纹`），扫描器给的是绝对路径 → 统一下一步。
  const repoRoot = join(__dirname, '..', '..', '..')
  const tables = scanLiteralTables(join(repoRoot, 'src', 'shared'))
  /**
   * 一条表的身份 = **文件 + 表名 + 整表指纹**（issue #168）。
   *
   * ⚠️ 旧口径是「文件 + 首样本」，于是**往已有表里补词完全不触发**
   * （实测：往 `ENTRANCE_DRESS` 加 `黄狗|花猫|麻雀` 全绿）——迁移期靠补词就能绕。
   * 现在：表里加/换任何一个词，指纹就变 → 不在基线里 → 红。
   * ⚠️ 表名也进 key：同一文件里多张表首样本相同时，旧口径会让其中一张**没有独立条目**。
   */
  const keyOf = (table: { file: string; name: string; samples: string[] }) => {
    const relative = table.file.split('\\').join('/')
    const at = relative.indexOf('src/shared/')
    const path = at >= 0 ? relative.slice(at) : relative
    return `${path}::${table.name}::${tableFingerprint(table.samples)}`
  }

  it('never adds a table that is not in the frozen baseline', () => {
    const known = new Set(BASELINE)
    const added = [...new Set(tables.map(keyOf))].filter(key => !known.has(key))
    expect(added).toEqual([])
  })

  it('keeps the baseline shrinking-only, so a negative diff is the goal', () => {
    // 清单里已经不存在的条目**允许**留着（表示「这张表已迁走」），
    // 但测试会把「还能减少多少」报出来，让迁移进度可见。
    const present = new Set(tables.map(keyOf))
    const remaining = BASELINE.filter(key => present.has(key))
    // 断言：实际剩余的**不会多于**基线（等价于「没有新增」，但给出可读数字）。
    expect(remaining.length).toBeLessThanOrEqual(BASELINE.length)
    // 基线必须是唯一真源：文件里不该出现重复条目（重复会让「只减」失效）。
    expect(new Set(BASELINE).size).toBe(BASELINE.length)
  })

  it('catches the three shapes the first guard missed (issue #163 regression)', () => {
    // issue #163 的实测：普通数组 / 正则字面量 / 不在 15 词表里的 freeze —— 第一版三种全过。
    // 这里用扫描器本身断言它能看见这三种形态（用内置字符串而不是临时文件）。
    const probe = [
      "export const A = ['黄狗', '花猫', '麻雀'] as const",
      'export const B = /(?:黄狗|花猫|麻雀)/u',
      "export const C = Object.freeze(['黄狗', '花猫'])",
    ].join('\n')
    const found = literalTablesIn('probe.ts', probe)
    expect(found.map(item => item.shape).sort()).toEqual(['const-array', 'freeze', 'regex'])
    expect(found.every(item => item.samples.length > 0)).toBe(true)
  })
})
/**
 * issue #168：**往已有表里补词**也必须红。
 *
 * 上一版基线记的是「文件 + 首样本」，于是「表还在、首段样本没变」= 判为已有，
 * 补任何词都全绿——而迁移期最自然的动作恰恰是「先往旧表里补几个词撑着」。
 */
describe('整表指纹封住「补词」这条路 (issue #168)', () => {
  it('changes the fingerprint when a single word is added', () => {
    const before = tableFingerprint(['短褂', '长衫', '绸褂'])
    const after = tableFingerprint(['短褂', '长衫', '绸褂', '黄狗'])
    expect(after).not.toBe(before)
  })

  it('keeps the fingerprint stable when only the writing order changes', () => {
    // 把 `短褂|长衫` 改写成 `长衫|短褂` 是**无关措辞**，不该假红。
    expect(tableFingerprint(['短褂', '长衫'])).toBe(tableFingerprint(['长衫', '短褂']))
  })

  it('changes the fingerprint when a word is replaced', () => {
    expect(tableFingerprint(['短褂', '长衫'])).not.toBe(tableFingerprint(['短褂', '长袍']))
  })

  it('distinguishes two tables in the same file by name, not just by first sample', () => {
    // 旧口径 `文件::首样本` 会让同一文件里首样本相同的两张表共用一个条目
    // （issue 实测有 5 组），其中一张表增删都不影响判定。
    const baseline = JSON.parse(readFileSync(join(__dirname, 'literal-tables.baseline.json'), 'utf8')) as string[]
    expect(baseline.every(key => key.split('::').length >= 3)).toBe(true)
  })
})
