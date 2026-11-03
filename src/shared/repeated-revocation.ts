/**
 * 同一项**不可逆处境变更**被宣告两次（issue #105）。
 *
 * 现象：那本 47 章的悬疑长篇里，「林棠被撤出售票口」被当成**不可逆处分宣告了两次**，
 * 而第一次从头到尾没有落地——她被撤职之后的 34 章里照常在柜台上当班：
 *
 *   第 12 章：邵广海当众拽走她的钥匙串，「从今天起，你别上这个柜台。」
 *   第 13–46 章：她照常在柜台后数票、从柜台里递纸（正文里提「柜台」7 章）
 *   第 47 章：邵广海**第二次**宣布「售票口明天换人」「你的牌子摘了」，第二次收走钥匙
 *
 * 而**蓝图账本也把同一笔账记了两遍**：
 *
 *   bp12 costs_and_turns：售票口的**位置没了**，从此不能再与周叙公开见面…
 *   bp47 costs_and_turns：林棠被当众注销售票口身份、交出钥匙，**从此不能再上码头**…
 *
 * 也就是说，第 12 章就已经把「位置没了」记进代价账本并当众宣判，正文却当作没发生。
 *
 * 为什么产品没拦住（issue 自己列的对照）：
 *   - `loss-restatement.ts`（#75）只认**遗忘类指称物**被跨章重述，读的是「记忆损失」；
 *   - `prop-termination.ts`（#73/#77/#78）管**物件**被终结两次；
 *   - `blueprint-semantic-contract.ts` 对 `costsAndTurns` 只要求非空 + 类型正确，
 *     **没有「同一代价不得重复记账」这一维**。
 * 三者都读不到「人物的**身份 / 权限 / 处境**发生不可逆变更，然后被静默还原」。
 *
 * 判据刻意**结构性、窄**（本仓在 #30/#43/#70/#80/#93/#96/#99/#105/#106 反复吃过词表过拟合的亏）：
 *   ① **不可逆假设**：账本里的措辞属于**封闭语用类**（从此不…／永久／再也／不可逆／断掉…）；
 *   ② **同一处境**：用一个**功能类**处境词锚定（柜台/位子/牌子/职务/身份/码头/渠道…），
 *      不是题材词表——任何写「岗位、权限、通道」的作品都用这套词；
 *   ③ **第一次没落地**：在「宣告章 A → 后一次宣告章 B」之间，正文里**仍反复出现该处境词**
 *      （≥`RELAPSE_MIN_CHAPTERS` 章）——读者看到的是「她明明已经不能碰这个柜台，却一直在柜台后」；
 *   ④ 两次宣告**相隔 ≥ `REVOKE_MIN_GAP` 章**：挨着的两次是同一次事件的重述，不算重复宣告。
 *
 * 标定（两本书真实语料）：sim2 命中 **1 条**（售票口 ch12→ch47，其间正文 7 章仍提该处境）；
 * 0202（写法本就干净）**0 条**。
 */

/** 不可逆的措辞（封闭语用类）：断言的是永久丧失，不是一次挫折。 */
const IRREVERSIBLE = /(从此(?:不|再|不能|只能|无)|永久|再也|不能再|不再能|回不来|不可逆|断掉|彻底没了|没处说理)/u
/**
 * 处境 / 权限指称（功能类）：岗位、位置、身份、通道。
 * 不是题材词表——写任何题材的「一个人被赶出他的位置」都会用这套词。
 *
 * ⚠️ 标定踩到的两条：
 *   - 必须含**具体的岗位/场所名**（如「售票口」）：issue 那本书的两条账本都用它
 *     （bp12「售票口的位置没了」/ bp47「注销售票口身份」），而「位置」「身份」各自都不重复。
 *   - ⚠️ **刻意不收「验票」**：在 0202 里它是**场所名**（验票舱），一次正当的职务变更
 *     会让整个舱在正文里反复出现 → 假阳性。判据只收**「这个人的这个位置」**的名词，
 *     不收会被当成场景的设施名。
 */
const STATE_NOUNS = ['柜台', '位子', '售票口', '牌子', '职务', '岗位', '差事', '身份', '上岸'] as const
/** 两次宣告至少要隔这么多章才算「重复宣告」；挨着的两次是同一次事件的重述。 */
export const REVOKE_MIN_GAP = 8
/**
 * 「第一次没落地」的证据门槛：其间正文至少这么多章出现「**当事人 + 处境词 + 处置动作**
 * 同句」——即当事人在这个处境里做事。
 *
 * ⚠️ 标定三轮才定下这个粒度：
 *   ① 用「整章含处境词」太松——0202 的「验票舱」作为**场所**反复出现，会把一次正当的
 *      职务变更报成重复宣告；
 *   ② 用「同段」仍太松——`「验票舱案上摆着新底册…周叙翻了一回内衬」` 这类段落里，
 *      处境词是**场景**、动作的主语不是它，照样漏进来；
 *   ③ **同句**最准：「林棠在柜台后头数票」把当事人、处境、动作压在一个句子里，
 *      而「验票舱落锁」「周叙经过栈桥」这类场景句不含这三者齐全的形态。
 */
