import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  acknowledgementFamilyTitle,
  acknowledgementKnownPrefixes,
  acknowledgementTitleOf,
} from '../acknowledgement-title'

/**
 * 「我已知，稍后处理」区不得再渲染内部键（issue #120）。
 *
 * 现象：弹层底部的「已标记稍后处理（N）」折叠区直接渲染 `stableFactKey`——
 * 作者挂起 16 条提醒后，回看时看到 `chapter-opening:scene-first:41`、`prop:revival:内襟`、
 * `foreshadowing:undelivered:15:19`，认不出任何一条，也不知道「恢复提醒」会冒出什么。
 *
 * 根因在存储层（`consistency_acknowledgements` 只有键与时间两列），所以标题由服务层补。
 * **这条测试的核心价值是结构性的**：它不是检查某几条文案，而是**穷举仓库里所有
 * `stableFactKey` 字面量**，断言每一个前缀都能被译成人话——新判据若忘了登记，
 * 测试立刻红（这正是 #112 那类「第四、第五个出口」反复漏的根治办法）。
 */

const ROOT = join(__dirname, '..', '..', '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', 'release', '.runtime', '.qa', 'dist', 'dist-electron', '__tests__'].includes(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/u.test(name)) out.push(full)
  }
  return out
}

/**
 * 抽出源码里所有 `stableFactKey: \`…\`` 字面量的**静态前缀**（到第一个 `${` 为止）。
 *
 * ⚠️ 只认**反引号/引号包起来的字符串值**——`stableFactKey: string`（类型标注）与
 * 注释里的 `stableFactKey:` 都不是产出点（第一版把注释也扫进来了，测试自己报了假阳性）。
 */
function stableFactKeyPrefixes(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const file of walk(join(ROOT, 'src')).concat(walk(join(ROOT, 'electron')))) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/stableFactKey:\s*([`'"])([^`'"]*)\1/gu)) {
      const raw = match[2]!
      // 静态前缀 = 去掉所有 `${…}` 之后、按 `:` 分段的已确定部分。
      const beforeDynamic = raw.split('${')[0]!
      const prefix = beforeDynamic.replace(/:\s*$/u, '')
      if (!prefix) continue
      const list = found.get(prefix) ?? []
      if (!list.includes(file)) list.push(file)
      found.set(prefix, list)
    }
  }
  return found
}

describe('ack 区不再渲染内部键 (issue #120)', () => {
  it('每个 stableFactKey 前缀都能译出人话（穷举仓库字面量）', () => {
    const prefixes = [...stableFactKeyPrefixes().keys()]
    // 防「空转」：字面量必须真的扫到了。
    expect(prefixes.length).toBeGreaterThan(30)
    const untranslated: string[] = []
    for (const prefix of prefixes) {
      const translated = acknowledgementFamilyTitle(prefix)
      // 兜底文案 = 没登记（`FALLBACK` 的 zhCN 是「一致性提醒」）。
      if (translated.zhCN === '一致性提醒') untranslated.push(prefix)
    }
    expect(untranslated).toEqual([])
  })

  it('翻译结果本身不能再是键的形态（可达性要求）', () => {
    for (const prefix of acknowledgementKnownPrefixes()) {
      const { zhCN, enUS } = acknowledgementFamilyTitle(prefix)
      expect(zhCN, prefix).not.toMatch(/^[a-z-]+(:[a-z-]+)*$/u)
      expect(enUS, prefix).not.toMatch(/^[a-z-]+(:[a-z-]+)*$/u)
      expect(zhCN.length).toBeGreaterThan(1)
    }
  })

  it('最长匹配生效（两段优先于一段）', () => {
    expect(acknowledgementFamilyTitle('prose-flavor:motif:41').zhCN).toBe('同一意象反复承担情绪')
    expect(acknowledgementFamilyTitle('chapter-ending:subjectless-pending').zhCN).toBe('末句都是「物 + 未完结 + 无人称」')
    expect(acknowledgementFamilyTitle('prop:revival:内襟').zhCN).toBe('被写死的物证又自己回来')
    // 只认得一段时退回一段。
    expect(acknowledgementFamilyTitle('thread:some-new-suffix:7').zhCN).toBe('叙事线索停摆/逾期')
  })

  it('认不出的键有兜底，且兜底也不吐键', () => {
    const title = acknowledgementFamilyTitle('some-brand-new-detector:x:1')
    expect(title.zhCN).toBe('一致性提醒')
    expect(title.zhCN).not.toContain(':')
  })

  it('当轮仍命中的那条用 finding 原文（首句），并仍可在悬浮里定位', () => {
    const finding = { issue: { zhCN: '章首句式收敛：最近 6 章里 5 章的**开篇句**是同一个句式。连着十几章这样开场。', enUS: 'Openings converged: five of six. More detail follows here.' } }
    const title = acknowledgementTitleOf('chapter-opening:scene-first', finding)
    // ⚠️ 断言「原文首句」，但**粗体标记必须已剥离**（issue #154）：ack 区是纯文本一行标题，
    // 一行里出现两对 `**` 就完全读不出这是什么。这条断言原来把带星号的文案钉成了规格。
    expect(title.zhCN).toBe('章首句式收敛：最近 6 章里 5 章的开篇句是同一个句式。')
    expect(title.zhCN).not.toContain('*')
    expect(title.zhCN).not.toContain('chapter-opening')
    // 英文用 `.` 结尾，也要能在句末切开（第一版只认中文标点，英文整段被硬截）。
    expect(title.enUS).toBe('Openings converged: five of six.')
  })

  it('配不上 finding 时用封闭目录 + 注明「已不再报出」', () => {
    const title = acknowledgementTitleOf('prop:revival:内襟', null)
    expect(title.zhCN).toContain('被写死的物证又自己回来')
    expect(title.zhCN).toContain('已不再报出')
    expect(title.zhCN).not.toContain('prop:revival')
  })

  it('超长 finding 首句按 maxChars 截断（不把整段塞进一行）', () => {
    const long = { issue: { zhCN: '甲'.repeat(300), enUS: 'x'.repeat(300) } }
    const title = acknowledgementTitleOf('cast:absent:温珩:20', long, 20)
    expect(title.zhCN.length).toBeLessThanOrEqual(21)
    expect(title.zhCN.endsWith('…')).toBe(true)
  })

  it('渲染层不再直接显示 stableFactKey', () => {
    const source = readFileSync(join(ROOT, 'src', 'components', 'stage', 'write', 'WritePreflight.tsx'), 'utf8')
    // 旧的 `><span>{item.stableFactKey}</span>` 形态必须消失；键只允许出现在 key=/title= 属性里。
    expect(source).not.toMatch(/<span>\{item\.stableFactKey\}<\/span>/u)
    expect(source).toContain('item.title')
  })
})