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