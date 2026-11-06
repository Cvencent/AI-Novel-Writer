import type { ConsistencyFinding } from './consistency-preflight'

/**
 * 正文**内容**类判据的统一模型层（用户 2026-11-05 规则）。
 *
 * 用户原话：「不要有任何那个内容上的文字类的写死的判断逻辑，不能去设计词表，
 * 也不能用任何的短语匹配，就是不能有这类的逻辑，内容类的全部让模型判断。」
 *
 * 原先靠题材短语表判断的几族（动作反应 / 场景装置 / 低身姿态 / 道具终结与易手 /
 * 陈旧时长 / 文风套话）本质都是「这句话在说什么」——**必须交模型**。
 * 本模块只提供一次模型调用所需的三件可断言的东西：
 *
 * | 步骤 | 谁做 |
 * |---|---|
 * | 把哪几章、问什么、要什么 JSON 形状 | **规则**（`buildContentReviewPrompt`） |
 * | 答案能否核对（章号在范围内、引文能逐字定位、类别在白名单里） | **规则**（`parseContentReview`） |
 * | 「这里有没有重复的写法 / 这一拍是不是同一种动作」 | **模型** |
 * | 采纳 | **作者** |
 *
 * ⚠️ 「类别」是**判据的轴**（我们要模型回答哪几个问题），不是内容词表：
 * 轴的名称里不含任何题材词，模型按自己的理解去正文里找。
 */

