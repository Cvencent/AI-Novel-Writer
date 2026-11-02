/**
 * 段落起手（段首主语）的固定化（issue #94）。
 *
 * 现象：那本 42 章的悬疑长篇里，**「每一段由谁起手」被写成了一个固定格式**。
 * 去掉对白段后的 929 个叙述段：以「周叙」开头 **223 段（24.0%）**、以「他」开头
 * **107 段（11.5%）**，合计 35.5% —— 读起来就是「每三段里有一段先报一次主角的名字，
 * 再给动作」。作者自己的原话是「视角像摄像机一样一直钉在主角肩上」。
 *
 * 为什么产品里没有检测看它 —— **这是一层位置轴的空缺，不是一格**：
 *
 *   #71  章首        —— **每章第一句**的第一个小句（时间/地点状语起手）
 *   #81  登场句      —— 角色**首次出现那一段**的穿戴与姿态
 *   #32/#33/#49/#82 正文核心戏 —— 短语层（否定式反应、低身姿态、场景装置）
 *   #28/#65/#66 章末 —— 最后一句/段的落幅与语用
 *
 * 段落层（每一段的第一个词）从来没有进过任何一条检测。#71 的分类恰好放过了它：
 * 「周叙把票根压上舱板」因为主语就是角色而被判成 `character`，从那条判据底下走过去。
 *
 * 判据刻意**不用词表**（本仓反复吃过词表过拟合的亏 #30/#43/#70/#80/#93）：
 *   - 「谁起手」用**名册**判（在册角色名），不枚举「周叙」「温珩」；
 *   - 「代词起手」用**人称代词类**（他/她/它/其/对方…），这是封闭语法类；
 *   - 分母用**非对白段**（对白段本来就以引号开头，算进去会稀释比例）。
 *
 * 两条命中条件（都对应「读者能预判下一段的起手」）：
 *   ① 同一角色的名字起手占比 ≥ 样本的 1/3；
 *   ② 连续 ≥3 段以同一个起手词开头（不管是人名还是代词）。
 */

export interface OpenerParagraph {
  chapterNumber: number
  /** 段在本章里的序号（从 1 起）。 */
  paragraphIndex: number
  text: string
}

export interface ParagraphOpenerSample {
  chapterNumber: number
  content: string
}

/** 段首起手词的类别（封闭语法类 + 名册）。 */
export type OpenerKind = { kind: 'cast'; name: string } | { kind: 'pronoun'; word: string } | { kind: 'other' }

/**
 * 人称代词类（封闭集）。
 *
 * `他/她` 单独成类；`其/对方/自己` 在叙述段首也常作起手。**刻意不收**「这/那/它」——
 * 「这」起手多是指示（「这一幕他记住了」），语义上不是「谁在做」，混进来会让
 * 「代词起手」失真。
 */
export const PRONOUN_OPENERS = Object.freeze(['他们', '她们', '他', '她', '对方', '自己'] as const)

