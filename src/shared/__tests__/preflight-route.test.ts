import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { groupPreflightRoutes, preflightRouteOf } from '../preflight-route'

/**
 * issue #137：预检提醒每条都要能指出「该去哪一层改」。
 *
 * 本测试只钉**分派**这一层（生成补丁与差异确认是它的下游）：
 * 层要判对、写前不可改的两类要如实标出原因、一组提醒要能按层归并。
 */
describe('preflightRouteOf (issue #137)', () => {
  it('routes each family to the layer that owns it', () => {
    expect(preflightRouteOf('ability-limit:bypass:13').layer).toBe('world')
    expect(preflightRouteOf('cast:appearance-gap:林棠').layer).toBe('cast')
    expect(preflightRouteOf('handwriting:conflict:叶九').layer).toBe('cast')
    expect(preflightRouteOf('synopsis-cast:unplanned:26').layer).toBe('outline')
    expect(preflightRouteOf('chapter-title:duplicate:15:21').layer).toBe('blueprint')
    expect(preflightRouteOf('chapter-time:anchor-unmet:45').layer).toBe('blueprint')
    expect(preflightRouteOf('prop:revival:票根').layer).toBe('prose')
  })

  it('gives a destination page for every layer', () => {
    expect(preflightRouteOf('ability-limit:bypass:13').destination).toEqual({ kind: 'stage', stage: 'setup' })
    expect(preflightRouteOf('cast:absent:全叔').destination).toEqual({ kind: 'stage', stage: 'setup' })
    expect(preflightRouteOf('arc:unplanned:3').destination).toEqual({ kind: 'stage', stage: 'architecture' })
    expect(preflightRouteOf('chapter-opening:scene-first:9').destination).toEqual({ kind: 'stage', stage: 'blueprint' })
  })

  it('marks prose-layer findings as not repairable before drafting, and says why', () => {
    // 读已定稿正文的判据，在写前这一刻改不了（本章正文还不存在）。
    const route = preflightRouteOf('prose:sentence-reuse:59:周叙看了两息')
    expect(route.layer).toBe('prose')
    expect(route.repairable).toBe(false)
    expect(route.blockedBy).toBe('needs-finalized-prose')
  })

  it('marks plan-layer findings repairable: they have writable channels and need no prose', () => {
    // ⚠️ `chapter-time:undated` 已从这一组移出（issue #212）：它是**区间型**（要改第 A–B 章
    // 一整段），写前那一刻改不了。它原来在这里被断言成可修，而那正是本条要修的错误标记。
    for (const key of ['ability-limit:bypass:13', 'cast:name-drift:23', 'blueprint:key-events:oversize:7']) {
      expect(preflightRouteOf(key), key).toMatchObject({ repairable: true })
    }
  })

  it('falls back conservatively on an unknown key instead of guessing a writable layer', () => {
    const route = preflightRouteOf('some-brand-new-judge:whatever:1')
    expect(route.repairable).toBe(false)
    expect(route.blockedBy).toBe('unknown-layer')
  })

  it('groups findings by layer in a fixed order, keeping every key', () => {
    const groups = groupPreflightRoutes([
      { stableFactKey: 'prop:revival:票根' },
      { stableFactKey: 'ability-limit:bypass:13' },
      { stableFactKey: 'cast:absent:全叔' },
      { stableFactKey: 'chapter-time:undated:1' },
      { stableFactKey: 'cast:thin:林棠' },
    ])
    expect(groups.map(group => group.layer)).toEqual(['world', 'cast', 'blueprint', 'prose'])
    // 同层归并：两条 cast 在一组（「全部修复」按层调用一次，而不是每条一次）。
    expect(groups.find(group => group.layer === 'cast')!.ks).toEqual(['cast:absent:全叔', 'cast:thin:林棠'])
    expect(groups.find(group => group.layer === 'world')!.repairable).toBe(true)
    expect(groups.find(group => group.layer === 'prose')!.repairable).toBe(false)
  })

  /* ─────────── 结构性守卫：新判据不得静默落到 unknown-layer ─────────── */

  /**
   * 穷举仓库里所有 `stableFactKey:` 字面量，断言每个前缀都能被分派。
   *
   * 与 `acknowledgement-title.test.ts` 同一手法：那条守的是「键能翻成人话」，
   * 这条守的是「键能定位到层」。⚠️ 两者分开是刻意的——一个判据可以没有专属标签
   * （落到族标签），但**必须有层**，否则作者点「修复」时不知道去哪。
   */
  it('every stableFactKey literal in the repo routes to a known layer', () => {
    const roots = [join(__dirname, '..'), join(__dirname, '..', '..', '..', 'electron')]
    const unrouteable: string[] = []
    for (const root of roots) {
      for (const file of walk(root)) {
        const source = readFileSync(file, 'utf8')
        // 只认**代码里的真实赋值**：`stableFactKey: ` + 引号字面量。
        //
        // ⚠️ 两条踩过的坑，都在这一个正则里：
        // 1. 注释与文档串里也会出现 `stableFactKey:` 紧跟文字（#120 栽过同类假命中）。
        //    只认**紧跟引号**的形态，注释里的中文/说明文字不会命中。
        // 2. 这个正则曾经混进一个不可见的控制字符（``），于是整条守卫**静默失效**——
        //    它永远匹配不到任何东西、永远通过，2026-11-04 新增的 `character-age:*` 键
        //    就这样漏登记进了 `unknown-layer`。守卫生效的证据是「它曾经红过」，不是「它一直绿」。
        for (const match of source.matchAll(/stableFactKey:\s*([`'"])([^`'"]*)/gu)) {
          const raw = match[2]!
          const beforeDynamic = raw.split('${')[0]!.replace(/:\s*$/u, '')
          if (!beforeDynamic) continue
          // 只认**键形**（含冒号或全小写连字符族名）：文档里的整句话不会命中。
          if (!/^[a-z][a-z0-9-]*(?::|$)/u.test(beforeDynamic)) continue
          const probe = beforeDynamic.endsWith(':') ? `${beforeDynamic}x` : beforeDynamic
          if (preflightRouteOf(probe).blockedBy === 'unknown-layer') {
            unrouteable.push(`${file.slice(join(__dirname, '..', '..', '..').length + 1)} :: ${raw}`)
          }
        }
      }
    }
    expect(unrouteable).toEqual([])
  })
})

function walk(dir: string): string[] {
  const found: string[] = []
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return found }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'release', '.git', '__tests__'].includes(entry.name)) continue
      found.push(...walk(full))
      continue
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
    found.push(full)
  }
  return found
}
/**
 * issue #137 在途实现的漏项：`repairable` 只看「层」，没看「问题章有没有定稿」。
 *
 * 实测那本书 39 条提醒里 30 条被标成 `repairable: true`，而它们的 `sourceChapter`
 * 全部早于当前章——照那个标记做「一键修复」，改的是**已定稿的旧章**，而旧章改不动。
 */
