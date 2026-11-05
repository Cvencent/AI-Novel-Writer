import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 扫描工具：找出「可能用于判断内容的中文词表/正则」（issue #163）。
 *
 * 单独成模块（而不是塞进测试里）是因为它要被**两处**共用：
 * - `no-content-wordlists.test.ts` 用它做守卫；
 * - 迁移时用它做盘点（本轮就是靠它数出 77 张）。
 *
 * ⚠️ 判据只看**形态**，不看词义：它无法判断「这张表是不是在判断内容」——
 * 那需要语义理解。所以它输出的是**候选清单**，由人工（连同 issue 编号）决定哪些该迁。
 */

/** 剥掉块注释与行注释（只用于扫描；`//` 前必须不是 `:`，避免误伤 `https://`）。 */
export function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1')
}

/** 一段文字里是否含 ≥min 个**连续汉字**（= 判据里出现了中文词，而不是纯符号/英文）。 */
export function hasChineseRun(text: string, min = 2): boolean {
  return new RegExp(`[\\u4e00-\\u9fff]{${min},}`, 'u').test(text)
}

export interface LiteralTable {
  file: string
  /** 表名（`const X = ...` 的 X；正则字面量取所在变量名；取不到时给 `<inline>`）。 */
  name: string
  /** 形态：freeze 数组 / as const 数组 / 正则字面量 / Record 内联数组。 */
  shape: 'freeze' | 'const-array' | 'regex' | 'record-array'
  /** 表里出现的连续汉字片段（供人工判断是形式类还是内容类）。 */
  samples: string[]
}

const FILE_FILTER = (name: string) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.probe.ts')

/** 收集一个源文件里的候选表。 */
export function literalTablesIn(file: string, source: string): LiteralTable[] {
  const code = codeOnly(source)
  const found: LiteralTable[] = []

  /** 从匹配位置往前找最近的 `const X =` / `X:` 名字。 */
  /**
   * 从匹配位置往前找最近的表名。
   *
   * ⚠️ `lead` 是这次匹配**带上的那个前缀字符**（`=` / `(` / `,` / `:` / `return` / `=>`）：
   * 正则字面量的 `match.index` 指向的是前缀字符本身，窗口切到它**之前**，
   * 于是 `const X =` 的 `=` 落在窗外、匹配不到 → 一律取到 `<inline>`（issue #168 建议 ②：
   * 表名必须进 key，否则同一文件的两张表会共用一个条目）。把前缀拼回去即可。
   */
  const nameBefore = (code: string, at: number, lead = ''): string => {
    const window = code.slice(Math.max(0, at - 200), at) + lead
    const assign = [...window.matchAll(/(?:const|let|export const)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*$/gu)].at(-1)
    if (assign) return assign[1]!
    const record = [...window.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*$/gu)].at(-1)
    return record ? record[1]! : '<inline>'
  }

  // 形态 A：Object.freeze([...])
  for (const match of code.matchAll(/Object\.freeze\(\s*\[([\s\S]{0,2000}?)\]\s*(?:as const\s*)?\)/gu)) {
    const body = match[1]!
    if (!hasChineseRun(body)) continue
    found.push({ file, name: nameBefore(code, match.index ?? 0), shape: 'freeze', samples: chineseSamples(body) })
  }

  // 形态 B：普通 `const X = [...] as const` / `const X: readonly string[] = [...]`
  for (const match of code.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]{0,80})?=\s*\[([\s\S]{0,2000}?)\]\s*(?:as const)?\s*$/gmu)) {
    const body = match[2]!
    if (!hasChineseRun(body)) continue
    found.push({ file, name: match[1]!, shape: 'const-array', samples: chineseSamples(body) })
  }

  // 形态 C：正则字面量 /.../u —— 这是最容易漏的一类（issue #163 的实测：守卫对形态 B、C 完全无感）。
  //
  // ⚠️ 只认**赋值/实参位置**的正则：`/…/` 在模板字符串正文里也会出现（提示词里写着
  // 「次日／翌日」这种斜杠列表），第一版把那些也扫进来，126 个"正则"里绝大多数是假报。
  // 判据：字面量前面（跳过空白）是 `=` / `(` / `,` / `:` / `return` / `=>`。
  for (const match of code.matchAll(/([=(,:]|return|=>)\s*(\/(?:[^/\\\n]|\\.){4,400}\/[gimsuy]*)/gu)) {
    const pattern = match[2]!
    if (!hasChineseRun(pattern)) continue
    found.push({
      file,
      // ⚠️ 把前缀字符（`=` `(` `,` …）拼回窗口，否则 `const X =` 的 `=` 落在窗外、取名失败。
      name: nameBefore(code, match.index ?? 0, match[1]!),
      shape: 'regex',
      samples: chineseSamples(pattern),
    })
  }

  // 形态 D：Record<K, readonly string[]> 里的内联数组
  for (const match of code.matchAll(/Record<[^>]{1,80},\s*(?:readonly\s*)?string\[\]>\s*=\s*(?:Object\.freeze\()?\s*\{([\s\S]{0,3000}?)\}\s*(?:\)|as const)?/gu)) {
    const body = match[1]!
    if (!hasChineseRun(body)) continue
    found.push({ file, name: nameBefore(code, match.index ?? 0), shape: 'record-array', samples: chineseSamples(body) })
  }

  return found
}

/**
 * 表里的**全部**中文片段（不截断）。
 *
 * ⚠️ 原来只取前 4 段、守卫只比 `samples[0]` —— 于是「往已有表里补词」完全不触发
 * （issue #168 实测：往 `ENTRANCE_DRESS` 加 `黄狗|花猫|麻雀` 全绿）。
 * 现在取全量，供整表指纹使用。
 */
function chineseSamples(body: string): string[] {
  const runs = [...body.matchAll(/[\u4e00-\u9fff]{2,}/gu)].map(match => match[0])
  return [...new Set(runs)]
}

/**
 * 整表指纹：**排序后**的全部中文样本的哈希（issue #168 建议 ③）。
 *
 * ⚠️ 排序是必需的：不排序时，把 `短褂|长衫` 改写成 `长衫|短褂`（只调书写顺序）
 * 会让指纹变 → 假红；而真正的「加词/换词」必须变 → 真红。排序后两者正好分开。
 */
export function tableFingerprint(samples: readonly string[]): string {
  const canonical = [...samples].map(item => item.trim()).filter(Boolean).sort().join('\u0001')
  let hash = 5381
  for (let index = 0; index < canonical.length; index += 1) {
    hash = ((hash * 33) ^ canonical.charCodeAt(index)) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 扫一个目录（递归，跳过测试与生成目录）。 */
export function scanLiteralTables(root: string): LiteralTable[] {
  const out: LiteralTable[] = []
  const walk = (dir: string): void => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', 'dist-electron', 'release', '.git', '__tests__', '.runtime'].includes(entry.name)) continue
        walk(full)
        continue
      }
      if (!FILE_FILTER(entry.name)) continue
      out.push(...literalTablesIn(full, readFileSync(full, 'utf8')))
    }
  }
  walk(root)
  return out
}