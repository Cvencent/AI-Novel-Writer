import { splitProseSentences } from './finalized-continuity-facts'

/**
 * 章末收束的体检（issue #65 / #66）。
 *
 * 两条 issue 指向同一个盲区：全书**怎么收尾**从来没有被机器看过一眼。
 *
 * - #28 只管蓝图里那个「【收束：类型】」标签**彼此**是否重复（画面同构），
 *   却没有人核对标签与正文最后一幕是否一致——实测 10 章有 7 章不符，
 *   于是「不得重复上一章落幅」这条约束建立在假信息上。
 * - 蓝图给「对话收束」开了合法的口子，但没有管**对白在做什么**：25 章里
 *   末段含对白的 7 章，有 6 章末句是「二选一/警告/条件通牒」，且全落在第 15
 *   章之后。画面换了、人物换了、钩子文本也不重复，读者听到的还是同一个声音。
 *
 * 判据只取**能可靠算出来的那一维**：本章是不是**收在台词里**。
 * 「物件落幅 vs 人物动作收束」这类细分需要语义理解，粗分类必然出错——
 * 本仓已经吃过词表假阳性的亏（#30 / #43），宁可少判一维也不给作者刷噪声。
 */

/** 正文最后一段（按空行切，取最后一个有内容的块）。 */
export function closingParagraph(content: string): string {
  const blocks = String(content ?? '')
    .split(/\n\s*\n/u)
    .map(block => block.trim())
    .filter(Boolean)
  return blocks.at(-1) ?? ''
}

const OPEN_QUOTES = '“「『"'
const CLOSE_QUOTES = '”」』"'