/** 我们要模型回答的问题（判据轴）。**不是**词表：每条只说明「找什么现象」。 */
export const CONTENT_AXES = Object.freeze({
  'repeated-reaction': [
    '同一个角色的同一种反应式短句在多个章里反复出现（受挫时的固定反应、进场时的固定动作）',
    'the same reaction short-line repeating across chapters for one character',
  ],
  'repeated-device': [
    '同一个场景装置／起手动作在多个章里被反复用来开场（下舱、拧阀、蘸水这类固定程序）',
    'the same staging move used to open scene after scene',
  ],
  'prop-terminal': [
    '同一件道具被「终结」了两次以上（烧掉／丢掉／交出去之后又再被终结一次）',
    'the same prop destroyed or given away more than once',
  ],
  'prop-moved': [
    "同一件道具**换了持有者或所在处**，而正文没有写出那一次交接动作。五种形状都算（issue #190 / #191 / #193 / #194）：（a）**同一章之内**——前一拍写它被收回某处、或在某只手里，后一拍它已经在另一只手里（那处已经空了），中间只有「递回去再试一次」这类**借用**、没有「交给／带走／还回来」这类**交付**；（b）**跨章**——它被明确交出、归档、封存或随某物一起归到某处之后，后面的章节又从原持有者身上取出、或在别处出现，中间没有取回动作；（c）若持有者变了之后，**原持有者还要用它干他本来那件活**（下一拍他仍在做那件离了它做不成的事），也要报——那是逻辑断裂，不只是交接没写。（d）**被封存的东西未经启封就出现**——它已被写成随某物一起封上、送检送出、入库归档，后面又在**别处**（另一个人的私包、另一张桌上）被当随身物或现有物清点、取出、对笔，而中间没有任何启封／取出动作；（e）**固定存放点被整体搬动却没有搬运动作**——一个容器（柜、箱、架子）此前一直被写成钉在某处、靠某面墙、锁在某个房间里，后文它却出现在另一个房间／场地，而中间没有一句「谁搬的、几人抬的、什么时候」；",
    "a prop changes hands, location, or sealed state with no on-page action accounting for it. Five shapes count (issue #190 / #191 / #193 / #194): (a) WITHIN one chapter, a beat puts it away or in one person’s hands and the next beat has it in someone else’s (or the place is now empty), with only a borrow-and-try-again beat in between, never a hand-over, take-away or give-back; (b) ACROSS chapters, it is explicitly handed in, archived, sealed, or filed away with something else, and a later chapter produces it again from the original holder with no retrieval shown; (c) the original holder still has to do the work that requires it in the very next beat, which is a logical break rather than a missing handover; (d) something already written as SEALED (a seal pressed on it, sent off for inspection, filed into storage) later turns up elsewhere in a private bag or on a table and is inventoried or produced as a current item, with no unsealing or retrieval shown; (e) a FIXED container (a cabinet, a box, a rack) previously written as bolted to a wall or locked in one room now stands in another room, with no line saying who moved it, how many carried it, or when.",
  ],
  'stale-duration': [
    '同一处状态（空着／关着／停着）用了两个互不相容的时长（先说三天，后说一个多月）',
    'one state described with two incompatible durations',
  ],
  'appellation-unbridged': [
    '同一个人或同一件东西在相邻章之间换了一个提称（职务名 / 衣着代称 / 「那个人」），而正文**没有一句把两个提称接起来**，读者无法确认是不是同一个（issue #213）',
    'one person or object is referred to by a different label in a later chapter (a job title, a piece of clothing, "that one") with no line linking the two labels, so a reader cannot tell it is the same one (issue #213)',
  ],
  'established-status-reset': [
    '前文已经写明的**身份、资格或认知**在本章被无声推翻：某人此前已被确立为「已登记 / 有资格 / 被认识 / 已在其中」，本章却把他写成「尚未登记 / 无资格被拦下 / 没人认识」；或者反过来，本章声称某人向来如此，而前文写的是另一回事。中间**没有任何一句交代这个变化**（issue #208 / #199）',
    'an identity, qualification or recognition already established in earlier chapters is silently overturned here: someone written earlier as registered / qualified / known is now written as unregistered, turned away as unqualified, or treated as a stranger — or this chapter asserts something was always so while the earlier text said otherwise. No line accounts for the change (issue #208 / #199)',
  ],
  'content-overlap': [
    '本章把**前文已经完整写过的一段事件**又写了一遍：同一组动作／同一段因果链（某件东西被翻出、某件事被处置、某个人被安置）在此前某章已经发生并收过线，本章再来一次，且时间线还倒回去了（前章已经推到「多年后」，本章回到「当天」）；两处给出的后续也不一样（issue #206）',
    'this chapter replays an event the book already wrote and closed: the same sequence of actions or the same causal chain (something dug out, something disposed of, someone placed) happened in an earlier chapter, and here it happens again — with the timeline moving backwards (the earlier chapter already jumped ahead, this one is back on the day) and with a different outcome (issue #206)',
  ],
  'reassigned-slot': [
    '同一个**有主的格位/名额**被改了归属，而正文没有任何一句把两次说法接起来（issue #231）：某个编号的格子、某个座次、某个名额、某个待填的位置，前文已经写明它是谁的（空着留给某人、已落了某人的名、某人为某人留着），本章却写成它是给另一个人留的／属于另一个人——两种归属互斥，中间没有「改留」「转让」「除名」这类被写出来的改变动作。这是长篇里读者记得最牢的压力源之一（「主角自己的位置被顶掉」），突然改口等于把之前的紧张感作废',
    'the OWNERSHIP of a named slot/seat/quota changes with no line bridging the two claims (issue #231): a numbered cell, a seat, a reserved place, a slot waiting to be filled was previously written as belonging to or reserved for one person (left empty for them, their name already in it, someone keeping it for them), and this chapter states it was left for or belongs to someone else — the two claims contradict and no line writes the change (reassignment, transfer, removal)',
  ],
} as const)

/**
 * **每一轴**的「读者会遇到什么」与「该怎么改」（issue #185）。
 *
 * 现场：5 条 finding 覆盖 3 个不同的轴，而**建议与解释逐字相同** ——
 * 那句「换这一拍的落点」对 `repeated-reaction` / `repeated-device` 成立，
 * 对 `prop-terminal`（该删一次终结）、`prop-moved`（该补交接动作）、
 * `stale-duration`（该统一时长）**根本讲不通**：作者照字面做，会把
 * 「铜墨盒昨夜已交稽核组封存」换成另一句话，而真正缺的是那次交接动作。
 *
 * ⚠️ 这两张表是**判据的轴 → 改法**的映射（与 `CONTENT_AXES` 同形、同源），
 * 不是内容词表：轴的名称里不含任何题材词，改法只说「该动哪一类东西」。
 */
