/**
 * 正文层的跨章重复检测（issue #32 场景装置 / #33 人物反应句式）。
 *
 * 为什么需要它：#14 的代价轮换只管 `costsAndTurns` 字段、#28 只管蓝图里的收束标注、
 * #16 只管标题与整场戏、#20 只管钩子有没有被接——都管不到「散布在正文每个拍点上的
 * 同一套写法」。这类重复只能读正文才发现，而审稿的「跨章重复」维度对它无感
 * （本样本 19 份审稿报告只报出 1 条逐字复写，对同构写法 0 命中）。
 *
 * 判据设计（关键）：**用跨章分布，不用出现次数**。
 * 本样本「没动」在 14 章里出现 9 次、**每章恰好一次**——次数很少，但「每次受挫都来一下」
 * 才是读者感到固定的原因。所以判据是「同一批词覆盖了多少章」。
 *
 * 保守到什么程度：阈值取样本章数的六成，且要求样本 ≥ 8 章；
 * 实测本机 9 章定稿样本（另一本、写法各异）覆盖 2/9，**不触发**——不会给作者刷噪声。
 */
import type { ConsistencyFinding } from './consistency-preflight'

export interface ProseRepetitionChapter {
  chapterNumber: number
  content: string
}

/** 否定式微动作短句：人物受挫/被追问时的固定反应（issue #33，取自其逐章证据）。 */
export const STILLNESS_PHRASES = Object.freeze([
  '没动', '没有动', '一动没动', '没答', '没应', '没说话', '没有开口', '没再开口', '没出声', '没应声', '一言不发',
] as const)

/** 场景装置的起手动作（issue #32，取自其逐章证据）：下舱底 / 拧水隔 / 票根蘸水。 */
export const STAGING_PHRASES = Object.freeze([
  '钻进舱底', '下舱底', '下到舱底', '拧开水隔', '拧水隔', '开水隔',
  '蘸了舷壁', '蘸了舷板', '蘸舷板', '蘸了水', '蘸水',
] as const)

export interface ProseRepetitionHit {
  kind: 'stillness' | 'staging'
  /** 命中该族短语的章号（升序）。 */
  chapters: number[]
  /** 具体命中的短语及各自章数，供作者核对。 */
  phrases: Array<{ phrase: string; chapters: number[] }>
  /**
   * 这条命中是**按全书**算的还是**按某个角色的出场章**算的（issue #49）。
   * 配角出场章少，按全书章数归一永远达不到阈值——那不是「写法不固定」，是分母选错了。
   */
  scope?: { kind: 'book' } | { kind: 'character'; character: string; appearances: number }
}

export interface ProseRepetitionOptions {
  /** 样本章数下限：不足这个数不判（样本太小，比例无意义）。 */
  minChapters?: number
  /** 覆盖率阈值：同一族覆盖的章数占样本比例达到它才算「固定写法」。 */
  coverageRatio?: number
  /**
   * 按角色归一时，单个角色的出场章数下限（issue #49）。
   * 4 章是「有资格谈固定写法」的最低值；低于它的配角样本太少，比例意义不大。
   */
  minCharacterChapters?: number
}

function scanFamily(
  kind: ProseRepetitionHit['kind'],
  phrases: readonly string[],
  chapters: readonly ProseRepetitionChapter[],
  coverageRatio: number,
  scope: ProseRepetitionHit['scope'],
): ProseRepetitionHit | null {
  const covered = new Set<number>()
  const phraseHits: Array<{ phrase: string; chapters: number[] }> = []
  for (const phrase of phrases) {
    const hit = chapters.filter(item => item.content.includes(phrase)).map(item => item.chapterNumber)
    if (hit.length === 0) continue
    hit.forEach(chapter => covered.add(chapter))
    phraseHits.push({ phrase, chapters: hit })
  }
  // 覆盖率用「并集覆盖了多少章」而不是「短语命中多少次」：读者感到固定的是**每章都来一下**。
  // 分母由调用方决定（全书章数 / 该角色的出场章数，issue #49），这里只做比例判断。
  if (covered.size < Math.ceil(chapters.length * coverageRatio)) return null
  return {
    kind,
    chapters: [...covered].sort((left, right) => left - right),
    phrases: phraseHits.sort((left, right) => right.chapters.length - left.chapters.length),
    ...(scope ? { scope } : {}),
  }
}

/**
 * 找出正文层的跨章重复。返回空数组表示「没到固定写法的程度」——这是常态，不是失败。
 */
export function findProseRepetition(
  chapters: readonly ProseRepetitionChapter[],
  options: ProseRepetitionOptions = {},
): ProseRepetitionHit[] {
  const usable = chapters.filter(item => Number.isSafeInteger(item.chapterNumber) && typeof item.content === 'string' && item.content.trim())
  const minChapters = options.minChapters ?? 8
  const coverageRatio = options.coverageRatio ?? 0.6
  if (usable.length < minChapters) return []
  return [
    scanFamily('stillness', STILLNESS_PHRASES, usable, coverageRatio, { kind: 'book' }),
    scanFamily('staging', STAGING_PHRASES, usable, coverageRatio, { kind: 'book' }),
  ].filter((hit): hit is ProseRepetitionHit => hit !== null)
}

/**
 * 配角视角的跨章重复（issue #49）：「全叔 5/6 章都蹲着收绳」「林棠 9/10 章都在柜台」，
 * 按全书章数归一他永远差好几章——配角的固定起手动作在数学上不可能被检出，而这恰恰是
 * 最容易让读者出戏的写法（一个只有 6 场戏的配角，5 场都在干同一件事）。
 *
 * 分母改成**该角色的出场章数**：只拿「提到这个角色」的章当样本，
 * 出场章数 ≥ minCharacterChapters（默认 4）才判，覆盖率同样要过六成。
 * 词族沿用既有两族（stillness / staging）——它们是「动作 + 起手」的原型，
 * 对配角同样成立；不新造开放词表，避免 #20 那类词法假阳性。
 */