describe('preflightRouteOf 的第二维：源章 vs 当前章 (issue #137)', () => {
  it('marks a finding whose chapter is already finalized as not repairable now', () => {
    // 本章蓝图声明了日界而正文没写——但那一章早就定稿了。
    const route = preflightRouteOf('chapter-time:anchor-unmet:45', { currentChapter: 70, sourceChapter: 45 })
    expect(route.layer).toBe('blueprint')
    expect(route.repairable).toBe(false)
    expect(route.blockedBy).toBe('needs-finalized-prose')
  })

  it('keeps plan-layer findings repairable when they belong to the upcoming chapter', () => {
    // 用单章形态的键（`chapter-time:anchor-unmet`）：那一章的时点就落在一张蓝图上，本章能改。
    const route = preflightRouteOf('chapter-time:anchor-unmet:70', { currentChapter: 70, sourceChapter: 70 })
    expect(route.repairable).toBe(true)
    expect(route.targetChapter).toBe(70)
    // 对照：区间型同一族但**不可修**（issue #212）。
    expect(preflightRouteOf('chapter-time:undated:1', { currentChapter: 70, sourceChapter: 70 }).repairable).toBe(false)
  })

  it('keeps the old one-dimensional behaviour when no chapter numbers are given', () => {
    // 只问「去哪一层」的调用方（如批量对话框）不需要第二维。
    expect(preflightRouteOf('chapter-time:anchor-unmet:45')).toMatchObject({ repairable: true })
  })

  it('divides a layer group into fixable and blocked keys instead of merging them', () => {
    const groups = groupPreflightRoutes([
      // 本章能改的那条：时点落在**本章**蓝图（sourceChapter = 当前章）。
      { stableFactKey: 'chapter-time:anchor-unmet:70', sourceChapter: 70 },
      // 改不了的：旧章（45 < 70）；区间型（issue #212，目标在 key 的首章）。
      { stableFactKey: 'chapter-time:anchor-unmet:45', sourceChapter: 45 },
      { stableFactKey: 'chapter-time:undated:1', sourceChapter: 70 },
      { stableFactKey: 'prop:revival:票根', sourceChapter: 60 },
    ], { currentChapter: 70 })
    const blueprint = groups.find(group => group.layer === 'blueprint')!
    expect(blueprint.ks).toEqual(['chapter-time:anchor-unmet:70'])
    expect(blueprint.blocked).toEqual(['chapter-time:anchor-unmet:45', 'chapter-time:undated:1'])
    expect(blueprint.repairable).toBe(true)
    // prose 层整组都不可修，且带原因。
    const prose = groups.find(group => group.layer === 'prose')!
    expect(prose.ks).toEqual([])
    expect(prose.blocked).toEqual(['prop:revival:票根'])
    expect(prose.repairable).toBe(false)
    expect(prose.blockedBy).toBe('needs-finalized-prose')
  })

  it('reports a wholly-blocked group as not repairable with the reason', () => {
    const [group] = groupPreflightRoutes([{ stableFactKey: 'chapter-ending:label-mismatch:63', sourceChapter: 63 }], { currentChapter: 70 })
    expect(group!.repairable).toBe(false)
    expect(group!.blockedBy).toBe('needs-finalized-prose')
  })
})

