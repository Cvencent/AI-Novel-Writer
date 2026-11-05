import type { ConsistencyFinding } from './consistency-preflight'

/**
 * 「被当成证据的物件」跨章形态是否一致、以及它的物理成因是否自洽——**由模型判断**（issue #156）。
 *
 * ## 现场
 *
 * 第 73 章：`签名旁压着半个红指印，**圆圆的**，比父亲的拇指小一圈。`
 * 第 74 章：`"落款旁那半个红印。"周叙说，"**缺口齐整**。缺了半节的**拇指**按的。"`
 *           `"提叶九来对指印。他右手**小指**缺半节。"`
 *
 * 三处互相咬不上：
 *
 * 1. **同一枚印在两章之间换了形态**：ch73「圆圆的」（无缺口）→ ch74「缺口齐整」；
 * 2. **成因落在不存在的部位上**：叶九缺的是**右小指**，而印被说成「缺了半节的**拇指**按的」。
 *    第 45 章他自己用**拇指**压过页面（拇指完好），角色卡也写着「右小指缺半节」；
 * 3. **对指印那场的物理过程对不上**：`"手。"…右手搁上来…按。…印子缺一角`——
 *    小指不参与按印，整只手按下去也不会只留下「缺半节的拇指印」。
 *
 * 而这条推理是主线最高潮的证据（第 74 章「缺口对上」→ 第 75 章凭它把全叔要回来）。
 *
 * ## 为什么规则做不了这一段
 *
 * 「这枚印的形态与它的成因能不能同时成立」「这两章说的是不是同一枚印」——
 * 都要先读懂句子在说什么。任何「印/痕迹词表 + 部位词表 + 跨章比对」的写法，
 * 都只是把这本书的三处原文编进代码（用户 2026-11-05 定规明令禁止）。
 * issue 建议的 ①②③ 里，②「部位一致性核对」写成规则就是「缺/残词表 × 部位词表 × 按印词表」，
 * 正是禁令针对的形态，所以整条改由模型判。
 *
 * ## 分工
 *
 * | 步骤 | 谁做 |
 * |---|---|
 * | 取哪几章、把角色卡的身体描述一并喂进去、要什么 JSON 形状 | **规则** |
 * | 章号/引文能否逐字定位、要不要整条丢弃 | **规则** |
 * | 「这两章是不是同一件物证」「它的形态与成因能不能同时成立」 | **模型** |
 * | 采纳 | **作者** |
 *
 * ⚠️ 不与 `appearance-consistency` 合并：那一条判的是「正文与**角色卡**相悖」，
 * 本条判的是「**正文内部**（跨章 / 同一物证的物理成因）相悖」。同一处错可能两边都报，
 * 但两者的修法不同（改卡 vs 改正文），且 key 不同，作者可以分别挂起。
 */

export interface EvidenceChapter {
  chapterNumber: number
  content: string
}

/** 角色卡上的身体/外观描述：给模型判「这条成因落在这个人身上对不对」。 */
export interface EvidenceCastCard {
  name: string
  appearance: string
  notes?: string
}

export interface EvidenceShapeRequest {
  /** 要检查的章（已定稿正文，按章号升序最佳）。 */
  chapters: readonly EvidenceChapter[]
  /** 在册角色的外观/补充（只用来核「缺某部位」这类成因）。 */
  cards?: readonly EvidenceCastCard[]
  language: 'zh-CN' | 'en-US'
  /** 最多检查最近多少章。 */
  recentChapters?: number
}

/** 最近这么多章：物证被反复用作证据的跨度通常在十余章内。 */
export const EVIDENCE_SHAPE_RECENT_CHAPTERS = 20

/** 模型给出的一处矛盾。 */
export interface EvidenceShapeIssue {
  /** 主问题落在哪一章（即 `quote` 所在章）。 */
  chapterNumber: number
  /** `same-object-drift`：同一件物证在被当成证据的几章里形态不一致；
   *  `impossible-cause`：物证的形态被归因到一个物理上不成立的部位/动作。 */
  kind: 'same-object-drift' | 'impossible-cause' | 'custody-drift'
  /** 正文原句（必须能在 `chapterNumber` 的正文里逐字找到）。 */
  quote: string
  /** 与之相悖的另一处——另一章的正文原句（跨章漂移时必给）；同一章内矛盾时可等于 quote。 */
  conflictingChapterNumber: number
  conflictingQuote: string
  explanation: string
}

