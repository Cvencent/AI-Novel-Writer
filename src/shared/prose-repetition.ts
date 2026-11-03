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
 *
 * 三族词（issue #32 / #33 / #82）：
 *   stillness —— 否定式反应短句（没动／没答）
 *   staging   —— 溯读装置的起手动作（舱底／水隔／蘸水）
 *   posture   —— 低身姿态的进场动作（蹲／俯身／弯腰／屈膝）
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

/** 场景装置的起手动作（issue #32，取其逐章证据）：下舱底 / 拧水隔 / 票根蘸水。 */
export const STAGING_PHRASES = Object.freeze([
  '钻进舱底', '下舱底', '下到舱底', '拧开水隔', '拧水隔', '开水隔',
  '蘸了舷壁', '蘸了舷板', '蘸舷板', '蘸了水', '蘸水',
] as const)

/**
 * 低身姿态的起手动作（issue #82）：下蹲 / 俯身 / 弯腰 / 屈膝。
 *
 * 前两族把**否定式**反应（没动／没答）与**溯读装置**抓得很准，但同一批章节里与之
 * 并排的**肯定式低身起手**一个也没进词表——「他蹲下来把风灯搁在膝盖边」这类句子
 * 在样本里是**进入每一场戏的标准动作**（实测 26 章定稿副本：含「蹲」19 章 = 73%、
 * 全书 40 次；配角全叔出场 11 章有 10 章同段含「蹲」），而两族旧词表对它 0 命中。
 *
 * 只收**明确降低身体重心**的动作（蹲／俯身／弯腰／屈膝），**刻意不收**「站／坐／走／看」
 * 这类通用姿态：实测「站」在样本里覆盖 23/26 = 88%，收进来会让这一族**永远触发**
 * （任何书都有大量「站着」），等于把检测变成噪声源（本仓吃过词表假阳性的亏：
 * #30/#43/#70）。「蹲」用单字作条目：汉字「蹲」在中文里只表下蹲义（蹲守/蹲点同属姿态），
 * 且能自动覆盖 蹲在/蹲到/蹲下/蹲回/蹲着/半蹲 等全部字形。
 */
export const POSTURE_PHRASES = Object.freeze([
  '蹲', '俯身', '弯腰', '弯下腰', '屈膝', '单膝跪',
] as const)

/**
 * 神态／表情的固定写法（issue #117）：被顶回时「笑僵住」的那一族。
 *
 * 前三族收的都是**动作与姿态**（否定式反应 / 溯读装置 / 低身起手），
 * **表情一个都没有**。而被角色顶回、被将一军的时候，那本书用的是同一个 4 字句：
 *
 *   第 27 章「周叙把账本塞回铜墨盒箱，推过船舷。'人是我派的。' **邵广海的笑停在脸上。**」
 *   第 36 章「'柯代表。' **他笑停在脸上**，'看岔了也是有的——'」
 *   第 50 章「'送检。' **笑停在脸上。**」（**单独成段**）
 *   第 52 章「**笑停了一下。**邵广海偏头往巷口看。」
 *
 * 全书 52 章里这一族覆盖 **11 章 20 次**（笑停在脸上 ×7、笑还挂着 ×5、笑没落 ×2、
 * 笑先到 ×2、笑才到 ×1），而邵广海出场 24 章里 **14 章（58%）** 都带这个节拍——
 * 节拍完全一致：**对方一句短话 → 一个 4 字句独立成段 → 接一个手部小动作**。
 *
 * 为什么全链路拦不住：
 *   - 本文件三族词表只收动作/姿态，不含表情；
 *   - 蓝图合同的【人物反应轮换】原文写的是「不得连续多章都用同一批**否定式短句**
 *     （没动／没答／没应／没说话／一言不发）」——口径**本身就限定在否定式**，
 *     肯定式的「笑冻结」从合同层就走不到，模型于是躲开「没动」换上「笑停在脸上」。
 *
 * ⚠️ 词表边界（本仓在 #30/#43/#70/#93/#96/#99 反复吃过词表过拟合的亏）：
 *   - 只收**「笑 + 未完结/定格」这个封闭形态**（笑停在（脸上）／笑还挂着／笑没落／笑先到／笑才到／
 *     笑意没（有）到／笑僵住／笑纹没动），**不收裸「笑」**——裸「笑」在任何书里都高频，
 *     收进来这一族会永远触发（同 #82 不收「站」的理由）；
 *   - 不收「笑容」「笑了笑」这类中性写法（那是正常叙述，不是「定格」这个节拍）；
 *   - 每条都带「笑」字前缀，所以不会撞到「停了一下」这类通用动词短句。
 */