/**
 * issue #212：**「要改哪一章」不等于「来源章」**。
 *
 * 现场（写第 95 章、46 条提醒）：
 * - 44 条被标成「落在已定稿的章上」，其中一大半其实是「第 42–55 章连着 14 章没跨日」这种
 *   多章形态——重开一章也解决不了；
 * - 只有 2 条给了按钮，而那 2 条把**第 95 章**的蓝图交给模型去改第 42–55 章的问题 →
 *   模型只能回「不需要改」；
 * - 最该在本章解决的两条（「反派叶九已连续 6 章没进蓝图」）反而被判死，
 *   同屏建议写「安排一次登场」、阻断文案写「去重开第 89 章」——两句话互相矛盾。
 */
describe('targetChapter：来源章 ≠ 要改的章 (issue #212)', () => {
  it('lets a current-chapter fix win over an old source chapter', () => {
    // 来源是第 89 章（他上次出现的地方），出路「让他回来」做的是本章的事。
    const route = preflightRouteOf('cast:absent:叶九:89', { currentChapter: 95, sourceChapter: 89 })
    expect(route.repairable).toBe(true)
    expect(route.targetChapter).toBe(95)
  })

  it('names the old chapter when the finding really does belong to it', () => {
    const route = preflightRouteOf('chapter-title:duplicate:15:21', { currentChapter: 95, sourceChapter: 21 })
    expect(route.repairable).toBe(false)
    expect(route.blockedBy).toBe('needs-finalized-prose')
    // 文案要能点名「第 21 章」，而不是一句笼统的「那一章」。
    expect(route.targetChapter).toBe(21)
  })

  it('refuses an interval-shaped finding even though its sourceChapter IS the current chapter', () => {
    /**
     * ⚠️ 这条要按**生产真实形状**喂：`chapter-time:undated` 报的 `sourceChapter`
     * 是**当前章**（`chapter-time-anchor.ts` 写的是 `currentChapter`），不是区间末章。
     * 所以旧口径 `sourceChapter >= currentChapter` 恰好成立 → 被判成「现在就能修」，
     * 而修复固定用当前章读层文本 → 拿第 95 章的蓝图去改第 42–55 章的问题。
     * 目标章必须从 **key**（区间首章）读，不能从 sourceChapter 读。
     */
    const route = preflightRouteOf('chapter-time:undated:42', { currentChapter: 95, sourceChapter: 95 })
    expect(route.repairable).toBe(false)
    expect(route.blockedBy).toBe('needs-finalized-prose')
    expect(route.targetChapter).toBe(42)
  })

  it('reads the interval target from the key even without any chapter options', () => {
    expect(preflightRouteOf('chapter-time:undated:42').repairable).toBe(false)
    expect(preflightRouteOf('chapter-time:undated:42').targetChapter).toBe(42)
  })

  it('falls back to no targetChapter when the caller gives no chapters', () => {
    expect(preflightRouteOf('cast:absent:叶九:89').targetChapter).toBeUndefined()
    expect(preflightRouteOf('cast:absent:叶九:89').repairable).toBe(true)
  })
})