export const EVIDENCE_SHAPE_KINDS = Object.freeze({
  'same-object-drift': [
    '同一件物证（一枚印、一道痕、一件信物）在不同章里被当成同一件证据，但形态对不上（一圆一缺、一大一小、一深一浅）；**或同一个容器（盒盖内沿、夹层、柜格、内衬、封套）里装的东西换了**（一处是字、一处是印；一处是一页纸、一处是指模），而正文没有交代它被换过（issue #186）；**或一句话把某件东西拿去和「前文某处的东西」比（「跟 X 一样」「和上次那只同一件」），而那个参照物从来不存在、或里面装的不是这种东西**（issue #176）',
    'the same piece of evidence described inconsistently across chapters with no in-story change — OR the CONTENTS of one container (a box lid rim, a lining, a drawer, an envelope) change from chapter to chapter (writing one time, a seal another; a page another time, a fingerprint another) with no in-story swap — OR a line compares one thing to \'the one in X\' / \'the same one as last time\' when X never held that thing, or the referent never existed at all (issue #176)',
  ],
  'impossible-cause': [
    '物证的形态被归因到一个物理上不成立的人或动作（某人的某个部位缺了半节 → 于是印上有缺口，但他按印时用的不是那个部位；或者那件物证根本不会留下这种痕迹）',
    'a physical trace attributed to a body part or action that could not have produced it',
  ],
  'custody-drift': [
    '同一件被扣押/收存的实物，它的**保管人、锁具状态、所在房间**在相邻章之间变了，而正文没有写任何交接（issue #182）',
    'the keeper, locked state, or room of a seized object changes between chapters with no handover on the page',
  ],
} as const)

export function buildEvidenceShapePrompt(request: EvidenceShapeRequest): { system: string, user: string } {
  const en = request.language === 'en-US'
  const limit = request.recentChapters ?? EVIDENCE_SHAPE_RECENT_CHAPTERS
  const chapters = [...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)
  const cards = (request.cards ?? []).filter(card => String(card.name ?? '').trim()
    && `${card.appearance ?? ''}${card.notes ?? ''}`.trim())
  const kinds = (['same-object-drift', 'impossible-cause', 'custody-drift'] as const)
    .map(kind => `- "${kind}": ${en ? EVIDENCE_SHAPE_KINDS[kind][1] : EVIDENCE_SHAPE_KINDS[kind][0]}`)
    .join('\n')

  const system = en
    ? [
      'Read the chapters. Some objects are used as EVIDENCE in the plot (a fingerprint, a mark, a seal, a torn edge, a receipt).',
      'Report only these three kinds of problem:',
      kinds,
      'Judge by meaning, not by a fixed word list: the same object may be named differently in each chapter, and a different object may share a description.',
      'The CONTENTS of one container count as this axis too: the same box lid rim, lining, drawer or envelope holding writing in one chapter and a seal in another, or a page one time and a fingerprint another — report it when the prose never says it was taken out or swapped.',
      'A change that the prose itself explains (it was cleaned, replaced, damaged on the page) is NOT a problem.',
      'Comparisons count too: when a line says something is `the same as the one in X` or `the same one as last time`, check that the referent actually exists earlier and really holds that kind of thing — report it when the referent never existed, or when what it holds is a different kind of thing entirely.',
      'For "impossible-cause", use the character cards when given: if a body mark is said to explain a trace, check that the mark is on the part that would actually be used.',
      'Every report must quote exact sentences: one from the main chapter, and one from the chapter it conflicts with. If you cannot quote both, do not report.',
      'Do not report ordinary continuity of an object that is consistent. When unsure, do not report.',
      // issue #182：物证本身没复活、没换容器，换的是「保管关系与所在场所」——谁持有、锁没锁、在哪个房间。
      // 现场：ch78/79 柯明远亲手把铜墨盒锁进自己的私柜、手压在锁上没挪开；ch82 同一把柜子「没锁死」、
      // 钥匙在管物人腰上，全章没有一句交接。而这一层原来没有任何判据。
      'For "custody", a change the prose itself narrates (someone hands the key over, the room is reassigned, a seal is broken on the page) is NOT a problem.',
      'Only report when the same seized object changes keeper, locked state, or room between chapters AND no handover is written.',
      'Output one JSON object: {"issues":[{"kind":"<one of the three kinds above>","chapterNumber":<n>,"quote":"<exact sentence>","conflictingChapterNumber":<n>,"conflictingQuote":"<exact sentence>","explanation":"<one sentence>"}]}',
      'Report at most 3 issues. If nothing qualifies, output {"issues":[]}. No commentary outside the JSON.',
    ].join('\n')
    : [
      '读这些章节。有些物件在情节里被当作**证据**用来锁定人或事实。',
      '只报下面这三类问题：',
      kinds,
      '按**意思**判断，不要按固定词表：同一件物证在不同章里可能换了叫法，不同物件也可能共用同一个描述。',
      // issue #186：现场是「同一个盒子的**内装物**」——ch78 盒盖内沿是**一行字**、夹层是**一页泡毁的纸**；
      // ch83 变成「内沿浮出半个红印」「夹层的指模」（「指模」全书仅此一次）。
      // 而这类容器（墨盒夹层、票夹里层、卷宗内衬）恰恰是本书反复用来放证据的地方。
      '**同一个容器的内装物**也算这一档：同一个盒盖内沿、夹层、柜格、内衬、封套里，一处写的是字、另一处变成印；一处是一页纸、另一处变成指模——只要正文没有交代它被取出或换过，就要报。',
      '正文**自己交代过**的变化（被擦掉、被换掉、在这一章被弄坏）不算问题。',
      // issue #176：现场是第 80 章一句台词「（油布包的包法）跟你爸票夹里那件，一样」——
      // 而全书 81 章里票夹（出现 20 章）装过的**全是平的纸件**（票根/存根册/纸条/收条），
      // 「油布包」全书只在 ch37（温珩从自己短褂夹层里抽出）与 ch80 出现。
      // 那个参照物**从未被建立**，而这句正是本章后段「油布包下落不明」的支点。
      '**被拿来互相比对的东西**也算这一档：一句话说「跟某处那件一样」「和上次那只同一件」时，',
      '要核那个参照物**在前文里是否真的存在、且里面装的/包的是不是这种东西**；',
      '参照物不存在、或它装的东西根本不同类（票夹里只有纸，却被拿来说明「包法」），就要报。',
      '判「成因不成立」时参考给出的角色卡：若某个身体标志被用来解释一处痕迹，要核那个标志是否长在**真正会用到**的部位上。',
      '每条都必须**逐字引用**两处：主问题那一章的一句，以及与之相悖的那一章的一句。引不出来就不要报。',
      '物证前后一致的正常延续不要报。不确定就不要报。',
      // issue #182：保管关系（谁持有 / 锁没锁 / 哪个房间）也是物证状态的一部分，原来没人比对过。
      '判「保管关系」这一档时：正文**自己写出来的**交接（有人交出钥匙、房间改派、当着人撬封）不算问题；',
      '只有当同一件被扣押的实物在相邻章之间换了保管人 / 锁具状态 / 所在房间，而正文**没有写任何交接**时才报。',
      '输出一个 JSON 对象：{"issues":[{"kind":"<上面三类之一>","chapterNumber":<章号>,"quote":"<原句>","conflictingChapterNumber":<章号>,"conflictingQuote":"<原句>","explanation":"<一句话>"}]}',
      '最多 3 条。没有就输出 {"issues":[]}。JSON 之外不要写任何解释。',
    ].join('\n')

  const cardText = cards.map(card => [
    `### ${card.name}`,
    en ? `Appearance: ${String(card.appearance ?? '').trim()}` : `外观：${String(card.appearance ?? '').trim()}`,
    String(card.notes ?? '').trim() ? (en ? `Notes: ${String(card.notes).trim()}` : `补充：${String(card.notes).trim()}`) : '',
  ].filter(Boolean).join('\n')).join('\n\n')
  const chapterText = chapters.map(chapter => [
    en ? `### Chapter ${chapter.chapterNumber}` : `### 第${chapter.chapterNumber}章`,
    String(chapter.content),
  ].join('\n')).join('\n\n')

  const user = en
    ? ['## Character cards', cardText, '## Chapters', chapterText].join('\n\n')
    : ['## 角色卡', cardText, '## 章节正文', chapterText].join('\n\n')
  return { system, user }
}