export const EXPRESSION_PHRASES = Object.freeze([
  '笑停在脸上', '笑停在', '笑还挂在脸上', '笑还挂着', '笑没落', '笑先到', '笑才到',
  '笑意没到', '笑意还没到', '笑僵住', '笑纹没动',
] as const)

/**
 * 同一条神态短语允许覆盖的**章数上限**（issue #117 的原话：「不得让同一神态短句出现在超过
 * 2–3 章」）。取 3：实测那本书「笑停在脸上」覆盖 7 章、「笑还挂着」5 章——都在这个线上；
 * 而**单次**出现的写法（「笑才到」1 章、「笑没落」1 章）不报，避免把正常的偶发写法当噪声。
 */
export const EXPRESSION_PHRASE_MAX_CHAPTERS = 3

export interface ProseRepetitionHit {
  kind: 'stillness' | 'staging' | 'posture' | 'expression'
  /** 命中该族短语的章号（升序）。 */
  chapters: number[]
  /** 具体命中的短语及各自章数，供作者核对。 */
  phrases: Array<{ phrase: string; chapters: number[] }>
  /**
   * 这条命中是**按全书**算的还是**按某个角色的出场章**算的（issue #49）。
   * 配角出场章少，按全书章数归一永远达不到阈值——那不是「写法不固定」，是分母选错了。
   */
  scope?: { kind: 'book' } | { kind: 'character'; character: string; appearances: number }
  /**
   * 同一族内是否有**互斥变体**（issue #117）：神态族这一条几乎必然为 true。
   *
   * 这一族的一现象有多套措辞（「笑停在脸上」/「笑还挂在脸上」/「笑没落」），
   * 它们说的**是同一件事**（笑定格）。`phrases` 把它们并列列出会让作者以为
   * 「他换过措辞，不算重复」——其实换措辞正是这个现象的症状。
   */
  variantMerge?: boolean
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
  /**
   * 可选的**按短语**判据（issue #117）：某一（去重后的）短语自身覆盖 ≥ 这么多章就报。
   *
   * 为什么神态族需要它而不是覆盖率：这个节拍**天然稀疏**——只在「被顶回」时出现，
   * 实测那本书全族只覆盖 10/51 章（20%）、按角色最高 8/23（35%），
   * 永远够不到 60% 的覆盖门槛，于是**恒不触发**（本仓设计规则⑪的形态）。
   * 而 issue 点名的现象是「**同一个 4 字句**被反复用」（笑停在脸上 7 章、笑还挂着 5 章），
   * 所以判据该按**单条短语的覆盖章数**，而不是整族占全书的比例。
   */
  minPhraseChapters?: number,
): ProseRepetitionHit | null {
  const covered = new Set<number>()
  const phraseHits: Array<{ phrase: string; chapters: number[] }> = []
  for (const phrase of phrases) {
    const hit = chapters.filter(item => item.content.includes(phrase)).map(item => item.chapterNumber)
    if (hit.length === 0) continue
    hit.forEach(chapter => covered.add(chapter))
    phraseHits.push({ phrase, chapters: hit })
  }
  // 归并**互为子串**的变体（本仓 #82 的教训：不归并会把一个现象报成一族 N 条）。
  // 「笑停在脸上」与「笑停在」命中同一批章——它们是同一个观察，只保留更具体的那个；
  // 章号集合相同才算同一观察（不同则说明确实有两种写法，都留）。
  const deduped = phraseHits
    .slice()
    .sort((left, right) => right.phrase.length - left.phrase.length)
    .filter((entry, _index, all) => !all.some(other =>
      other !== entry && other.phrase.length > entry.phrase.length
      && other.chapters.length === entry.chapters.length
      && other.chapters.every((chapter, position) => chapter === entry.chapters[position])))
  // 覆盖率用「并集覆盖了多少章」而不是「短语命中多少次」：读者感到固定的是**每章都来一下**。
  // 分母由调用方决定（全书章数 / 该角色的出场章数，issue #49），这里只做比例判断。
  // 给了 `minPhraseChapters` 时改判**单条短语的覆盖章数**（见该参数的说明）——两条路
  // 任一成立即命中（神态族靠后者，前两族靠前者）。
  const coverageMet = covered.size >= Math.ceil(chapters.length * coverageRatio)
  const phraseMet = minPhraseChapters !== undefined
    && deduped.some(entry => entry.chapters.length >= minPhraseChapters)
  if (!coverageMet && !phraseMet) return null
  return {
    kind,
    chapters: [...covered].sort((left, right) => left - right),
    phrases: deduped.sort((left, right) => right.chapters.length - left.chapters.length),
    ...(scope ? { scope } : {}),
    // 神态族（issue #117）：留下 ≥2 个同章集合的变体，说明作者是在**换措辞说同一个节拍**，
    // 这一项要显式告诉文案层，别让作者以为「换过词就不算重复」。
    ...(deduped.length >= 2 ? { variantMerge: true } : {}),
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
    scanFamily('posture', POSTURE_PHRASES, usable, coverageRatio, { kind: 'book' }),
    // 神态族（issue #117）：被顶回时「笑定格」的那一族。前三族都是动作/姿态，
    // 表情一个都没有——而它出现在**每一场交锋**里，比章末收敛更伤。
    // ⚠️ 用**按短语的覆盖章数**判（不是全族覆盖率）：这个节拍天然稀疏（全族仅覆盖 10/51 章），
    // 覆盖率门槛永远够不到，用它会恒不触发（设计规则⑪）。
    scanFamily('expression', EXPRESSION_PHRASES, usable, coverageRatio, { kind: 'book' }, EXPRESSION_PHRASE_MAX_CHAPTERS),
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
      scanFamily('posture', POSTURE_PHRASES, appeared, coverageRatio, scope),
      // 神态族（issue #117）在**按角色**这一侧也走同一判据：实测邵广海出场 23 章里 8 章带
      // 「笑定格」（35%，够不到 60% 的覆盖率），但**单条短语**「笑停在脸上」在全书覆盖 7 章、
      // 「笑还挂着」5 章——按短语判就能报出来，而按覆盖率永远不触发。
      scanFamily('expression', EXPRESSION_PHRASES, appeared, coverageRatio, scope, EXPRESSION_PHRASE_MAX_CHAPTERS),
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
 * 正文层重复 → 一致性发现（issue #32 / #33 / #49 / #82）。
 *
 * **这是唯一实现**：审稿路径（`electron/services/review-revision-context.ts`）与
 * 写前预检（`src/services/consistency-preflight.ts`）共用它（issue #83）。
 * 原来它只在审稿路径被调用，而实测那本书 23 章没有审稿报告——这批检测因此在
 * 真实使用中一次都没触发过。移到这里是为了让 renderer 侧也能 import。
 *
 * 只在「同一族短语覆盖了六成以上样本章」时才报，且样本 ≥ 8 章；本机 9 章定稿样本
 * （写法各异）覆盖 2/9 不触发——这是刻意的保守阈值，避免给作者刷噪声。
 * stableFactKey 带**族名与最早命中章**（`currentChapter` 只用作「无命中章」时的兜底）：
 * 命中集合稳定时 key 稳定，作者点一次「我已知」即可永久静音（issue #108）。
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
  // 先把同族里**被更大（或相等）集合包含**的命中丢掉，再按族名去重。
  //
  // 为什么：某角色的命中章集合若是另一条同族命中的子集，它就是同一种写法的局部切片，
  // 再报一遍只是换个主语。实测那本书：「蹲」覆盖全书 19/26 章，7 个角色的命中章集
  // 各自都是它的子集（其中主角的集合与全书**完全相同**）——不去重的话同一件事会产出
  // **8 条**几乎一样的提示（book + 每个角色一条），而「规则层输出全是重复项」正是作者
  // 学会无视整个预检的起点（#30 的教训）。判据用**章号集合的包含关系**而非子串（同 #75）。
  //
  // 相等时保留**全书口径**（book）：两者说的是同一批章，book 那条不预设是谁的问题。
  // 注意这不影响 #49 的原意——那条要救的是「配角的出场章比例达标、但全书比例不达标」
  // 的情形，此时 book 口径**根本不会产出**命中，没有东西能包含它，角色那条自然保留。
  const maximal = hits.filter(hit => !hits.some(other => {
    if (other === hit || other.kind !== hit.kind) return false
    if (other.chapters.length < hit.chapters.length) return false
    if (!hit.chapters.every(chapter => other.chapters.includes(chapter))) return false
    // 章集相等时只让「全书口径」胜出，避免两条同样内容只换主语的提示并排出现。
    if (other.chapters.length === hit.chapters.length) {
      return hit.scope?.kind === 'character' && other.scope?.kind !== 'character'
    }
    return true
  }))
  const seen = new Set<string>()
  return maximal.filter(hit => {
    const key = hit.scope?.kind === 'character' ? `${hit.kind}:${hit.scope.character}` : `${hit.kind}:book`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).map(hit => {
    // 三族的措辞各不相同（issue #82 新增 posture）：这是作者唯一会读到的解释，
    // 用一句泛化文案糊过去等于没告诉他「到底哪一类写法被固定了」。
    const subject = hit.scope?.kind === 'character' ? `「${hit.scope.character}」的` : ''
    const englishSubject = hit.scope?.kind === 'character' ? `${hit.scope.character}'s ` : "The protagonist's "
    const zhCNIssue = hit.kind === 'stillness'
      ? `人物反应被写成了固定短句：${subject}${hit.chapters.length} 章都用同一批否定式微动作（没动／没答／没应／没说话）表达受挫或被追问，读者能预判角色的反应。`
      : hit.kind === 'posture'
        ? `人物进场被写成了同一个动作：${subject}${hit.chapters.length} 章都先用同一个低身姿态（蹲／俯身／弯腰）进入场景，动作本身不再传递信息，角色之间的区分度也被抹掉。`
        : hit.kind === 'expression'
          ? `神态被写成了固定节拍：${subject}${hit.chapters.length} 章在被顶回、被将一军的时候都用**同一个「笑定格」短句**（笑停在脸上／笑还挂着／笑没落${hit.variantMerge ? '——这几个变体说的是同一件事，换措辞不等于换了写法' : ''}），通常还接一个手部小动作。读者的感受是「这套反应我见过」：表情本来是压迫感的来源，固定成一个短语之后，每一场交锋都变成同一个套路。`
          : `核心戏的场景装置被固定复用了：${subject}${hit.chapters.length} 章都用同一套「地点＋起手动作」搭戏（如舱底＋拧水隔＋票根蘸水），读者一看起手就知道接下来会发生什么。`
    const enUSIssue = hit.kind === 'stillness'
      ? `${englishSubject}reactions have become a fixed formula: ${hit.chapters.length} chapters express setback or being questioned with the same negated micro-phrases, so readers can predict the reaction.`
      : hit.kind === 'posture'
        ? `${englishSubject}entrances all use the same low posture: ${hit.chapters.length} chapters start the scene by crouching, stooping or bending, so the action itself carries no information and the characters stop being distinguishable by what they do.`
        : hit.kind === 'expression'
          ? `${englishSubject}facial reactions have become a fixed beat: ${hit.chapters.length} chapters mark being countered or one-upped with the **same “smile frozen” phrase**${hit.variantMerge ? ' (its several variants say the same thing — rewording is not variation)' : ''}, usually followed by a small hand movement. Readers feel they have seen this beat before: an expression is where menace lives, and pinning it to one phrase turns every confrontation into the same routine.`
          : `${englishSubject}core scene's staging repeats: ${hit.chapters.length} chapters set it up with the same place-plus-opening-action, so readers know what follows from the opening beat.`
    const zhCNSuggestion = hit.kind === 'stillness'
      ? '换一种呈现方式表达沉默与受挫（身体动作、视线、呼吸、手上的活），也不要每章都用「提问→对方不回答」收场。'
      : hit.kind === 'posture'
        ? '换一种进场方式：有的章让角色站着／走着／先出声／手里正忙着别的事进场，把「他怎么做这件事」写成区分角色的信息，别让每场戏都从蹲下开始。'
        : hit.kind === 'expression'
          ? `换几处落点，别让同一个神态短句出现在超过 2–3 章：①把表情换成**具体动作**（手指在袖口里碾了一下、把单子捏皱了）；②换**视线或呼吸**（他看向巷口、呼出一口气）；③把这一拍**挪到对方身上**（对方的反应/旁人的反应）；④干脆**切走**——不写他的脸，直接跳到他做的那件事。同一个角色的表情库要能被场景检验，不能只有一个「笑定格」。`
          : '换场合与起手动作搭这一场戏；同一套装置不要连着多章用。'
    const enUSSuggestion = hit.kind === 'stillness'
      ? 'Show silence and setback another way (bodily action, gaze, breathing, the work in their hands), and stop ending every chapter on "asked a question, got no answer".'
      : hit.kind === 'posture'
        ? 'Vary the entrance: let some chapters start with the character standing, walking, speaking first, or busy with something else, so how they do it distinguishes them. Do not open every scene with a crouch.'
        : hit.kind === 'expression'
          ? 'Change where the beat lands, and keep any one expression phrase to two or three chapters at most: (1) turn the expression into a concrete action (a thumb rubbed the cuff, the slip crumpled); (2) move to gaze or breath (he looked toward the alley, let out a breath); (3) hand the beat to the other person; (4) cut away — skip his face and jump to what he does. A character\u2019s expression range must be testable by the scene, not just one frozen smile.'
          : 'Change the setting and the opening action for this scene; do not reuse the same staging across adjacent chapters.'
    return {
      // key **不能带当前章号**（issue #108，同 #86/#89/#98 的第 4 例）：原来拼的是
      // `:${currentChapter}`，于是同一族写法每写一章就换一个 key，作者点「我已知，
      // 稍后处理」（#79 的 ack，精确匹配）永远只静音当章。改用**命中章集合的稳定锚**
      // （最早命中章）：命中集合不变 → key 不变（一次 ack 永久静音）；集合变了说明
      // 「这件事本身变了」→ 换 key 值得再报一次。
      stableFactKey: `prose:${hit.kind}${hit.scope?.kind === 'character' ? `:${hit.scope.character}` : ''}:${hit.chapters[0]}`,
      severity: 'warning' as const,
      // sourceChapter 也不能填 currentChapter（issue #108 的第二处，与 #79 同类）：
      // 证据里写的是历史命中章（「第 13、14、17、18、23 章…」），填当前章会让界面把
      // 这条**旧账**标成「正在写的这一章的问题」。指向**最早命中章**。
      sourceChapter: hit.chapters[0] ?? currentChapter,
      evidence: proseRepetitionEvidence(hit),
      issue: { zhCN: zhCNIssue, enUS: enUSIssue },
      suggestion: { zhCN: zhCNSuggestion, enUS: enUSSuggestion },
    }
  })
}