/** 把一章切成**叙述段**（剔除以引号开头的对白段）。 */
export function narrativeParagraphs(chapter: ParagraphOpenerSample): OpenerParagraph[] {
  return String(chapter.content ?? '')
    .split(/\n\s*\n/u)
    // `paragraphIndex` 保留**原文段号**（在过滤之前编号）：作者要按它回到正文里定位，
    // 过滤后重编号会因为剔掉对白段而与原文对不上（第 3 段被报成第 2 段）。
    .map((block, index) => ({ text: block.trim(), paragraphIndex: index + 1 }))
    .filter(entry => entry.text)
    // 对白段：以中文/英文引号开头。它们天然以引号起手，算进分母会稀释比例。
    .filter(entry => !/^[“”"「『']/u.test(entry.text))
    .map(entry => ({ chapterNumber: chapter.chapterNumber, paragraphIndex: entry.paragraphIndex, text: entry.text }))
}

/** 判断一段的起手词属于哪一类（名册优先于代词——「他」不会与角色名冲突，但名册长名要先试）。 */
export function classifyOpener(paragraph: string, castNames: readonly string[]): OpenerKind {
  const text = String(paragraph ?? '').trim()
  if (!text) return { kind: 'other' }
  // 长名优先：「全叔」与「全叔的旧油布围裙」同时存在时，先匹配长的更准。
  const names = [...new Set(castNames.map(name => String(name ?? '').trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length)
  for (const name of names) {
    if (text.startsWith(name)) return { kind: 'cast', name }
  }
  for (const pronoun of PRONOUN_OPENERS) {
    if (text.startsWith(pronoun)) return { kind: 'pronoun', word: pronoun }
  }
  return { kind: 'other' }
}

export interface OpenerConvergence {
  /** 哪一类起手（cast 带角色名，pronoun 带词）——「other」不进结果集，故这里不含它。 */
  opener: Exclude<OpenerKind, { kind: 'other' }>
  /** 这一段样本里该起手出现的叙述段数（分母见 `narrativeTotal`）。 */
  count: number
  /** 样本里的叙述段总数（非对白段）。 */
  narrativeTotal: number
  /** 命中该起手的章号（升序，去重）。 */
  chapters: number[]
  /** 最长连续同起手段（用于证据展示）。 */
  longestRun: Array<{ chapterNumber: number; paragraphIndex: number; text: string }>
}

export interface OpenerConvergenceOptions {
  /** 占比阈值：同一角色名起手占叙述段的多少比例就报。默认 1/3。 */
  shareThreshold?: number
  /** 连续同起手的最短段数。默认 3。 */
  minRun?: number
  /** 样本章数下限：不足不判（与其它分布判据同一口径）。 */
  minChapters?: number
}

/**
 * 找「段落起手被写成固定格式」。
 *
 * 与其它判据的区别是**分母是叙述段**而不是章：读者感到的是「每三段一段先报个名字」，
 * 这是段级节奏，不是章级比例。
 */
export function findParagraphOpenerConvergence(
  chapters: readonly ParagraphOpenerSample[],
  castNames: readonly string[],
  options: OpenerConvergenceOptions = {},
): OpenerConvergence[] {
  const shareThreshold = options.shareThreshold ?? 1 / 3
  const minRun = options.minRun ?? 3
  const minChapters = options.minChapters ?? 6
  const ordered = [...chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
  if (ordered.length < minChapters) return []
  const paragraphs = ordered.flatMap(chapter => narrativeParagraphs(chapter))
  const narrativeTotal = paragraphs.length
  if (narrativeTotal === 0) return []

  const groups = new Map<string, OpenerConvergence>()
  for (const paragraph of paragraphs) {
    const opener = classifyOpener(paragraph.text, castNames)
    if (opener.kind === 'other') continue
    const key = opener.kind === 'cast' ? `cast:${opener.name}` : `pronoun:${opener.word}`
    const entry = groups.get(key) ?? {
      opener, count: 0, narrativeTotal, chapters: [], longestRun: [],
    }
    entry.count += 1
    if (!entry.chapters.includes(paragraph.chapterNumber)) entry.chapters.push(paragraph.chapterNumber)
    groups.set(key, entry)
  }

  // ② 连续同起手：按章、按段序扫，记录最长连续段。
  const runs = new Map<string, OpenerParagraph[]>()
  for (const chapter of ordered) {
    let current: OpenerParagraph[] = []
    let currentKey: string | null = null
    for (const paragraph of narrativeParagraphs(chapter)) {
      const opener = classifyOpener(paragraph.text, castNames)
      const key = opener.kind === 'other' ? null
        : opener.kind === 'cast' ? `cast:${opener.name}` : `pronoun:${opener.word}`
      if (key === null || key !== currentKey) {
        if (currentKey && current.length > (runs.get(currentKey)?.length ?? 0)) runs.set(currentKey, current)
        current = key === null ? [] : [paragraph]
        currentKey = key
        continue
      }
      current.push(paragraph)
    }
    if (currentKey && current.length > (runs.get(currentKey)?.length ?? 0)) runs.set(currentKey, current)
  }

  // 先把每个起手词算成一条候选（是否入库后面统一判）。
  const results: OpenerConvergence[] = []
  for (const [key, entry] of groups) {
    const run = runs.get(key) ?? []
    results.push({
      ...entry,
      chapters: [...entry.chapters].sort((left, right) => left - right),
      longestRun: run.length >= minRun ? run.slice(0, 4) : [],
    })
  }
  // 最高频人名：代词要**与它合计**才判（issue #94 原文的 24.0% + 11.5% = 35.5%）。
  const topCastCount = results
    .filter(item => item.opener.kind === 'cast')
    .reduce((max, item) => Math.max(max, item.count), 0)
  const kept = results.filter(item => {
    const shareHit = item.opener.kind === 'cast' && item.count / narrativeTotal >= shareThreshold
    const runHit = item.longestRun.length >= minRun
    if (item.opener.kind === 'cast') return shareHit || runHit
    // 代词：自己不足以判（「他」起手在正常叙述里本来就常见），
    // 只有与最高频人名**合计**达标时才算「名字+代称」这一种现象。
    return (topCastCount + item.count) / narrativeTotal >= shareThreshold
  })
  // 排序：先说占比最大的（读者最容易预判的那种），再按连续段数。
  return kept.sort((left, right) => right.count - left.count
    || right.longestRun.length - left.longestRun.length
    || (left.opener.kind === 'cast' ? left.opener.name : '').localeCompare(
      right.opener.kind === 'cast' ? right.opener.name : ''))
    .slice(0, 3)
}