export function findCharacterProseRepetition(
  chapters: readonly ProseRepetitionChapter[],
  characterNames: readonly string[],
  options: ProseRepetitionOptions = {},
): ProseRepetitionHit[] {
  const usable = chapters.filter(item => Number.isSafeInteger(item.chapterNumber) && typeof item.content === 'string' && item.content.trim())
  const minCharacterChapters = options.minCharacterChapters ?? 4
  const coverageRatio = options.coverageRatio ?? 0.6
  const hits: ProseRepetitionHit[] = []
  for (const character of [...new Set(characterNames.map(name => name.trim()).filter(Boolean))]) {
    const appeared = usable.filter(item => item.content.includes(character))
    if (appeared.length < minCharacterChapters) continue
    const scope = { kind: 'character' as const, character, appearances: appeared.length }
    for (const hit of [
      scanFamily('stillness', STILLNESS_PHRASES, appeared, coverageRatio, scope),
      scanFamily('staging', STAGING_PHRASES, appeared, coverageRatio, scope),
    ]) if (hit) hits.push(hit)
  }
  return hits
}

/** 命中族 → 可读证据串（供 findings 的 evidence 字段）。 */
export function proseRepetitionEvidence(hit: ProseRepetitionHit): string {
  const top = hit.phrases.slice(0, 4).map(item => `${item.phrase}（${item.chapters.length} 章）`).join('、')
  const scope = hit.scope?.kind === 'character' ? `（${hit.scope.character} 出场 ${hit.scope.appearances} 章）` : ''
  return `第 ${hit.chapters.join('、')} 章共 ${hit.chapters.length} 章命中同一族写法${scope}；高频短语：${top}`
}

/**
 * 正文层重复 → 一致性发现（issue #32 / #33 / #49）。
 *
 * **这是唯一实现**：审稿路径（`electron/services/review-revision-context.ts`）与
 * 写前预检（`src/services/consistency-preflight.ts`）共用它（issue #83）。
 * 原来它只在审稿路径被调用，而实测那本书 23 章没有审稿报告——这批检测因此在
 * 真实使用中一次都没触发过。移到这里是为了让 renderer 侧也能 import。
 *
 * 只在「同一族短语覆盖了六成以上样本章」时才报，且样本 ≥ 8 章；本机 9 章定稿样本
 * （写法各异）覆盖 2/9 不触发——这是刻意的保守阈值，避免给作者刷噪声。
 * stableFactKey 带章号与族名，便于作者在一致性豁免里逐条关掉。
 */
export function proseRepetitionFindings(
  chapters: ReadonlyArray<{ chapterNumber: number; content: string }>,
  currentChapter: number,
  castNames: readonly string[] = [],
): ConsistencyFinding[] {
  // 全书口径（主角式）与按角色口径（配角式）各跑一遍（issue #49）：配角的出场章数远小于全书章数，
  // 按全书归一他永远达不到阈值——那是分母选错了，不是写法不固定。
  const hits = [
    ...findProseRepetition(chapters),
    ...(castNames.length ? findCharacterProseRepetition(chapters, castNames) : []),
  ]
  const seen = new Set<string>()
  return hits.filter(hit => {
    const key = hit.scope?.kind === 'character' ? `${hit.kind}:${hit.scope.character}` : `${hit.kind}:book`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).map(hit => {
    const isStillness = hit.kind === 'stillness'
    // 按角色口径时把角色名写进结论，作者才知道说的是谁。
    const subject = hit.scope?.kind === 'character' ? `「${hit.scope.character}」的` : ''
    const englishSubject = hit.scope?.kind === 'character' ? `${hit.scope.character}'s ` : "The protagonist's "
    return {
      stableFactKey: `prose:${hit.kind}${hit.scope?.kind === 'character' ? `:${hit.scope.character}` : ''}:${currentChapter}`,
      severity: 'warning' as const,
      sourceChapter: currentChapter,
      evidence: proseRepetitionEvidence(hit),
      issue: {
        zhCN: isStillness
          ? `人物反应被写成了固定短句：${subject}${hit.chapters.length} 章都用同一批否定式微动作（没动／没答／没应／没说话）表达受挫或被追问，读者能预判角色的反应。`
          : `核心戏的场景装置被固定复用了：${subject}${hit.chapters.length} 章都用同一套「地点＋起手动作」搭戏（如舱底＋拧水隔＋票根蘸水），读者一看起手就知道接下来会发生什么。`,
        enUS: isStillness
          ? `${englishSubject}reactions have become a fixed formula: ${hit.chapters.length} chapters express setback or being questioned with the same negated micro-phrases, so readers can predict the reaction.`
          : `${englishSubject}core scene's staging repeats: ${hit.chapters.length} chapters set it up with the same place-plus-opening-action, so readers know what follows from the opening beat.`,
      },
      suggestion: {
        zhCN: isStillness
          ? '换一种呈现方式表达沉默与受挫（身体动作、视线、呼吸、手上的活），也不要每章都用「提问→对方不回答」收场。'
          : '换场合与起手动作搭这一场戏；同一套装置不要连着多章用。',
        enUS: isStillness
          ? 'Show silence and setback another way (bodily action, gaze, breathing, the work in their hands), and stop ending every chapter on "asked a question, got no answer".'
          : 'Change the setting and the opening action for this scene; do not reuse the same staging across adjacent chapters.',
      },
    }
  })
}
