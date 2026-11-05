/**
 * 正文里已登记角色名的**同后缀异姓漂移**（issue #102）。
 *
 * 现象：那本 46 章的悬疑长篇里，**已登记角色「陆敬堂」在第 23 章被改名成「穆敬堂」**——
 * 同一个人、同一个后缀，只差姓一字。全书前 22 章一律作「陆敬堂」（第 4–13 章共 28 次），
 * 第 23 章第一次出现就是「穆敬堂」，而正文里没有任何交代「换了个人」或「改姓」。
 *
 * 为什么这比普通错字严重：错误**已经被事实账本继承**——
 * `chapter_commits.facts_json` 与 `summary_snapshots`（第 23 章）都写进了「穆敬堂」，
 * 于是它会作为「定稿历史 / 全局摘要」喂给第 24 章及以后，后文很可能跟着写「穆敬堂」。
 *
 * 已有的检测器都盖不到它：
 *   - `findNearCastNames`（#58）只读**蓝图描述文字里的引号内**名字，且判据是「编辑距离 ≤1
 *     或同姓」。本条在**正文散句**里、且要「删一个字 + 换一个字」（距离 2），两条都不命中；
 *   - `findUnregisteredBlueprintCast`（#42）只看蓝图 `characters` 数组；
 *   - 审稿侧能报（实测第 23 章有一条 `专名与术语一致性`），但停在 `unresolved`，不阻断定稿。
 *
 * 判据刻意做**结构性 + 最窄**（本仓在 #30/#58/#93/#96/#99 反复吃过词表过拟合的亏）：
 *   取「与某个在册角色名**等长**、且**从第二个字起逐字相同**」的词——
 *   即同一个名/字 + 不同的姓（「穆敬堂」vs「陆敬堂」、「X德昌」vs「邵德昌」）。
 *   这一条不需要任何姓氏词表：**等长 + 后缀完全相同 + 首字不同**本身就是「同一个人在
 *   中间被换了姓」的形状，而正常叙述里不会凭空出现这种词。
 *
 * 三条必要的收窄（都在真实语料上标定过）：
 *   ① 名册名与候选都必须 **≥3 字**——两字名共享一字太常见（「阿茂 / 阿水」），会误报；
 *   ② 候选**不在名册**、且不等于名册里任何名字（已登记的名字不报）；
 *   ③ 该候选所在章**没有把它当新角色建档**（判据只读正文，不知道建卡状态，所以
 *      出路里明确写「要么确认写法、要么去建档」）。
 *
 * 标定（三本书、共 68 章定稿正文）：唯一命中就是 ch23 的「穆敬堂」，
 * sim2（43 章）与 0202 的其余章 **0 假阳性**。
 */

import { FUNCTION_CHARACTERS } from './sentence-length'

export interface CastNameDriftChapter {
  chapterNumber: number
  content: string
}

export interface CastNameDriftHit {
  /** 正文里的漂移写法（如「穆敬堂」）。 */
  variant: string
  /** 名册里的正名（如「陆敬堂」）。 */
  canonical: string
  /** 出现该写法的章号（升序，去重）。 */
  chapters: number[]
  /** 该写法所在的一句，用于证据展示。 */
  excerpt: string
}

/**
 * 名册名与候选都必须 ≥3 字：两字名共享一字太常见（「阿茂」「阿水」同书并存很正常），
 * 收进来会变成噪声源（#30「规则层输出全是假阳性等于零信息」）。
 */
export const CAST_NAME_DRIFT_MIN_CHARS = 3

/**
 * 变体首字**不能是虚词/功能字**——这是本判据最容易翻车的地方。
 *
 * 反例（名册里真有「陶有根」这种名字时就会踩到）：「陶有根」的后缀是「有根」，
 * 而正文里「**没**有根」「**也**有根」「**都**有根」都是正常短语 —— 等长窗口一取
 * 就得到「没有根 / 也有根」这种「同后缀异姓」的假名字（与 #96 的「任九」同一类坑）。
 *
 * 复用 `prose-flavor.ts` 那份**封闭语法类**（已经在 #96 上被真实语料筛过一遍），
 * 不另起一份词表。真实语料标定：加上这一条后 0202/sim2 的假阳性为 0。
 */
export const CAST_NAME_DRIFT_BLOCKED_HEADS: ReadonlySet<string> = FUNCTION_CHARACTERS

const CJK = /[\u3400-\u9fff]/u

/** 剥掉角色名上可能带的说明（与 `castDisplayName` 同口径的轻量版）。 */
function normalizeCastName(name: unknown): string {
  return String(name ?? '').trim()
}

/** 取包含 `at` 的那一句（用于证据）。 */
function sentenceAt(content: string, at: number): string {
  const before = Math.max(content.lastIndexOf('。', at), content.lastIndexOf('\n', at), content.lastIndexOf('！', at), content.lastIndexOf('？', at), content.lastIndexOf('”', at))
  const afterCandidates = ['。', '\n', '！', '？', '“'].map(mark => content.indexOf(mark, at + 1)).filter(index => index >= 0)
  const after = afterCandidates.length ? Math.min(...afterCandidates) + 1 : content.length
  return content.slice(Math.max(0, before + 1), after).trim()
}

/**
 * 找出一章正文里「像是某个在册角色被换了姓、却不在名册」的写法。
 *
 * 判据：候选词与某个在册角色名**等长**、**从第二个字起逐字相同**、首字不同，
 * 且候选不在名册。名字本身是内容（不是词表），所以换一本书照样成立。
 */
