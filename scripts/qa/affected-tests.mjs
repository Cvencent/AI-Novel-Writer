/* global process */
/**
 * 按「改动的源文件」挑出相关测试（发布/验证提速）。
 *
 * 为什么需要：全量 `pnpm exec vitest run src/shared src/services electron/services
 * electron/repositories` 实测 156 秒，其中 electron/ 一项就 130 秒；而一轮修复真正
 * 可能影响的测试通常只有 5–10 个文件，跑完约 6 秒。把「跑全量」当成默认门禁，
 * 时间全花在与改动无关的用例上。
 *
 * 选法（保守，宁可多选）：
 *  1. 同名约定：`foo.ts` → `foo.test.ts` / `foo.test.mjs` / `__tests__/foo.test.ts`；
 *  2. 反向导入：测试文件里 import/require 了改动文件（含相对路径归一化）；
 *  3. 同目录：改动文件所在目录的 `__tests__/*` —— 同目录测试常共享 fixture。
 *
 * 用法：
 *   node scripts/qa/affected-tests.mjs                # 用 git status 的改动
 *   node scripts/qa/affected-tests.mjs --staged       # 只看已暂存
 *   node scripts/qa/affected-tests.mjs src/a.ts ...   # 指定文件
 *   node scripts/qa/affected-tests.mjs --run          # 直接交给 vitest 跑
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
// 本文件在 scripts/qa/ 下：仓库根要往上两级，不是一级。
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..', '..')

const TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx|mjs|js)$/u

function git(args) {
  const result = spawnSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true })
  if (result.error) throw result.error
  return String(result.stdout ?? '')
}

/** 工作区里改动过的、已跟踪的源文件（未跟踪的调试脚本不算）。 */
export function changedFiles({ staged = false } = {}) {
  const args = staged ? ['diff', '--name-only', '--cached', '--diff-filter=ACMR'] : ['status', '--porcelain']
  if (staged) return git(args).split(/\r?\n/u).filter(Boolean).map(p => p.replace(/\\/gu, '/'))
  return git(args).split(/\r?\n/u).filter(line => /^[ MARC][MDARC] /u.test(line))
    .map(line => line.slice(3).trim().replace(/\\/gu, '/')).filter(Boolean)
}

function isTestFile(file) {
  return TEST_FILE.test(file)
}

function walkTests(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkTests(full, out)
    else if (isTestFile(full)) out.push(path.relative(repositoryRoot, full).replace(/\\/gu, '/'))
  }
  return out
}

/** 预扫一遍仓库里的测试文件（一次读全，避免每个改动文件都全盘 grep）。 */
function allTestFiles() {
  const roots = ['src', 'electron', 'scripts', 'test']
  return roots.flatMap(root => walkTests(path.join(repositoryRoot, root)))
}

/** 测试文件是否引用了某个源模块（按去掉扩展名的 basename 粗匹配，避免解析 tsconfig path）。 */
function referencesModule(testFile, moduleStem) {
  let text
  try { text = readFileSync(path.join(repositoryRoot, testFile), 'utf8') } catch { return false }
  if (!/\bimport\b|\brequire\(/u.test(text)) return false
  // 只认 import/require 行，避免注释或普通字符串造成假命中。
  for (const match of text.matchAll(/(?:import[\s\S]{0,400}?from\s*|require\(\s*)['"]([^'"]+)['"]/gu)) {
    const specifier = match[1]
    if (specifier.replace(/\/index$/u, '').endsWith(`/${moduleStem}`) || specifier === `.${moduleStem}`) return true
  }
  return false
}

/** 找出仓库里 import 了某个模块的源文件（一跳反向依赖）。 */
function importersOf(moduleStem, sources) {
  return sources.filter(file => file !== moduleStem && referencesModule(file, moduleStem))
}

/** 所有待扫的源文件（用于找反向依赖）；只扫源码目录，跳过测试与构建产物。 */
function allSourceFiles() {
  const roots = ['src', 'electron']
  const out = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!/\.(?:ts|tsx)$/u.test(entry.name) || isTestFile(entry.name)) continue
      out.push(path.relative(repositoryRoot, full).replace(/\\/gu, '/'))
    }
  }
  for (const root of roots) walk(path.join(repositoryRoot, root))
  return out
}