export const CONTENT_AXIS_GUIDANCE = Object.freeze({
  'repeated-reaction': {
    problem: ['同一个反应短句反复出现', 'the same reaction line keeps coming back'],
    fix: [
      '换这一拍的落点：换由谁来做、换在场的人看见什么、换它这次造成的后果；或者在保留动作的同时**给它一个新的信息**（这次拿到的和上次不一样）。',
      'Move this beat’s landing: change who does it, what the people present notice, or the consequence it produces this time — or keep the action but give it new information.',
    ],
  },
  'repeated-device': {
    problem: ['同一个场景装置反复用来开场', 'the same staging move keeps opening scenes'],
    fix: [
      '换一个**开场装置**：这一次从别的东西切进去（一个声音、一件物的位置、某人的一句半截话），别再用同一套程序把场景点着。',
      'Open differently: cut in through something else this time (a sound, where an object ended up, half a line of dialogue) instead of lighting the scene with the same procedure.',
    ],
  },
  'prop-terminal': {
    problem: ['同一件道具被终结了不止一次', 'the same prop was destroyed or handed away more than once'],
    fix: [
      '**删掉后一次终结**，或者补一句它为什么还能用（被找回、另一件同名物、上次只是收起来）。两次终结并排出现时，读者会以为前面那次的代价白付了。',
      'Delete the later termination, or say on the page why it is still in play (recovered, a different object with the same name, merely put away last time). Two terminations side by side make the earlier cost look like it never mattered.',
    ],
  },
  'prop-moved': {
    problem: ['道具换了持有者／所在处却没有交接', 'a prop changed hands or place with no handover'],
    fix: [
      '**补一句交接动作**：谁在什么时候、什么条件下把它交给谁（或在什么地方取出／放回）。不是换个说法重描，而是把「它怎么到这里的」写出来。⚠️「**递回去让他再试一次**」不是交接——那是借；真正的交接要写清它**留在谁那里**。⚠️ 若下一拍原持有者还要用它干那件离了它做不成的事，这一处是**逻辑断裂**，光补一句交接不够：要么把物还给原持有者，要么改写他随后那件活。⚠️ 已被封存的东西再出现（(d)），必须先写一次**启封／取出**（谁启、在哪、谁在场），或者承认它其实没被封进去——只说「誊封时抄的」这类新说法不算交代，那是换了一个来源。⚠️ 固定存放点换了房间（(e)），要么补一次**搬运动作**（谁搬、几人、何时、谁许可），要么把这一场改成**人走到柜子跟前**（原来的写法是可行的，别让同一句台词对应两种物理上互斥的实现）。',
      'Write the handover: who gives it to whom, when, under what condition (or where it was taken out and put back). This is not a rewording — it is the missing step of how it got here.',
    ],
  },
  'stale-duration': {
    problem: ['同一处状态用了两个不相容的时长', 'one state carries two incompatible durations'],
    fix: [
      '**统一成同一个时长**，并交代这段时间里状态有没有变过（一直空着？中间被人动过？）。两个数字并排出现时，读者只会觉得作者自己也没记住。',
      'Settle on one duration and say whether the state changed in between (still empty? touched meanwhile?). Two figures side by side only tell readers the author lost track.',
    ],
  },
  'established-status-reset': {
    problem: ['前文已确立的身份／资格被本章无声推翻', 'an established status is silently overturned here'],
    fix: [
      '**二选一，别两头都改**：① 在本章补一句交代它为什么变了（被除名、资格到期、换了管辖、此人确实不是原来那位）——**变化必须落在正文里**；② 若本章的写法才是对的，就把前文那几处一起改掉，并同时修正**事实账本与章节要点**里那条状态，否则后面每一章起草都会继承旧值。身份/资格类错误最伤的是它**看起来像角色的正常反应**（新掌柜不认人、门房按规矩拦人），读者直到回头翻前文才会发现前后打架。',
      'Pick one, do not patch both ends: either add a line here explaining why it changed (struck off, qualification expired, different jurisdiction, this really is not the same person) — the change has to land on the page — or, if this chapter is right, correct the earlier passages too **and** the matching entry in the fact ledger and chapter summary, or every later chapter will inherit the old value. Status errors are insidious because the scene reads like normal behaviour (a new clerk who does not know the staff, a gatekeeper following the rule); only a reader paging back sees the contradiction.',
    ],
  },
  'appellation-unbridged': {
    problem: ['同一个人／东西换了提称却没有接起来', 'the same person or thing gets a new label with nothing linking them'],
    fix: [
      '**补一句桥接**（首次换称时写「就是昨日那位管清库的」这类），或**统一成一个称呼**：要么全用职务名，要么全用那个代称。**不要只改其中一处**——两处都改才叫统一，改一处会让读者更确定这是两个人。这一拍往往正是情节的支点（谁封的袋、谁动过那张纸），读者认不出人，整段推理就变成流水账。',
      'Add one bridging line the first time the label changes ("the one who sealed it yesterday"), or settle on a single label throughout — job title or nickname, not both. Do not fix only one instance: changing one and not the other makes it look even more certainly like two different people. This beat is usually the hinge of the plot, so a reader who cannot tell who is who loses the whole chain.',
    ],
  },
  'content-overlap': {
    problem: ['本章重演了前文已收线的一段事件', 'this chapter replays an event that was already written and closed'],
    fix: [
      '**二选一**：① 删掉本章这一遍，改成**承接**它——写那件事留下的后果、或别人对它的反应（同一件事只发生一次，第二次写的是它的余波）；② 若本章这一遍才是对的，就把前文那一遍删掉或改成**预告**（当时只是提到、并未发生）。⚠️ 两遍并排时最伤的是**时间线**：前章若已推到「多年后」，本章回到「当天」会被读成闪回，而正文没有闪回标记——读者刚合上书又被拽回去。改完还要看**事实账本**：两遍各自收进的事实现在互相矛盾，留哪一条要一起定。',
      'Pick one: either delete this chapter pass and turn it into the consequence — show what that event left behind, or how people reacted to it (an event happens once; the second mention is its aftermath) — or, if this chapter version is right, delete or downgrade the earlier one into a mere mention. The worst part of having both is the timeline: if the earlier chapter already jumped years ahead, coming back to "that same day" reads as a flashback with no marker, and the reader is yanked back right after closing the book. Then check the fact ledger: the two passes have each recorded their own fact and they now contradict.',
    ],
  },
  'reassigned-slot': {
    problem: ['同一个有主的格位/名额被改了归属却没有交代', 'the ownership of a named slot or reserved place changes with no bridging line'],
    fix: [
      '**二选一**：① 若两次说法指的**不是同一个**格位/名额，把它与前文那一格区分开（换个编号、写明位置差异、或借人物一句「不是那一格」），别让读者把两处读成同一格；② 若**确实是同一格**且归属变了，就要写出那次改变的动作（谁除的名、谁改的留、什么时候、为什么），并同步**事实账本**里的旧条目——否则下一章起草会继承旧归属。⚠️ 这是读者记得最牢的压力源之一：前文「他的名字要被写进那一格」的紧张感，到后面突然改口又没解释，等于整段作废。',
      'Pick one: either make it a DIFFERENT slot or seat than the one established earlier (a different number, an explicit distinction, a character noting "not that one"), or, if it really is the same slot and the ownership changed, write the change on the page (who struck the name, who changed the reservation, when, and why) and update the matching entry in the fact ledger — otherwise the next chapter inherits the old owner. This is one of the pressures readers remember best: the earlier tension of "his name is about to go into that slot" is voided by an unexplained change.',
    ],
  },
} as const)

