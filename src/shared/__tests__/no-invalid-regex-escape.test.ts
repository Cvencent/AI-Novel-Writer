import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 模板字符串里**不能**写单反斜杠的 `\s` / `\d` / `\w` / `\b` 等（issue #141）。
 *
 * 实测事故：`src/shared/gauge-scale.ts` 有三处 `new RegExp(\`...\s*...\`)`——
 * 模板字符串里 `\s` **不是转义序列**，会退化成字母 `s`，正则变成「允许 0 个或多个字母 s」。
 *
 * 为什么危险：中文正文里数字与量词之间本来就没有字母 s，`s*` 匹配 0 次 →
 * **正则照样匹配、结果在无空格文本上完全正确**。只有在「三十二 个人」这类
 * 带空格的写法上才会静默漏匹配。也就是说：**不报错、不崩、测试也测不出来**。
 *
 * 所以这条测试比「改那三处」更重要：它扫全仓，挡的是同型写法扩散。
 */
const INVALID_ESCAPES = ['s', 'd', 'w', 'b', 'S', 'D', 'W', 'B'] as const
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-electron', 'release', '.git', '.qa', '.runtime'])

function scanSource(relativePath: string, source: string): string[] {
  const offenders: string[] = []
  const marker = 'new RegExp(`'
  let from = 0
  for (;;) {
    const start = source.indexOf(marker, from)
    if (start < 0) break
    let cursor = start + marker.length
    let body = ''
    let closed = false
    while (cursor < source.length) {
      const character = source[cursor]!
      // 双反斜杠整体跳过（那才是合法的写法）。
      if (character === '\\') { body += source.slice(cursor, cursor + 2); cursor += 2; continue }
      if (character === '`') { closed = true; break }
      body += character
      cursor += 1
    }
    if (!closed) { from = start + marker.length; continue }
    const line = source.slice(0, start).split('\n').length
    for (const escape of INVALID_ESCAPES) {
      // 单反斜杠（前面不是反斜杠）紧跟该字母。
      if (new RegExp('(^|[^\\\\])\\\\' + escape, 'u').test(body)) {
        offenders.push(`${relativePath}:${line} \\${escape}`)
      }
    }
    from = cursor + 1
  }
  return offenders
}

function walk(dir: string, root: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...walk(full, root))
      continue
    }
    if (!/\.(ts|tsx|mjs|cjs)$/u.test(entry.name)) continue
    // 测试自身会刻意构造坏样例，跳过。
    if (/\.(test|probe)\.(ts|tsx)$/u.test(entry.name)) continue
    const relative = full.slice(root.length + 1).replace(/\\/gu, '/')
    found.push(...scanSource(relative, readFileSync(full, 'utf8')))
  }
  return found
}

describe('模板串里的正则转义必须写双反斜杠 (issue #141)', () => {
  // __dirname = <repo>/src/shared/__tests__ → 三层才回到仓库根。
  const root = join(__dirname, '..', '..', '..')

  it('has template-built regexes to check (guards against a vacuous test)', () => {
    // 否则「没命中」可能只是因为这些目录里根本没有 `new RegExp(` 的模板写法。
    const sources = readdirSync(join(root, 'src', 'shared'))
      .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map(name => readFileSync(join(root, 'src', 'shared', name), 'utf8'))
    expect(sources.filter(text => text.includes('new RegExp(`')).length).toBeGreaterThan(3)
  })

  it('no source file uses a single-backslash escape inside a template regex', () => {
    expect([...walk(join(root, 'src'), root), ...walk(join(root, 'electron'), root)]).toEqual([])
  })

  it('the checker itself catches the historic defect', () => {
    // 反例自检：本仓确实栽过这三行（issue #141），判据必须真的能认出来。
    const bad = "const A = new RegExp(`(${QUANTITY})\\s*(?:张票|个人)`, 'gu')"
    expect(scanSource('fixture.ts', bad).length).toBe(1)
    // 合法写法（双反斜杠）不能命中。
    const good = "const A = new RegExp(`(${QUANTITY})\\\\s*(?:张票|个人)`, 'gu')"
    expect(scanSource('fixture.ts', good)).toEqual([])
    // 单引号串里的 \s 是合法转义，不归本判据管。
    const quoted = "const A = new RegExp('\\\\s*')"
    expect(scanSource('fixture.ts', quoted)).toEqual([])
  })
})