/**
 * 解析并校验模型输出（规则侧）。
 *
 * 五道收窄：坏 JSON → null；`kind` 不在两类里 → 丢弃；
 * 两个章号都必须在传入范围内；**两处引文都要能在各自那一章里逐字定位**（作者据此核对）；
 * 完全重复的那条去掉。
 */
export function parseEvidenceShapeReview(
  raw: string,
  request: Pick<EvidenceShapeRequest, 'chapters' | 'recentChapters'>,
): EvidenceShapeIssue[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFence(String(raw ?? '').trim()))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const list = (parsed as { issues?: unknown }).issues
  if (!Array.isArray(list)) return null
  const limit = request.recentChapters ?? EVIDENCE_SHAPE_RECENT_CHAPTERS
  const byNumber = new Map([...request.chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .slice(-limit)
    .map(chapter => [chapter.chapterNumber, String(chapter.content)]))
  const result: EvidenceShapeIssue[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const kind = String(record.kind ?? '')
    const chapterNumber = Number(record.chapterNumber)
    const conflictingChapterNumber = Number(record.conflictingChapterNumber)
    const quote = String(record.quote ?? '').trim()
    const conflictingQuote = String(record.conflictingQuote ?? '').trim()
    if (kind !== 'same-object-drift' && kind !== 'impossible-cause' && kind !== 'custody-drift') continue
    if (!byNumber.has(chapterNumber) || !byNumber.has(conflictingChapterNumber)) continue
    if (!quote || !byNumber.get(chapterNumber)!.includes(quote)) continue
    if (!conflictingQuote || !byNumber.get(conflictingChapterNumber)!.includes(conflictingQuote)) continue
    const key = `${kind}:${chapterNumber}:${quote}:${conflictingChapterNumber}:${conflictingQuote}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      chapterNumber,
      kind,
      quote,
      conflictingChapterNumber,
      conflictingQuote,
      explanation: String(record.explanation ?? '').trim(),
    })
  }
  return result
}

function stripFence(value: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(value)
  return fenced ? fenced[1]! : value
}

/**
 * 把模型判出的问题转成一致性发现。
 *
 * ⚠️ 每章合并一条（#164 的教训）：同一章可能有两处问题，key 只含章号会撞车，
 * ack 会静默掉没修的那条。合并后「一条提醒 = 这一章的物证问题」。
 */
export function evidenceShapeFindings(issues: readonly EvidenceShapeIssue[]): ConsistencyFinding[] {
  const grouped = new Map<number, EvidenceShapeIssue[]>()
  for (const issue of issues) {
    const list = grouped.get(issue.chapterNumber) ?? []
    list.push(issue)
    grouped.set(issue.chapterNumber, list)
  }
  return [...grouped.entries()].map(([chapterNumber, list]) => {
    const quotes = list.map(item => `「${item.quote}」`).join('、')
    const refs = [...new Set(list.map(item =>
      `第${item.conflictingChapterNumber}章「${item.conflictingQuote}」`))].join('；')
    const explanations = list.map(item => item.explanation).filter(Boolean).join('；')
    const hasDrift = list.some(item => item.kind === 'same-object-drift')
    const hasCause = list.some(item => item.kind === 'impossible-cause')
    /** issue #182：第三档 —— 物证本身没变，变的是「谁保管 / 锁没锁 / 在哪个房间」。 */
    const hasCustody = list.some(item => item.kind === 'custody-drift')
    const onlyCustody = hasCustody && !hasDrift && !hasCause
    return {
      // 章号是既成事实；合并后天然唯一（#164）。
      stableFactKey: `prose:evidence-shape:${chapterNumber}`,
      severity: 'warning' as const,
      sourceChapter: chapterNumber,
      evidence: `第${chapterNumber}章 ${quotes} 与前文 ${refs} 对不上${explanations ? `（${explanations}）` : ''}`,
      issue: {
        zhCN: `本章${onlyCustody ? '把一件被扣押的实物写成了换了保管人／锁具状态／所在房间，而正文没有任何交接' : hasCustody ? '把一件物证的保管关系写变了，同时它的形态或成因也立不住' : hasDrift && hasCause ? '把一件物证当作证据，但它的形态与成因都立不住' : hasCause ? '把一件物证的成因写成了物理上不成立的那种（那个部位／那个动作根本留不下这种痕迹）' : '把一件物证当作证据，而它的形态与前面那一章对不上'}：${quotes}；前文是${refs}。物证类错误最伤的地方在于它**安静地通过所有检查**——账本会把它原样收下，之后每一章都当已知事实注入，而读者只要回头翻一次就能看出这条路走不通。${explanations ? `（${explanations}）` : ''}`,
        enUS: `This chapter ${onlyCustody ? 'changes the keeper, locked state, or room of a seized object with no handover on the page' : hasCustody ? 'changes the custody of an object AND its shape or cause does not hold up' : hasCause && hasDrift ? 'uses an object as evidence, but both its physical cause and its shape do not hold up' : hasCause ? 'attributes a trace to a physical cause that could not have produced it' : 'uses an object as evidence, but its shape does not match the earlier chapter'}: ${quotes}; earlier it was ${refs}. Evidence errors are the quietest kind — the fact ledger records them verbatim and every later chapter inherits them, while a reader only has to page back once to see the chain cannot work.${explanations ? ` (${explanations})` : ''}`,
      },
      suggestion: {
        zhCN: `二选一，别两头都改：① **按物证重写推理**——把它真正能证明的那一点说清楚（是同一枚印、但缺口来源另说；或者这个部位本就按不出缺口，改用别的证据锁人）；② **按推理改物证**——把形态写成与前文一致的那一种，并补一处能解释它怎么变成这样的动作。改完要看**事实账本**：这条证据已经作为已知事实进了后面几章的起草输入，账本里那句转述也得跟着改。`,
        enUS: `Pick one, do not patch both ends: either rewrite the inference so it rests on what the object can actually prove, or change the object's description so it matches what was already written and add one on-page action that explains how it came to be that way. Then check the fact ledger — this evidence is already an established fact feeding later drafts, and its paraphrase there has to change too.`,
      },
    }
  })
}