/**
 * 界面那颗「核对…」按钮**要问哪些轴**（issue #219）。
 *
 * 为什么要有这个常量：轴名原来要在**三处**各写一遍（本表 / `CONTENT_AXIS_GUIDANCE` /
 * 界面调用点硬编码数组），而没有任何守卫保证三处一致。漏在第三处的后果是**静默**的：
 * 那个轴永远不会被问、永远不会产出 finding，而代码与测试看起来全绿
 * （`#144`/`#151` 同一条教训：「判据写了 ≠ 判据能跑」）。
 *
 * 现在产品代码只引用这一个常量 —— **新增轴只需改这张表**，漏不了。
 *
 * ⚠️ 若将来要「只跑一部分轴」（某个轴太贵/太慢），**改这里**而不是在调用点手写数组；
 * 那也仍然是一处，且这条注释与守卫都会跟着它。
 */
export const CONTENT_AXES_FOR_BUTTON: readonly ContentAxis[] = Object.freeze(Object.keys(CONTENT_AXES) as ContentAxis[])
export type ContentAxis = keyof typeof CONTENT_AXES

export interface ContentReviewChapter {
  chapterNumber: number
  content: string
}

export interface ContentReviewIssue {
  chapterNumber: number
  axis: ContentAxis
  quote: string
  explanation: string
}

