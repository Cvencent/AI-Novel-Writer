/**
 * 期限宣告的**结算对账**（issue #101）。
 *
 * 现象：那本 46 章的悬疑长篇里，悬念几乎全靠一个装置——**期限**。每一章都在给下一个
 * 期限（「明早签字结案」「今夜别想开船」「天亮前得还」「日落前核完」「明日中午，逾时结案」），
 * 但 46 章读下来**没有一个期限真的到期过**：
 *
 *   结算词（期限已过／逾期／到期／误了时辰／已经迟了）全文 **0 处**；
 *   期限类词 **79 处 / 覆盖 29 章**。
 *
 * 「结案」从第 5 章喊到第 46 章（跨 42 章），每一次都被下一个期限顶掉；12 条明确期限里
 * **6 条下一章整章不再提**。读者对期限的敏感度会被磨掉：第 1 次「明早交不出就完了」还有
 * 压力，第 12 次「逾时结案」读者已经学会「这个期限不会来」——而这本书的紧张感全押在期限上。
 *
 * 为什么产品没拦：`#66` 的「通牒式收尾」判的是**章末最后一句的句式**（是不是警告/条件句），
 * 不看**这条期限后来有没有落地**；蓝图 `suspense_hook` 写满期限，但**没有任何字段记
 * 「上一章那个期限到期了没有、后果是什么」**；`costs_and_turns` 记代价与转折，也不含期限结算。
 * 期限在这套系统里是**只写不读**的。
 *
 * 判据刻意**结构性、窄**（本仓在 #30/#43/#70/#80/#93/#96/#99/#106 反复吃过词表过拟合的亏）：
 *   ① **宣告** = 「**截止时点**（封闭时间词类）**且** **后果威胁**（封闭语用类）」**同句**。
 *      只认截止点；「开航前，他去取账本」这类**已发生的场景时点**因为没有后果威胁而被排除
 *      （标定时正是靠这一条把 17 条噪声降到 8 条）。
 *      刻意**排除「从今晚起…」**——那是**持续禁令**（属 #105 的领域），不是期限。
 *   ② **对账** = 下一章里出现 ①「同一时间词的复述」或 ②「结算语用标记」之一。
 *   ③ 两者都没有 → 漏账。
 * 只比**相邻两章**（宣告章 → 下一章）：期限的张力本来就只在「下一章还没交代」时最大。
 */

/** 截止时点（封闭时间词类）。刻意不含「从今晚起」的起始点读法。 */
const DEADLINE_TIME = /(天亮前|天亮之前|日落前|太阳落山前|中午前|开航前|收摊前|逾时|期限|为限|明早|明日|明天|后天|三日内|两日内|两天内|今夜|今晚|当夜)/u
/** 后果威胁（封闭语用类）：期限之所以是期限，靠的是它带着一个后果。 */
const DEADLINE_THREAT = /(不许|别想|扣下|停船|作废|摘|卷铺盖|逾时|逾期|后果|交不出|核不出|得还|别再来|不许再|原样交回|重出|没了|别上|得进)/u
/**
 * 「…起」起始点：**持续性禁令/状态变更**的开始，不是截止期限（属 #105 的领域）。
 *
 * 标定时两处靠它排除：`「这个柜台上的人，从今晚起不许再跟姓周的说一个字。」`（带「从」）
 * 与 `「今晚起，你的牌子摘了。」`（不带「从」）。后者尤其重要——下一章确实提了「林棠的牌子摘了」，
 * 若按期限口径去判就会报成假阳性：那是**处境变更**被后续章节正常处理，不是期限漏账。
 */
const PERSISTENT_BAN = /(?:从)?(?:今晚|今夜|现在|明天|此后|从此|今日|当天)起/u
/**
 * 时点词 → **同一时间语义的写法族**（用于判「下一章有没有提这条期限」）。
 *
 * 判据是语言事实而不是题材词表：说「日落前」的人在下一章可能说「日落」、
 * 说「明早」的人可能说「明天」——这几个写法指的是同一个截止点。不收同族之外的词。
 */
const TIME_FAMILY: Readonly<Record<string, readonly string[]>> = Object.freeze({
  天亮前: ['天亮'], 日落前: ['日落'], 中午前: ['中午'], 开航前: ['开航'], 收摊前: ['收摊'],
  逾时: ['逾时'], 期限: ['期限'], 为限: ['为限', '期限'],
  明早: ['明早', '明日', '明天'], 明日: ['明日', '明天', '明早'], 明天: ['明天', '明日', '明早'],
  后天: ['后天'], 今夜: ['今夜', '今晚'], 今晚: ['今晚', '今夜'], 当夜: ['当夜', '今夜', '今晚'],
  三日: ['三日', '三天'], 两日: ['两日', '两天'], 两天: ['两天', '两日'],
})
/** 时点词按长度降序（供「取最长命中」）。 */
const TIME_TOKENS = Object.keys(TIME_FAMILY).sort((left, right) => right.length - left.length)
/** 结算语用标记（到期/逾期/延期/作废）：封闭类，不是题材词表。 */
const SETTLEMENT = /(期限已过|期限到了|到期|逾期|过了期限|时限到了|误了时辰|已经迟了|来不及|作废|不算数|宽限|延期|拖到|改到|改期|推迟)/u

export interface DeadlineChapter {
  chapterNumber: number
  content: string
}

export interface UnsettledDeadline {
  /** 宣告期限的那一章。 */
  declaredAt: number
  /** 承载宣告的那一句（用于证据）。 */
  declaration: string
  /** 该期限里的截止时点词。 */
  timeToken: string
}

