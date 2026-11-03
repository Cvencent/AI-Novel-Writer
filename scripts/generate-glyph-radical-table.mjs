/**
 * 生成 `src/shared/glyph-radical-table.ts`（issue #99）。
 *
 * 数据源是 Unicode UCD 的 `Unihan.zip` → `Unihan_IRGSources.txt` 字段 `kRSUnicode`
 * （康熙 214 部首；1716 年《康熙字典》刊定后序号封闭不变，所以这张表不会漂）。
 * 取 `U+3400–U+9FFF`（CJK 扩展 A + 基本区），按部首序号 1–214 归并成 214 个字符串。
 *
 * 用法：
 *   node scripts/generate-glyph-radical-table.mjs <Unihan.zip 路径> [输出路径]
 *
 * 下载数据：https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip
 * 只用 python 解压 zip（不参与任何判定），其余全在 Node 里做。
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const zipPath = process.argv[2]
const outPath = process.argv[3] ?? 'src/shared/glyph-radical-table.ts'
if (!zipPath) {
  console.error('usage: node scripts/generate-glyph-radical-table.mjs <Unihan.zip> [out.ts]')
  process.exit(2)
}

// python 只负责解压出 IRGSources 文本（Node 没有内置 zip 读取）。
const dump = `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1])
sys.stdout.buffer.write(z.read('Unihan_IRGSources.txt'))
`
const text = execFileSync('python', ['-I', '-c', dump, zipPath], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8')

const byRadical = new Map()
let multiValued = 0
for (const line of text.split('\n')) {
  if (!line || line[0] === '#') continue
  const parts = line.split('\t')
  if (parts.length < 3 || parts[1] !== 'kRSUnicode') continue
  const codePoint = parseInt(parts[0].slice(2), 16)
  if (!(codePoint >= 0x3400 && codePoint <= 0x9fff)) continue
  const values = String(parts[2]).trim().split(/\s+/)
  if (values.length > 1) multiValued += 1
  // `85.9` = 第 85 部；`9.2'` 的单引号表示简化字取自另一部，仍以主部为准（与 Unihan 一致）。
  const radical = parseInt(values[0].replace(/'/g, '').split('.')[0], 10)
  if (!Number.isInteger(radical) || radical < 1 || radical > 214) continue
  if (!byRadical.has(radical)) byRadical.set(radical, [])
  byRadical.get(radical).push(codePoint)
}

const lines = [
  '/**',
  ' * 汉字 → 康熙部首序号（issue #99）。',
  ' *',
  ' * ⚠️ **生成物，不要手改。** 数据源：Unicode UCD `Unihan.zip` 的',
  ' * `Unihan_IRGSources.txt` 字段 `kRSUnicode`（康熙 214 部，1716 年刊定后序号封闭）。',
  ' * 复算：`node scripts/generate-glyph-radical-table.mjs <Unihan.zip>`；',
  ' * 抽样核对与漂移检测见 `src/shared/__tests__/glyph-radical.test.ts`。',
  ' *',
  ' * 覆盖 `U+3400–U+9FFF`（CJK 扩展 A + 基本区）共 27648 个码位，其中 27584 个有部首。',
  ' * 扩展 B 及以后（罕用古字）不在表内：正文里几乎不出现，落空时判据**不报**（宁漏不误报）。',
  ' *',
  ' * 形态：按部首序号 1–214 排列的 214 个字符串，每个字符串含该部下的全部汉字。',
  ' */',
  'export const RADICAL_CHARS_BY_INDEX: readonly string[] = Object.freeze([',
]
let total = 0
for (let radical = 1; radical <= 214; radical += 1) {
  const codePoints = (byRadical.get(radical) ?? []).sort((left, right) => left - right)
  total += codePoints.length
  const chars = codePoints.map(codePoint => String.fromCodePoint(codePoint)).join('')
  lines.push(`  ${JSON.stringify(chars)}, // ${radical} ${String.fromCodePoint(0x2f00 + radical - 1)}`)
}
lines.push('])', '')
writeFileSync(outPath, lines.join('\n'), 'utf8')
console.log(`radicals: ${byRadical.size}, chars: ${total}, multi-valued (took the first): ${multiValued} -> ${outPath}`)