/** 一段文字里有没有闭合的台词。 */
export function hasDialogue(text: string): boolean {
  return /[“「『"][^”」』"]{1,400}[”」』"]/u.test(String(text ?? ''))
}

/**
 * 末句是否**收在台词里**（最后一个内容字符是收引号，或扫描结束时仍在引号内）。
 *
 * 只问「落在哪」而不问「段里有没有对白」：本样本第 20 章的对白在倒数第二句、
 * 最后收在动作上——按「段内有对白」判会误判成对话收束，正是 #65 要修的那类错误。
 */
export function closesInsideDialogue(sentence: string): boolean {
  const trimmed = String(sentence ?? '').trim()
  if (!trimmed) return false
  if (/[”」』"]$/u.test(trimmed)) return true
  let depth = 0
  for (const character of trimmed) {
    if (OPEN_QUOTES.includes(character)) depth += 1
    else if (CLOSE_QUOTES.includes(character)) depth = Math.max(0, depth - 1)
  }
  return depth > 0
}

export interface ChapterEndingProfile {
  chapterNumber: number
  /** 本章是否收在台词里。这是本模块唯一断言的事实。 */
  closesOnDialogue: boolean
  /** 末句原文（供证据展示，调用方负责截断）。 */
  lastSentence: string
  /** 末句是台词，且是「二选一/警告/条件」体（issue #66）。 */
  ultimatum: boolean
}

/**
 * 通牒式台词的判据（issue #66）。
 *
 * 只认「末句本身是台词，且台词把决定/后果压给对方」这一种形态。
 * 用**句式**而不是关键词堆叠：「不…就…」「要么…要么…」「你替我…」这些结构
 * 与具体用词无关，换一本书、换一批人物仍然成立；纯关键词表（如「就化了」）
 * 只能命中这一本样本，是本仓反复避免过拟合的反面。
 *
 * 每条都带负向前瞻，别把「别人」「特别」「替我高兴」这类日常词判成威胁：
 * 本仓在 #30/#43 已经吃过纯词表假阳性的亏。
 */
const ULTIMATUM_PATTERNS: readonly RegExp[] = [
  // 别 + 动作（别想/别下/别再/别看…），但排除「别人/别的/别处/别样/别家」。
  /(?<![特区告送分类性级识辨差个离惜阔])别(?!人|的|处|样|家)[^。！？!?，]{0,6}(?:[。！？!?]|$)/u,
  // 明写的禁止。
  /(?:不许|不准|不能|不要|休想|不用想)/u,
  // 二选一。
  /(?:不然|否则|要么|要不)/u,
  // 把选择权压回去。
  /(?:你|他|她)自己(?:选|挑|看着办)/u,
  // 命令对方承担（你替我上 / 给我记着）。要跟具体动作，避免「替我高兴」这类客套。
  /(?:给我|替你|替我)(?:上|去|来|看|记|办|签|走|说|交|还)/u,
  // 记恨式警告。
  /(?:记住|记着|走着瞧|试试看|等着瞧)/u,
  // 「但…就…」条件式。
  /但[^。！？!?]{0,20}就[^。！？!?]{0,8}[。！？!?]?$/u,
  // 「不 X，…」的条件句（不签，箱子当场扣下）。限定在一小撮动词上，
  // 否则「不同的地方，他…」这类日常句子会被误判。
  /(?:^|[；;，,。！？])不(?:签|交|给|放|走|去|说|答|认|干|做|借|还|动|来|上|下)[^，,。！？]{0,4}[，,]/u,
]

export function isUltimatumLine(sentence: string): boolean {
  const trimmed = String(sentence ?? '').trim()
  if (!trimmed || !closesInsideDialogue(trimmed)) return false
  // 只拿台词内容判，不含旁白引语（「柯明远把笔收回去」）。
  const spoken = [...trimmed.matchAll(/[“「『]([^”」』]*)[”」』]/gu)].map(match => match[1]).join('')
  const target = spoken || trimmed.replace(/[“”「」『』"]/gu, '')
  return ULTIMATUM_PATTERNS.some(pattern => pattern.test(target))
}

/**
 * 末句的**落点形态**（issue #111）。
 *
 * 前几轮把章末能机器判的那几维都补了：收在不在台词里（#65 标注比对）、
 * 台词是不是通牒（#66 语用）、连续几章同一种收法（#66 连胜）。但**末句本身长什么样**
 * 一直没人看——`lastSentence` 字段在调用方只被用来截断展示，从不参与结构判断。
 *
 * 实测那本悬疑长篇 49 章定稿：第 36 章之后 6/13 章（46%）的末句收敛成同一个骨架——
 * **一件物 + 「还／仍／只剩／偏着／贴着」这类未完结标记，句首不出现任何施动者**；
 * 前 35 章只有 2 章（6%）。六章逐字原文：
 *
 *   桌面上只剩一摊黑墨，和那只倒扣的铜墨盒。
 *   舵轮偏着半圈，没人扶正。
 *   矮桌上的茶碗盖还在那儿打转。
 *   蹭不掉。
 *   底下经手人那一栏，还锁在别人包里。
 *   灯壳里那一卷贴着掌心，还带着一线潮的凉。
 *
 * 物每次都换（墨盒／舵轮／茶碗盖／名单／灯壳里的一卷），**句式一次没换**。
 * 读者合上每一章时听到的节拍是同一个。
 *
 * 判据（结构性、可复算，issue 给的三条）：
 *   ① 不是台词（不以开引号起头、不以收引号收尾）；
 *   ② 句首不出现名册角色名、也不以人称代词/不定代词起头（`leadsWithPerson`）；
 *   ③ 句内含**未完结标记**（`continuesPastSentence`）。
 *
 * 分类只用**封闭的功能类**（体标记／持续态／否定补语），不枚举题材词——
 * 本仓在 #30/#43/#70/#93/#96/#99 反复吃过词表过拟合的亏。
 * `落在物上 / 落在环境上` 这类细分需要语义理解，粗分类必然出错，故**不细判**。
 */
export type EndingLanding = 'subject' | 'subjectless-pending' | 'other'

export interface EndingLandingInput {
  chapterNumber: number
  content: string
  castNames?: readonly string[]
}

/** 句首施动者：名册角色名，或人称/不定人称代词。 */
const LEADING_PERSON = /^(?:他|她|我|他们|她们|我们|咱们|两人|两名|众人|自己|有人|没人|彼此|大家|谁)/u

/**
 * 末句**句首**是不是「人」（issue #111 判据 ②）。
 *
 * 只判**句首**，不判「句中是否出现角色名」——后者会把
 * 「顶缺的伙计睡在温珩隔壁铺」这类**句中只是提到某人**的句子也算成人物落点。
 * 名的匹配要求**句首逐字相接**（`startsWith`），不做「包含」。
 *
 * 于是「温珩刚才站过的地方，木头还是湿的」算**句首有人**（本书第 6 章，判据 ② 不成立、
 * 于是不进命中集）——与 issue 给的逐章结果一致。句首是名字就不管它在句中作主语还是作定语，
 * 这一维只回答「读者看到的第一个词是不是一个人」。
 */
/**
 * 末句里**句首之外**是否有在册角色在做事（issue #197）。
 *
 * 现场：第 80 章末句「袖里的绳圈折着，帆布边被风掀起一角，**全叔把针拔出来**，线拖得老长。」
 * 句首是物件（「袖里的绳圈」），前半句定格画面，最后落在全叔的动作上——这正是中文叙事
 * 里最常见的「背景前置 + 人落点」写法，也正是 `suggestion` 里要作者去做的事。
 * 而旧判据只比**句首**（`leadsWithPerson`），于是把它算成「没有人」；而这一章恰好是
 * 10 章窗里第 4 个命中 —— **一条误判撑起整条 40% 收敛提醒**（删掉它 3/10 < 阈值 4，整条不报）。
 *
 * 判据只做**位置**判断，不理解语义：
 * - 只看**最后一个分句**（最后一个逗号/顿号之后）——「先景物、后人」的落点在那儿；
 * - 判据是「该分句以角色名或人称代词**起手**」，与句首用的是同一套封闭形式类
 *   （`LEADING_PERSON` + 名册逐字相接），不引入任何题材词；
 * - ⚠️ **不做「句中包含名字」**：那会把「顶缺的伙计睡在温珩隔壁铺」这种**只是提到某人**
 *   的句子算成人物落点（issue #111 明确指出过，`leadsWithPerson` 的注释里也写着）。
 *
 * 「袖里的绳圈折着，帆布边被风掀起一角，全叔把针拔出来，线拖得老长」→ 最后一个分句
 * 「线拖得老长」起手不是人 → 仍不算。所以这里不是「整句找名字」，而是找**收束的那一拍**。
 */
export function endsOnPerson(sentence: string, castNames: readonly string[]): boolean {
  const core = String(sentence ?? '').trim()
  if (!core) return false
  // 分句切分只用逗号/顿号（封闭标点，不是题材词）；引号内的逗号先剔除，避免把台词切开。
  const withoutQuotes = core.replace(/[“「『][^”」』]*[”」』]/gu, '')
  const clauses = withoutQuotes.split(/[，,、；;]/u).map(clause => clause.trim()).filter(Boolean)
  /**
   * 只看**收束的那两拍**：末分句，以及它的前一个分句。
   *
   * 取两拍是因为中文的落点常写成「人做动作 + 一句余韵」（「全叔把针拔出来，线拖得老长」）；
   * 只取末分句会把这类句子继续判成「没有人」，而那正是 issue #197 的那一句。
   * 再往前取就会把「只是提到某人」的句子算进来——那正是 #111 明确排除的。
   */
  return clauses.slice(-2).some(clause => {
    // 「没人／无人扶正」是「没有人在做」的**明白写法**：它出现在末句里恰恰是无人称标志。
    // 第 39 章「舵轮偏着半圈，没人扶正。」必须仍是命中，不能被「句中有人称」这条改掉。
    if (/^(?:没|无)(?:有)?人/u.test(clause)) return false
    return leadsWithPerson(clause, castNames)
  })
}

export function leadsWithPerson(sentence: string, castNames: readonly string[]): boolean {
  const core = String(sentence ?? '').trim().replace(/^[“「『"]+/u, '')
  if (!core) return true
  if (LEADING_PERSON.test(core)) return true
  return (castNames ?? []).map(name => String(name ?? '').trim()).filter(Boolean)
    .some(name => core.startsWith(name))
}

/**
 * 未完结标记（issue #111 判据 ③）。
 *
 * 四个子类，都是**封闭的功能类**（体标记／持续态／剩余／否定补语），不枚举题材词——
 * 本仓在 #30/#43/#70/#93/#96/#99 反复吃过词表过拟合的亏。
 *
 *   - 持续体：`仍/仍旧/仍然/依旧/依然`，以及**裸「还」**（还没／还在／还是／还剩／还锁在…）；
 *   - 附着态：`X着`（贴着／锁着／倒扣着／硌着…），但**排除介词性**的「着」——
 *     就着／借着／趁着／跟着／沿／冲／对／随／靠／依／任／绕（实测 0202 第 15 章
 *     「就着晨光，他把那道印子看了很久」正是在这里误命中）；
 *   - 剩余：`只剩／还剩／仅剩／余下`；
 *   - 否定补语：`不掉／不住／不清…` 与 `想不起／说不上／记不清`。
 *
 * 裸「还」**排除比较框架**（同句含「比」）：本书第 3 章「换锁的人来得比他回船**还**快」
 * 是「比…还…」的比较，不是未完结状态——否则这一条会把比较句整片捞进来。
 *
 * 刻意**不收**单字「没」「不」：它们撞普通叙事语域（本书前 35 章大量「没有动／没答」
 * 「周叙蹲着，没有动」），收了会把整本书判成收敛。
 */
const PENDING_CONTINUED = /仍|仍旧|仍然|依旧|依然/u
const PENDING_BARE_STILL = /还/u
const PENDING_DURATIVE = /(?<![就借趁跟沿冲对着随靠依任绕])着(?![的地得])/u
const PENDING_REMAINDER = /(?:只|还|仅|就)?剩|余下/u
const PENDING_NEGATIVE = /不[掉住起了清动成来去]|想不起|说不上|记不清/u

export function continuesPastSentence(sentence: string): boolean {
  const text = String(sentence ?? '')
  return PENDING_CONTINUED.test(text)
    // 裸「还」在「比…还…」里是比较级，不是「仍旧」。
    || (PENDING_BARE_STILL.test(text) && !/比/u.test(text))
    || PENDING_DURATIVE.test(text) || PENDING_REMAINDER.test(text) || PENDING_NEGATIVE.test(text)
}

/** 末句落点分类（issue #111）。 */
export function endingLandingOf(input: EndingLandingInput): EndingLanding {
  const sentences = splitProseSentences(closingParagraph(input.content))
  const lastSentence = (sentences.at(-1) ?? '').trim()
  if (!lastSentence) return 'other'
  if (closesInsideDialogue(lastSentence)) return 'other'
  // 句首有人在 → 人落点（issue #111 判据 ②）。
  if (leadsWithPerson(lastSentence, input.castNames ?? [])) return 'subject'
  /**
   * 句首是物、**句中有人接手**也是人落点（issue #197）。
   *
   * 现场：第 80 章末句「袖里的绳圈折着，帆布边被风掀起一角，全叔把针拔出来，线拖得老长。」
   * 旧判据只看句首 → 算成「没有人」；而这一章恰好是 10 章窗里第 4 个命中，
   * **一条误判撑起整条 40% 收敛提醒**（去掉它 3/10 < 阈值 4，整条不报）。
   * 而 `suggestion` 恰恰是让作者「让视角人物在末句做一个动作」——这一句已经做到了。
   */
  if (endsOnPerson(lastSentence, input.castNames ?? [])) return 'subject'
  return continuesPastSentence(lastSentence) ? 'subjectless-pending' : 'other'
}

/** 提取一章的收束画像。 */
export function chapterEndingProfile(chapterNumber: number, content: string): ChapterEndingProfile {
  const sentences = splitProseSentences(closingParagraph(content))
  const lastSentence = (sentences.at(-1) ?? '').trim()
  return {
    chapterNumber,
    closesOnDialogue: closesInsideDialogue(lastSentence),
    lastSentence,
    ultimatum: isUltimatumLine(lastSentence),
  }
}

/**
 * 蓝图自报的收束类型 → 可断言的事实。
 *
 * 返回 `'dialogue'` 表示「标签声称收在对白里」、`'prose'` 表示「标签声称收在叙述里」、
 * `null` 表示这条标签**本模块无法核对**（悬念直陈/内心独白/时空切换都不承诺
 * 收在白话还是在台词里，硬比会产生假阳性）。
 */
export function blueprintClosingClaim(label: string): 'dialogue' | 'prose' | null {
  switch (String(label ?? '').trim()) {
    case '对话收束': return 'dialogue'
    case '人物动作收束': return 'prose'
    case '物件落幅': return 'prose'
    default: return null
  }
}

/** 标签与正文是否冲突（issue #65）。无法核对的标签一律返回 false。 */
export function closingLabelConflicts(label: string, profile: ChapterEndingProfile): boolean {
  const claim = blueprintClosingClaim(label)
  if (!claim) return false
  return claim === 'dialogue' ? !profile.closesOnDialogue : profile.closesOnDialogue
}

/**
 * 连续几章都收在通牒式台词里 → 收尾收敛了（issue #66）。
 *
 * 要求**末尾连续**而非「最近 N 章出现过 N 次」：读者感到的是「这一章又是这么收的」，
 * 中间夹一章别的写法就能打断预期。章号断号（中间有没导入的章）也视为断开。
 */
export const ULTIMATUM_STREAK_MIN = 3

export function ultimatumStreak(
  profiles: readonly ChapterEndingProfile[],
  minStreak = ULTIMATUM_STREAK_MIN,
): ChapterEndingProfile[] {
  const ordered = [...profiles].sort((left, right) => left.chapterNumber - right.chapterNumber)
  let streak: ChapterEndingProfile[] = []
  for (const profile of ordered) {
    if (!profile.ultimatum) { streak = []; continue }
    const previous = streak.at(-1)
    if (previous && profile.chapterNumber !== previous.chapterNumber + 1) streak = []
    streak.push(profile)
  }
  return streak.length >= minStreak ? streak : []
}

/**
 * 末句落点收敛（issue #111）。
 *
 * 与 #66 是两条不同的轴：#66 管**末句的语用**（是不是通牒式台词），本条管**末句的形态**
 * ——一条「一件物 + 未完结标记 + 没有人」的叙述句。#66 命中时末句必是台词，
 * 本条命中时末句必不是台词，两条样本不重叠（本书 #66 集中在 ch15–27、本条集中在 ch36–47）。
 *
 * 判据取**滑动窗口**而不是**末尾连胜**：实测收敛不是一条不间断的链，而是
 * 「最近 10 章里有 4 章」这种**密度**（ch44/47 命中、中间夹着别的写法）。
 * 用连胜会漏掉真实形态——#66 用连胜是因为「每章都有人撂狠话」本身是连续的，
 * 而「每章都落在一件没做完的东西上」是稀疏的。
 *
 * 阈值 W=10 / K=4 由真实语料标定：本书后段 10 章 4–6 章命中，前段 35 章只有 2 章，
 * 前段不响、后段稳定报出。窗口内**章号必须连续**（同 #66/#71，中间夹没导入的章不算一条链）。
 */
export const LANDING_WINDOW = 10
export const LANDING_MIN_HITS = 4

export interface LandingHit {
  /** 窗口内的章（升序），供调用方渲染章号区间。 */
  window: Array<{ chapterNumber: number; landing: EndingLanding; lastSentence: string }>
  /** 窗口内命中 `subjectless-pending` 的章（升序）。 */
  hits: Array<{ chapterNumber: number; lastSentence: string }>
}

export function pendingLandingConvergence(
  inputs: readonly EndingLandingInput[],
  window = LANDING_WINDOW,
  minHits = LANDING_MIN_HITS,
): LandingHit | null {
  const usable = inputs
    .filter(item => Number.isSafeInteger(item.chapterNumber) && String(item.content ?? '').trim())
    .map(item => ({
      chapterNumber: item.chapterNumber,
      content: String(item.content),
      castNames: item.castNames ?? [],
    }))
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .map(item => ({
      chapterNumber: item.chapterNumber,
      landing: endingLandingOf(item),
      lastSentence: chapterEndingProfile(item.chapterNumber, item.content).lastSentence,
    }))
  if (usable.length < window) return null
  // 取**最近**那一段（与 #71 章首收敛同一做法）：收敛是「当下这几章」的形态。
  const slice = usable.slice(-window)
  // 章号必须连续：中间夹着没导入的章不算一条链（同 #66/#71）。
  for (let index = 1; index < slice.length; index += 1) {
    if (slice[index]!.chapterNumber !== slice[index - 1]!.chapterNumber + 1) return null
  }
  const hits = slice.filter(item => item.landing === 'subjectless-pending')
  if (hits.length < minHits) return null
  return {
    window: slice.map(item => ({ chapterNumber: item.chapterNumber, landing: item.landing, lastSentence: item.lastSentence })),
    hits: hits.map(item => ({ chapterNumber: item.chapterNumber, lastSentence: item.lastSentence })),
  }
}