/** 把一章切成句子（含引号结尾，避免把台词尾部切断）。 */
function sentencesOf(content: string): string[] {
  return String(content ?? '')
    .replace(/^#{0,4}\s*第\s*\d+\s*章[^\n]*\n/u, '')
    .split(/(?<=[。！？…”」])|\n+/u)
    .map(sentence => sentence.trim().replace(/^[“「『"]+/u, '').trim())
    .filter(Boolean)
}

/** 本章宣告的**第一条**带后果的截止期限（一句一条：同一章多个期限只报最靠前的一条，避免刷屏）。 */
export function deadlineDeclarationIn(content: string): UnsettledDeadline['declaration'] | null {
  for (const sentence of sentencesOf(content)) {
    if (!DEADLINE_TIME.test(sentence)) continue
    if (!DEADLINE_THREAT.test(sentence)) continue
    if (PERSISTENT_BAN.test(sentence)) continue
    return sentence
  }
  return null
}

/** 下一章是否对这条期限做了对账（提到同一时间族的词，或出现结算标记）。 */
function settlesIn(content: string, timeToken: string): boolean {
  const text = String(content ?? '')
  if (SETTLEMENT.test(text)) return true
  const family = TIME_FAMILY[timeToken] ?? [timeToken]
  return family.some(word => text.includes(word))
}

/**
 * 找出「宣告了期限、下一章却没对账」的相邻章对（issue #101）。
 *
 * 只比**相邻两章**、且要求章号真的相邻（中间夹着没导入的章不算一条链——同 #66/#71）。
 */
export function findUnsettledDeadlines(chapters: readonly DeadlineChapter[]): UnsettledDeadline[] {
  const usable = chapters
    .filter(item => Number.isSafeInteger(item.chapterNumber) && String(item.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
  const results: UnsettledDeadline[] = []
  for (let index = 0; index < usable.length - 1; index += 1) {
    const current = usable[index]!
    const next = usable[index + 1]!
    if (next.chapterNumber !== current.chapterNumber + 1) continue
    const declaration = deadlineDeclarationIn(current.content)
    if (!declaration) continue
    const timeToken = TIME_TOKENS.find(token => declaration.includes(token))
    if (!timeToken) continue
    if (settlesIn(next.content, timeToken)) continue
    results.push({ declaredAt: current.chapterNumber, declaration, timeToken })
  }
  return results
}

/**
 * 期限宣告未对账 → 一致性发现（issue #101）。
 *
 * `stableFactKey` 按「宣告章 + 截止时点词」记账、**不带当前章号**
 * （#86/#89/#98/#108 的教训：带当前章号的 key 会随章滚动，作者点「我已知」永远关不掉）。
 * 同一章同一期限只报一条；`sourceChapter` 指向**宣告章**（是旧账，不是正在写的那一章）。
 */
export function findUnsettledDeadlineFindings(input: {
  chapters: readonly DeadlineChapter[]
  /** 当前章（用于兜底 sourceChapter；通常就是最后一章的下一章）。 */
  currentChapter?: number
}): Array<{
  stableFactKey: string
  severity: 'warning'
  sourceChapter: number
  evidence: string
  issue: { zhCN: string; enUS: string }
  suggestion: { zhCN: string; enUS: string }
}> {
  return findUnsettledDeadlines(input.chapters).map(hit => ({
    // key 锚在「哪一章宣告的哪个期限」上，不含当前章号。
    stableFactKey: `deadline:unsettled:${hit.declaredAt}:${hit.timeToken}`,
    severity: 'warning' as const,
    sourceChapter: hit.declaredAt,
    evidence: `第${hit.declaredAt}章宣告「${hit.declaration.slice(0, 70)}」，而第${hit.declaredAt + 1}章整章没有对这条期限做任何交代（既没提「${hit.timeToken}」，也没有到期/逾期/延期/作废一类的落定）`,
    issue: {
      zhCN: `第${hit.declaredAt}章抛出了一个带后果的期限（「${hit.declaration.slice(0, 50)}」），但第${hit.declaredAt + 1}章**整章没有再提它**——既没有兑现在期限前做完，也没有写它过期、被谁延后或作废。期限是悬念的计息方式：给了一次不兑现，读者就学会「这个期限不会来」；给到第十二次，后面的期限就都不再有压力。而这类问题**单章读不出来**，只有把相邻两章的期限排起来才看得见。`,
      enUS: `Chapter ${hit.declaredAt} sets a deadline with a stated consequence (“${hit.declaration.slice(0, 50)}”), but chapter ${hit.declaredAt + 1} never mentions it again — no payoff before the deadline, and no note that it lapsed, was deferred, or was voided. Deadlines are how suspense accrues interest: let one go unpaid and readers learn the deadline will not arrive; by the twelfth, none of them carry pressure. This is also invisible in a single chapter — only lining up adjacent chapters shows it.`,
    },
    suggestion: {
      zhCN: `三选一，任何一种都行，但**必须落到下一章的正文里**：①**兑现**——写出在期限前把事情办成（哪怕办砸，只要交代结果）；②**逾期**——写明期限到了而没做到，以及它的后果（谁因此受损、谁改了口）；③**明确延期**——谁改的口、为什么改（让延期本身成为情节）。如果这条期限本来只是随口一句台词、不再重要，那就在下一章用一句话收掉它（「那句『明早』没人再提」也可以）。`,
      enUS: `Pick one and put it on the page in the next chapter: (1) pay it off — show the thing done before the deadline, or at least the outcome; (2) let it lapse — state that the deadline passed and what followed (who paid for it, who changed their mind); (3) explicitly defer it — who moved it and why, so the deferral becomes plot. If the line was only ever idle dialogue, close it off in one sentence so it stops weighing on the reader.`,
    },
  }))
}