/** 改动文件 → 候选测试文件（去重、稳定排序）。 */
export function affectedTests(files, tests = allTestFiles(), sources = allSourceFiles(), options = {}) {
  const picked = new Set()
  const queue = []
  for (const raw of files) {
    const file = raw.replace(/\\/gu, '/')
    if (!file || file.startsWith('release/') || file.startsWith('.runtime/')) continue
    if (isTestFile(file)) { picked.add(file); continue }
    if (!/\.(?:ts|tsx|mjs|js)$/u.test(file)) continue
    queue.push(file)
  }
  // 一跳反向依赖：改了 shared/foo.ts，测试未必直接 import 它，而是 import 了用它的
  // directory.command.ts。少了这一跳，共享层的改动会被判成「只有 1 个测试」。
  // `--fast` 跳过这一跳：迭代时只要直接行为，提交前再跑完整版。
  for (const file of (options.transitive === false ? [] : [...queue])) {
    const stem = path.basename(file).replace(/\.(?:ts|tsx|mjs|js)$/u, '')
    for (const importer of importersOf(stem, sources)) {
      if (!queue.includes(importer) && queue.length < 40) queue.push(importer)
    }
  }

  for (const file of queue) {
    const stem = path.basename(file).replace(/\.(?:ts|tsx|mjs|js)$/u, '')
    const dir = path.dirname(file)

    // ① 同名约定
    for (const candidate of [`${dir}/__tests__/${stem}.test.ts`, `${dir}/__tests__/${stem}.test.tsx`,
      `${dir}/${stem}.test.ts`, `${dir}/${stem}.test.tsx`, `${dir}/${stem}.test.mjs`, `${dir}/${stem}.test.js`,
      `${dir}/__tests__/${stem}.test.mjs`, `${dir}/__tests__/${stem}.test.js`]) {
      if (existsSync(path.join(repositoryRoot, candidate))) picked.add(candidate)
    }
    // ② 反向导入（最精确：测试文件真的 import 了这个模块）
    for (const test of tests) if (referencesModule(test, stem)) picked.add(test)
    // ③ 同目录测试：只在小目录里用。`src/shared/__tests__/` 装着整个 shared 层的
    // 六七十个测试，对任何一个 shared 文件都「同目录」——那样等于跑全量。
    // 判据看**磁盘上真实目录的大小**，不是本次候选池的大小。
    const siblingDir = path.join(repositoryRoot, dir, '__tests__')
    const siblingTotal = existsSync(siblingDir)
      ? readdirSync(siblingDir).filter(name => isTestFile(name)).length
      : 0
    if (siblingTotal > 0 && siblingTotal <= 8) {
      for (const test of tests) if (path.dirname(test) === `${dir}/__tests__`) picked.add(test)
    }
  }
  return [...picked].sort()
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const args = process.argv.slice(2)
  const staged = args.includes('--staged')
  const fast = args.includes('--fast')
  const shouldRun = args.includes('--run')
  const explicit = args.filter(arg => !arg.startsWith('--'))
  const files = explicit.length > 0 ? explicit : changedFiles({ staged })
  const allTests = allTestFiles()
  const allSources = allSourceFiles()
  const tests = affectedTests(files, allTests, allSources, { transitive: !fast })

  if (files.length === 0) {
    console.log('no changed source files; nothing to verify')
    process.exit(0)
  }
  console.log(`changed: ${files.length} file(s)`)
  if (tests.length === 0) {
    console.log('no related test files found — run the full suite if the change touches shared contracts')
    process.exit(0)
  }
  console.log(`related tests: ${tests.length}`)
  for (const test of tests) console.log(`  ${test}`)
  // 改动落在被广泛 import 的模块上时，「相关测试」本身就接近全量了：
  // 与其让人误以为覆盖完整，不如直说该跑全量。
  if (tests.length > 40) {
    console.log('\nNOTE: this change reaches many tests — prefer the full suite for a contract-level change.')
  }

  if (shouldRun) {
    const result = spawnSync('pnpm', ['exec', 'vitest', 'run', ...tests], {
      cwd: repositoryRoot, stdio: 'inherit', shell: true, windowsHide: true,
    })
    process.exit(result.status ?? 1)
  }
}