/**
 * issue #226：`timeline:design-anchor:*` 的 `sourceChapter` 是**记账占位章号**（判据写死 1，
 * 「架构阶段没有章号」），不是真章号。旧口径拿它当真：占位 1 恒小于当前章 N →
 * 被判成「旧章、写前改不了」，卡片渲染「去第 1 章出新版本」；「去设定改」「修复」
 * 两颗按钮永远不出现。点过去落在第 1 章正文重写页，与要改的设定层文本毫无关系
 * （用户原话：「跳过了跳到第一章，然后呢，然后就没有然后了呀」）。
 *
 * 设定层文本不按章存储——改设定页就是全书的权威，没有「旧章」概念。
 */
describe('占位章号不进旧章拦截 (issue #226)', () => {
  it('routes a design-anchor finding to the world layer as repairable, never as an old chapter', () => {
    // 当前章 95、占位源章 1 —— 旧实现在这里给出 repairable:false + targetChapter:1。
    const route = preflightRouteOf('timeline:design-anchor:落水', {
      currentChapter: 95, sourceChapter: 1,
    })
    expect(route.layer).toBe('world')
    expect(route.repairable).toBe(true)
    expect(route.blockedBy).toBeUndefined()
    expect(route.targetChapter).not.toBe(1)
  })

  it('does not offer the "make a new version of chapter N" exit for the placeholder', () => {
    // needs-finalized-prose 是「去第 N 章出新版本」按钮的唯一渲染条件（WritePreflight）。
    const route = preflightRouteOf('timeline:design-anchor:落水', {
      currentChapter: 95, sourceChapter: 1,
    })
    expect(route.blockedBy).not.toBe('needs-finalized-prose')
  })

  it('keeps real old-chapter findings blocked (the placeholder carve-out must not widen)', () => {
    // 真旧章判据不受影响：蓝图层的真章号 < 当前章 → 仍走旧章拦截。
    const route = preflightRouteOf('chapter-title:unmet:45', {
      currentChapter: 95, sourceChapter: 45,
    })
    expect(route.repairable).toBe(false)
    expect(route.blockedBy).toBe('needs-finalized-prose')
    expect(route.targetChapter).toBe(45)
  })
})