export interface ContentReviewRequest {
  chapters: readonly ContentReviewChapter[]
  axes: readonly ContentAxis[]
  recentChapters?: number
  language: 'zh-CN' | 'en-US'
}

/** 每次看最近这么多章（这几族都是「跨章看过同一种写法」，窗口在判据侧收）。 */
export const CONTENT_REVIEW_RECENT_CHAPTERS = 16

export function buildContentReviewPrompt(request: ContentReviewRequest): { system: string, user: string } {
  const en = request.language === 'en-US'
  const limit = request.recentChapters ?? CONTENT_REVIEW_RECENT_CHAPTERS
  const chapters = [...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)
  const axisLines = request.axes.map(axis => `- "${axis}": ${en ? CONTENT_AXES[axis][1] : CONTENT_AXES[axis][0]}`).join('\n')

  const system = en
    ? [
      'Read the chapters and report ONLY the kinds of cross-chapter problem listed below.',
      axisLines,
      'Judge by meaning, not by a fixed word list: the same move written with different words still counts; a word appearing often in different meanings does not.',
      'Each report must quote one exact sentence (or clause) from that chapter. If you cannot quote it, do not report it.',
      'Do not invent props or events that are not in the text. When unsure, do not report.',
      'Output one JSON object: {"issues":[{"chapterNumber":<n>,"axis":"<one of the axes above>","quote":"<exact sentence>","explanation":"<one sentence>"}]}',
      'Report at most 3 issues per axis. If nothing qualifies, output {"issues":[]}. No commentary outside the JSON.',
    ].join('\n')
    : [
      '读这些章节，只报下面这几类**跨章**问题：',
      axisLines,
      '按**意思**判断，不要按固定词表：同一个问题换措辞写仍然算；一个词在不同意思上出现多次不算。',
      '每条都必须**逐字引用**该章正文里的一句（或一个分句）。引不出来就不要报。',
      '不要编造正文里没有的道具或事件。不确定就不要报。',
      '输出一个 JSON 对象：{"issues":[{"chapterNumber":<章号>,"axis":"<上面某一类>","quote":"<原句>","explanation":"<一句话>"}]}',
      '每一类最多 3 条。没有就输出 {"issues":[]}。JSON 之外不要写任何解释。',
    ].join('\n')

  const chapterText = chapters.map(chapter => [
    en ? `### Chapter ${chapter.chapterNumber}` : `### 第${chapter.chapterNumber}章`,
    String(chapter.content),
  ].join('\n')).join('\n\n')
  const user = en ? ['## Chapters', chapterText].join('\n\n') : ['## 章节正文', chapterText].join('\n\n')
  return { system, user }
}