export const RELAPSE_MIN_CHAPTERS = 2
/** 处置动作（封闭的功能类）：当事人在这个处境里「做事」的动词。 */
const HANDLING_ACTION = /(递|抽|数|把|记|写|压|收|核|贴|拿|拍|摊|翻|藏|摸|塞|交|挂|解|站|坐|守|当班|上工|上柜|开|关|锁)/u

export interface IrreversibleLedgerEntry {
  chapterNumber: number
  /** 该章 costs_and_turns 原文。 */
  costs: string
}

export interface ProseChapterFact {
  chapterNumber: number
  content: string
}

export interface RepeatedRevocation {
  /** 被宣告丧失的处境词。 */
  stateNoun: string
  /** 第一次宣告不可逆丧失的章。 */
  firstChapter: number
  /** 第一次的账本原文。 */
  firstCosts: string
  /** 后一次又宣告同一处境的章。 */
  secondChapter: number
  /** 两次之间的章数。 */
  gap: number
  /** 「第一次没落地」的证据章：其间仍提到该处境的章号。 */
  relapseChapters: number[]
}

/** 该章账本是否把某个处境记为不可逆丧失；返回命中的处境词。 */
export function irreversibleStateNouns(costs: string): string[] {
  const text = String(costs ?? '')
  if (!IRREVERSIBLE.test(text)) return []
  return STATE_NOUNS.filter(noun => text.includes(noun))
}

/**
 * 找「同一处境的不可逆丧失被宣告两次、且第一次没有落地」的账（issue #105）。
 *
 * 需要**两边的证据**：蓝图账本（两次宣告）+ 已定稿正文（其间该处境仍反复出现）。
 * 只给账本不足以判定——两次可逆的挫折也会这么写；只给正文也不足——正文不知道哪次是
 * 「不可逆」的宣判。两边的条件都满足才报。
 */
export function findRepeatedRevocations(input: {
  ledger: readonly IrreversibleLedgerEntry[]
  prose: readonly ProseChapterFact[]
  /** 在册角色名：用来判「当事人还在这处境里做事」（同段需出现角色名）。 */
  castNames?: readonly string[]
}): RepeatedRevocation[] {
  const ledger = [...input.ledger]
    .filter(entry => Number.isSafeInteger(entry.chapterNumber))
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
  const prose = input.prose.filter(chapter => String(chapter.content ?? '').trim())
  if (ledger.length < 2 || prose.length === 0) return []
  const castNames = (input.castNames ?? []).filter(name => String(name ?? '').trim())
  // 没有名册就不判：无法确认「还在这处境里做事」的是人而不是场所（标定时 0202 的
  // 「验票舱」正是靠这一条被排除——那是场景名反复出现，不是当事人仍在履职）。
  if (castNames.length === 0) return []
  const out: RepeatedRevocation[] = []
  for (const noun of STATE_NOUNS) {
    const declarations = ledger.filter(entry => irreversibleStateNouns(entry.costs).includes(noun))
    if (declarations.length < 2) continue
    for (let index = 0; index < declarations.length - 1; index += 1) {
      const first = declarations[index]!
      const second = declarations[index + 1]!
      const gap = second.chapterNumber - first.chapterNumber
      // 挨着的两次是同一次事件的重述，不算重复宣告。
      if (gap < REVOKE_MIN_GAP) continue
      // 「第一次没落地」的证据：其间正文里有章出现「当事人 + 处置动作**同句**」，
      // 或整章多次提到该处境词。两条任一即可——前者覆盖「她照常在柜台后头数票」，
      // 后者覆盖「正文里这个位置一直有人在用」。
      const relapseChapters = prose
        .filter(chapter => chapter.chapterNumber > first.chapterNumber && chapter.chapterNumber < second.chapterNumber)
        .filter(chapter => {
          const content = String(chapter.content)
          const onDuty = content.split(/(?<=[。！？…”」])|\n+/u)
            .some(sentence => castNames.some(name => sentence.includes(name)) && HANDLING_ACTION.test(sentence)
              && (sentence.includes(noun) || content.includes(noun)))
          return onDuty
        })
        .map(chapter => chapter.chapterNumber)
      if (relapseChapters.length < RELAPSE_MIN_CHAPTERS) continue
      out.push({
        stateNoun: noun,
        firstChapter: first.chapterNumber,
        firstCosts: first.costs,
        secondChapter: second.chapterNumber,
        gap,
        relapseChapters,
      })
    }
  }
  // 同一处境只留最早的一对（后面的多半是同一事件的余波），并按首次宣告章排序。
  const seen = new Set<string>()
  return out
    .filter(hit => (seen.has(hit.stateNoun) ? false : (seen.add(hit.stateNoun), true)))
    .sort((left, right) => left.firstChapter - right.firstChapter)
}