export function findCastNameDriftInChapter(
  chapter: CastNameDriftChapter,
  castNames: readonly string[],
): Array<{ variant: string; canonical: string; excerpt: string }> {
  const content = String(chapter.content ?? '')
  if (!content) return []
  const roster = [...new Set(castNames.map(normalizeCastName))]
    .filter(name => name.length >= CAST_NAME_DRIFT_MIN_CHARS)
  if (roster.length === 0) return []
  const exact = new Set(castNames.map(normalizeCastName))
  const found = new Map<string, { variant: string; canonical: string; excerpt: string }>()
  for (const canonical of roster) {
    // 后缀 = 名册名去掉首字（姓）。必须以 **尾部** 定位：这样不会把「敬堂」当成
    // 独立词去扫，而是精确找「某个字 + 敬堂」的等长窗口。
    const tail = canonical.slice(1)
    if (tail.length < 2) continue
    let at = content.indexOf(tail)
    while (at >= 0) {
      const start = at - 1
      if (start >= 0) {
        const variant = content.slice(start, start + canonical.length)
        if (variant.length === canonical.length
          && CJK.test(variant[0]!)
          && !CAST_NAME_DRIFT_BLOCKED_HEADS.has(variant[0]!)
          && variant !== canonical
          && variant.slice(1) === tail
          && !exact.has(variant)
          && !found.has(variant)) {
          found.set(variant, { variant, canonical, excerpt: sentenceAt(content, start) })
        }
      }
      at = content.indexOf(tail, at + 1)
    }
  }
  return [...found.values()]
}

/**
 * 跨章聚合：同一个漂移写法可能出现在多章，聚成一条（与 #73/#75 的「按章号集合归并」同口径）。
 *
 * 只有**至少出现过一次**就报——不需要「高频」才报：一个已登记角色被改名，
 * 出现一次就足以让读者以为换了人（issue 的原话是「比普通错字刺眼得多」）。
 */
export function findCastNameDrift(
  chapters: readonly CastNameDriftChapter[],
  castNames: readonly string[],
): CastNameDriftHit[] {
  const byVariant = new Map<string, CastNameDriftHit>()
  for (const chapter of chapters) {
    if (!Number.isSafeInteger(chapter.chapterNumber)) continue
    for (const hit of findCastNameDriftInChapter(chapter, castNames)) {
      const entry = byVariant.get(hit.variant) ?? {
        variant: hit.variant, canonical: hit.canonical, chapters: [], excerpt: hit.excerpt,
      }
      if (!entry.chapters.includes(chapter.chapterNumber)) entry.chapters.push(chapter.chapterNumber)
      // 保留章节升序里最早那句作证据（作者按它定位）。
      if (chapter.chapterNumber === Math.min(...entry.chapters)) entry.excerpt = hit.excerpt
      byVariant.set(hit.variant, entry)
    }
  }
  return [...byVariant.values()]
    .map(hit => ({ ...hit, chapters: [...hit.chapters].sort((left, right) => left - right) }))
    .sort((left, right) => right.chapters.length - left.chapters.length || left.variant.localeCompare(right.variant))
}

/**
 * 角色名漂移 → 一致性发现（issue #102）。
 *
 * `stableFactKey` 锚在「漂移写法 + 正名」上、**不带章号**（#86/#89/#98 的教训：
 * 带章号的 key 会随章滚动，作者点「我已知」永远关不掉）。
 * 出路给**两条可执行分支**（#86/#69 的教训：出路必须是产品里真的存在的动作）。
 */
export function findCastNameDriftFindings(input: {
  chapters: readonly CastNameDriftChapter[]
  castNames: readonly string[]
}): Array<{
  stableFactKey: string
  severity: 'warning'
  sourceChapter: number
  evidence: string
  issue: { zhCN: string; enUS: string }
  suggestion: { zhCN: string; enUS: string }
}> {
  const hits = findCastNameDrift(input.chapters, input.castNames)
  return hits.map(hit => {
    const chapterList = hit.chapters.join('、')
    return {
      stableFactKey: `cast:name-drift:${hit.canonical}:${hit.variant}`,
      severity: 'warning' as const,
      sourceChapter: hit.chapters[hit.chapters.length - 1]!,
      evidence: `第 ${chapterList} 章的正文里出现「${hit.variant}」，与在册角色「${hit.canonical}」同后缀、仅首字不同：${hit.excerpt}`,
      issue: {
        zhCN: `正文里出现了「${hit.variant}」（第 ${chapterList} 章），它和在册角色「${hit.canonical}」**同名不同姓**——全书其余各章一律作「${hit.canonical}」，名册里也只有「${hit.canonical}」。同一后缀、只换一个姓，读者会先怀疑是自己看错了字，比一般的错字刺眼；更麻烦的是这类名字会**被事实账本继承**（定稿事实 / 全局摘要会带进后面每一章），越往后越难改。`,
        enUS: `The prose names “${hit.variant}” (chapter ${chapterList}), which shares ${hit.canonical}'s given name but swaps the surname — every other chapter uses “${hit.canonical}”, and that is the only form on the roster. Readers will assume they misread it, and what is worse, the fact ledger adopts the wrong form (finalised facts and the global summary feed every later chapter), so it gets harder to fix the further the book goes.`,
      },
      suggestion: {
        zhCN: `二选一：①如果这是**打错字**，把「${hit.variant}」改回「${hit.canonical}」——它是已登记角色，正文与账本都要用名册里的写法；②如果确实换了人（同姓/改姓的新角色），那就在角色名单里为「${hit.variant}」建档，并在本章正文里写出「换了个人」的交代，否则读者只能猜。改完后这一条不会再报。`,
        enUS: `Two options. ① If it is a typo, change “${hit.variant}” back to “${hit.canonical}” — the canonical roster form is what both the prose and the ledger must use. ② If it really is a different person (same given name, different surname), add “${hit.variant}” to the roster and show the swap in the prose, or readers are left guessing. Once fixed, this reminder stops.`,
      },
    }
  })
}