/** 解析并校验模型输出（规则侧）。 */
export function parseContentReview(
  raw: string,
  request: Pick<ContentReviewRequest, 'chapters' | 'axes' | 'recentChapters'>,
): ContentReviewIssue[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFence(String(raw ?? '').trim()))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const list = (parsed as { issues?: unknown }).issues
  if (!Array.isArray(list)) return null
  const limit = request.recentChapters ?? CONTENT_REVIEW_RECENT_CHAPTERS
  const byNumber = new Map([...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)
    .map(chapter => [chapter.chapterNumber, String(chapter.content)]))
  const axes = new Set<string>(request.axes)
  const result: ContentReviewIssue[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const chapterNumber = Number(record.chapterNumber)
    const axis = String(record.axis ?? '')
    const quote = String(record.quote ?? '').trim()
    if (!Number.isSafeInteger(chapterNumber) || !byNumber.has(chapterNumber)) continue
    if (!axes.has(axis)) continue
    const body = byNumber.get(chapterNumber)!
    if (!quote || !body.includes(quote)) continue
    const key = `${chapterNumber}:${axis}:${quote}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      chapterNumber,
      axis: axis as ContentAxis,
      quote,
      explanation: String(record.explanation ?? '').trim(),
    })
  }
  return result
}

function stripFence(value: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(value)
  return fenced ? fenced[1]! : value
}

/** 把模型判出的内容问题转成一致性发现。 */
export function contentReviewFindings(issues: readonly ContentReviewIssue[]): ConsistencyFinding[] {
  /**
   * **同章同轴合并成一条**（issue #164 建议 ②）。
   *
   * 提示词允许「每类最多 3 条」，而 key 只含 `轴 + 章号`——于是同章同轴的第 1、2 条
   * 拿到完全相同的 key：React 列表复用错节点、**ack 按 key 精确匹配会把没修的那条一起静默掉**、
   * `findingByKey` 只留最后一条（#120 的标题错配）。
   *
   * 合并后语义也变正确：**一条提醒 = 这一章这个轴的一个判断**，
   * 作者 ack 它就是把「这一章这个轴」整个认了；而不是「认了其中一句」。
   */
  const grouped = new Map<string, ContentReviewIssue[]>()
  for (const issue of issues) {
    const key = `${issue.axis}:${issue.chapterNumber}`
    const list = grouped.get(key) ?? []
    list.push(issue)
    grouped.set(key, list)
  }
  return [...grouped.values()].map(list => {
    const first = list[0]!
    /** issue #185：**按轴**取「问题读法」与「改法」，不再用同一段常量套所有轴。 */
    const guide = CONTENT_AXIS_GUIDANCE[first.axis]
    const axisLabel = CONTENT_AXES[first.axis][0]
    const quotes = list.map(item => `「${item.quote}」`).join('、')
    const explanations = list.map(item => item.explanation).filter(Boolean).join('；')
    const count = list.length
    return {
      // 章号 + 轴是既成事实；不带「当前章」（#86/#89/#98/#108）。
      // ⚠️ 合并后**天然唯一**：一章节一轴只出一条，见上面的分组。
      stableFactKey: `prose:${first.axis}:${first.chapterNumber}`,
      severity: 'warning' as const,
      sourceChapter: first.chapterNumber,
      evidence: `第${first.chapterNumber}章（${CONTENT_AXES[first.axis][0]}）${count > 1 ? `${count} 处：` : ''}${quotes}`,
      issue: {
        // issue #185：解释串**按轴取** —— 「读者读到的是流程」只对两个 repeated-* 轴成立。
        // issue #185 建议 ③：轴名必须**写在正文里**（原来只在「来源」行的括号中出现，作者看不出是哪一类）。
        zhCN: `第${first.chapterNumber}章（${axisLabel}）${count > 1 ? ` ${count} 处` : '一处'}：${guide.problem[0]}。原文${quotes}${explanations ? `——${explanations}` : ''}`,
        enUS: `Chapter ${first.chapterNumber} has ${count > 1 ? `${count} places with ` : ''}${guide.problem[1]}: ${quotes}${explanations ? ` — ${explanations}` : ''}.`,
      },
      suggestion: {
        // issue #185：改法**按轴取** —— 「换这一拍的落点」对 prop-terminal / prop-moved / stale-duration 是错的。
        zhCN: guide.fix[0],
        enUS: guide.fix[1],
      },
    }
  })
}