/** 角色名（用于证据文案：指出是谁的处境被宣告了两次）。 */
function subjectsIn(costs: string, castNames: readonly string[]): string[] {
  return castNames.filter(name => String(costs ?? '').includes(name))
}

/**
 * 重复宣告的不可逆处境变更 → 一致性发现（issue #105）。
 *
 * `stableFactKey` 锚在「处境词 + 首次宣告章」上、**不带当前章号**
 * （#86/#89/#98/#108 的教训：带当前章号的 key 会随章滚动，作者点「我已知」永远关不掉）。
 * `sourceChapter` 指向**首次宣告章**（这是旧账，不是正在写的那一章）。
 * 出路给**三条可执行分支**（#86/#69 的教训：出路必须是产品里真的存在的动作）。
 */
export function findRepeatedRevocationFindings(input: {
  ledger: readonly IrreversibleLedgerEntry[]
  prose: readonly ProseChapterFact[]
  castNames?: readonly string[]
}): Array<{
  stableFactKey: string
  severity: 'warning'
  sourceChapter: number
  evidence: string
  issue: { zhCN: string; enUS: string }
  suggestion: { zhCN: string; enUS: string }
}> {
  const castNames = input.castNames ?? []
  return findRepeatedRevocations(input).map(hit => {
    const subjects = [...new Set([
      ...subjectsIn(hit.firstCosts, castNames),
      ...subjectsIn(input.ledger.find(entry => entry.chapterNumber === hit.secondChapter)?.costs ?? '', castNames),
    ])]
    const who = subjects.length ? subjects.join('、') : '某个角色'
    const relapse = hit.relapseChapters.slice(0, 6).join('、')
    return {
      // key 锚在「哪一项处境在首次宣告章被判为不可逆」上，不含当前章号。
      stableFactKey: `revocation:repeated:${hit.stateNoun}:${hit.firstChapter}`,
      severity: 'warning' as const,
      sourceChapter: hit.firstChapter,
      evidence: `第${hit.firstChapter}章把「${hit.stateNoun}」记为不可逆丧失（「${hit.firstCosts.slice(0, 60)}…」），其后第${relapse}章等 ${hit.relapseChapters.length} 章正文里仍出现「${hit.stateNoun}」；第${hit.secondChapter}章又把同一处境宣告了一次`,
      issue: {
        zhCN: `同一项不可逆的处境变更（**${hit.stateNoun}**）被宣告了两次，而**第一次从未落地**：第${hit.firstChapter}章已经在代价账本里把它记成「不可逆」并当众宣判，可之后第${relapse}章等 **${hit.relapseChapters.length} 章**正文里，「${hit.stateNoun}」照常在（当事人还在这个位置上做事）；直到第${hit.secondChapter}章（相隔 ${hit.gap} 章）同一套处分又演了一遍。对读者来说，第${hit.firstChapter}章那场戏是有分量的转折点，之后若无其事 34 章，等于**作者亲口取消了自己立的转折**——而这期间所有的紧张感都无从建立。这类问题**单章读不出来**，只有把两次宣告摊开才看得出这是第二次。`,
        enUS: `The same irreversible change of standing (**${hit.stateNoun}**) is declared twice, and the **first one never lands**: chapter ${hit.firstChapter} already books it as irreversible in the cost ledger and pronounces it in public, yet in ${hit.relapseChapters.length} later chapters the prose still shows that same position in play; then chapter ${hit.secondChapter} (${hit.gap} chapters later) stages the same removal again. For readers, the chapter-${hit.firstChapter} scene is a real turning point — quietly undoing it for thirty-odd chapters means the author has cancelled their own turn, and none of the tension in between can hold. This is invisible in any single chapter; only lining the two declarations up shows it is the second.`,
      },
      suggestion: {
        zhCN: `三选一，任何一种都行，但**必须落到正文里**：①**让第一次生效**——此后不再让${who}用这个处境（把他留在原位就是让那次宣判消失）；②**写明撤销**——如果第一次的处分被驳回/走了关系/有人保了他，用一两句交代谁改的口、为什么（让「撤销」成为情节）；③**只保留一次**——如果第${hit.secondChapter}章那次才是真正的处分，就把第${hit.firstChapter}章那场戏或它的账本改写清楚（那次是什么、为什么不作数），别让账上记两遍不可逆。`,
        enUS: `Pick one and put it on the page: (1) let the first one take effect — stop using that position for ${who} afterwards, since leaving them in place erases the pronouncement; (2) write the reversal — if the first removal was overturned or someone shielded them, spend a sentence on who changed it and why, so the reversal becomes plot; (3) keep only one — if the chapter-${hit.secondChapter} removal is the real one, rewrite or annotate the earlier scene and its ledger entry (what it was, why it did not stand) instead of booking the same irreversible cost twice.`,
      },
    }
  })
}
