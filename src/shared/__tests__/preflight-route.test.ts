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
    for (const key of ['ability-limit:bypass:13', 'cast:name-drift:23', 'chapter-time:undated:1', 'blueprint:key-events:oversize:7']) {
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
        // 只认**带引号的真实字面量**（`…` / '…' / "…"）：注释里也会出现 `stableFactKey:` 三个字
        // 紧跟中文（本仓栽过这类假命中，与 #120 的同一手法）。
        for (const match of source.matchAll(/stableFactKey:\s*([`'"])([^`'"]*)/gu)) {
          const raw = match[2]!
          const beforeDynamic = raw.split('${')[0]!.replace(/:\s*$/u, '')
          if (!beforeDynamic) continue
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