/**
 * 道具被收进容器、容器离开当事人、之后它又回到身上（issue #113）。
 *
 * 现象：主线唯一物证「那片纸角」在第 14 章被明确**收进别的容器**（册子封底衬页）、
 * 该容器**当场被抽走**、当事人按住内衬**确认空了**——第 17/18 章它又在内衬里，
 * 中间没有任何取回动作。这是全书最要紧的一件东西，其位置却前后不一致。
 *
 * 为什么现有判据碰不到它（`findAnnihilatedPropRevival` 在本书上报的几条都是假阳性——
 * `里那`／`账房`／`一张`／`那张` 这类跨词碎片与非道具名词，真的这条 0 命中；
 * 碎片那一半已在 issue #122 修掉，但这一形态仍然碰不到）：
 *   ① 抽取按「销毁动词附近」取名词，取到跨词碎片与场所名——**取错了对象**；
 *   ② 判据只认「终结动词/宣告句把物**写没了**」这一种消失方向，而第 14 章走的是**反向**：
 *      收进别的容器 + 容器被拿走 + 当事人确认身上空了。
 *
 * 判据（**结构性，无词表**；只依赖封闭的语法/功能类）：
 *   1. **句法取件**（issue 建议 1）：物名从「把/将 + 受事」里取——
 *      受事在**收纳动词**（塞进/揣进/收进/夹进/放进/装进/掖进/折进）之前；
 *      取到后按「遇到下一个动词字/标点就停」截断（「把**纸角**折回原样，…塞进去」→「纸角」）。
 *      再从候选里剔掉在册人名与目的地词本身（#76/#80 的教训：不按词表硬筛，按句法位置）。
 *   2. **目的地按封闭族归类**（复用 #95 的口径）：身上（内衬／怀里／袖里…）、容器（册子／公文包／匣子…）、
 *      场所（牌架／抽屉／槽缝…）。
 *   3. **三段合取**（issue 建议 2 的形态）：
 *      ① 物被收进**容器类**目的地（不是身上——收进身上本来就没离开当事人）；
 *      ② 该容器（类）在**本章或紧邻一章内离开当事人**（被抽走／收走／归档／封存／上交…）；
 *      ③ 之后该物**又在身上（body 族）出现**。
 *      三者同时成立 = 它从容器里回到了身上，而中间没有取回动作 → 报。
 *
 * ⚠️ 边界（本仓 #30/#43/#70/#80/#93 的教训，全部由真实语料标定）：
 *   - **排除不定指**：「一张纸」「半张条子」每次都是**新的一个**，不是同一件物 —— 跳过数词+量词开头；
 *   - **同一件物必须逐字相同**：不做近义词合并（实测「存根／存根角／票根」合并会误报）；
 *   - 目的地必须**与动词相邻**（±6 字）：只是同句共现的位置词不算（否则「他把箱子搁在舱口，抽出竹尺」
 *     会误判成「从箱子取出」）。
 *
 * 标定（四本真实语料）：0202 命中 1 条（正是 issue 那件「纸角」）；sim2 / sim2b / sim3 **0 条**。
 */

/** 收纳动词（**封闭功能类**：#95 的同一族）。 */
export const PROP_STOW_ACTIONS = Object.freeze(['塞进', '揣进', '收进', '夹进', '放进', '装进', '掖进', '折进'] as const)

/**
 * 「容器离开当事人」的宣告（**封闭功能类**）：被抽走／收走／归档／封存／上交／交回…
 * 这些动词都表示「容器不再由当事人保管」。
 */
export const CONTAINER_DEPARTURE = Object.freeze([
  '被抽走', '抽走', '收走', '被收走', '归档', '封存', '上交', '交回', '被拿走', '拿走', '离手', '查封', '落锁',
] as const)

/** 目的地族（**封闭功能类**，复用 #95 的三族并补齐实测出现的位置词）。 */
export type PropLocationClass = 'body' | 'container' | 'place'

export const PROP_LOCATION_PHRASES: Record<PropLocationClass, readonly string[]> = Object.freeze({
  /** 身上：内衬／内襟／怀里／袖里／贴身。 */
  body: Object.freeze(['内衬', '内襟', '怀里', '袖里', '袖中', '贴身', '衣内', '胸口']),
  /** 容器：册子／公文包／匣子／箱袋／夹层／衬页。 */
  container: Object.freeze(['册子', '公文包', '公文夹', '外袋', '内袋', '内层', '匣子', '箱子', '口袋', '裤袋', '夹层', '皮包', '衬页', '封皮']),
  /** 场所：牌架／抽屉／槽缝／车垛。 */
  place: Object.freeze(['牌架', '抽屉', '柜子', '搁板', '槽缝', '缝里', '车垛', '货堆', '灯罩', '风灯罩']),
})

export const PROP_LOCATION_LABELS: Record<PropLocationClass, { zhCN: string, enUS: string }> = Object.freeze({
  body: { zhCN: '身上（内衬／怀里／袖里）', enUS: 'on the body (inner lining, breast, sleeve)' },
  container: { zhCN: '容器（册子／公文包／匣子）', enUS: 'in a container (booklet, briefcase, box)' },
  place: { zhCN: '场所（牌架／抽屉／槽缝）', enUS: 'in a place (rack, drawer, slot)' },
})

/** 目的地必须与动词相邻的字数（只是同句共现不算）。 */
export const PROP_DESTINATION_SPAN = 6
/** 「容器离开」与「又回到身上」的搜索窗口（章）。 */
export const PROP_RETURN_WINDOW = 12

/**
 * 受事截断用的**动词字类**（封闭的功能类）：句子里遇到下一个动词性字就停，
 * 「把纸角折回原样，…塞进去」于是截出「纸角」而不是「纸角折回原」。
 */
const PROP_VERB_HEAD_CHARS = '折塞收装掖放夹揣摸抽拿取翻探进回撕合抹掀握捏压搁递夺抢缴'

/** 中文句读切句（与其它判据同一口径）。 */
function sentencesOf(content: string): string[] {
  return String(content ?? '')
    .split(/[。！？\n]/u)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length >= 4)
}

/** 与位置词相邻（±span）命中的目的地；不相邻则返回 null。 */
function destinationNear(sentence: string, at: number): { kind: PropLocationClass, phrase: string } | null {
  let bestKind: PropLocationClass | null = null
  let bestPhrase = ''
  let bestDistance = Number.POSITIVE_INFINITY
  for (const kind of Object.keys(PROP_LOCATION_PHRASES) as PropLocationClass[]) {
    for (const phrase of PROP_LOCATION_PHRASES[kind]) {
      const index = sentence.indexOf(phrase)
      if (index < 0) continue
      const distance = Math.abs(index - at)
      if (distance <= PROP_DESTINATION_SPAN && distance < bestDistance) {
        bestKind = kind
        bestPhrase = phrase
        bestDistance = distance
      }
    }
  }
  return bestKind ? { kind: bestKind, phrase: bestPhrase } : null
}

/** 「把/将」后的受事核心（遇到下一个动词字或标点就停；剔除不定指与量词）。 */
function possessorObject(fragment: string): string {
  const text = String(fragment ?? '')
  // 不定指（数词 + 量词开头）= 每次都是新的一个，不是同一件物。
  if (/^[一二两三四五几半][张片枚个块条根支]/u.test(text)) return ''
  const pattern = new RegExp(`^([\\u4e00-\\u9fff]{2,5}?)(?=[${PROP_VERB_HEAD_CHARS}]|[，,。、；：！？]|$)`, 'u')
  const matched = pattern.exec(text)
  const raw = matched ? matched[1]! : text.slice(0, 5)
  return raw.replace(/^[那片张枚个块条根支把将的了]/u, '').trim()
}

export interface PropContainerDepartureHit {
  /** 物名（受词核心，逐字）。 */
  prop: string
  /** 被收进容器的那一章。 */
  stowedAt: number
  /** 容器原词。 */
  containerPhrase: string
  /** 容器离开当事人的那一章。 */
  departedAt: number
  /** 之后该物又出现在身上的章（升序）。 */
  returnsAt: number[]
  /** 收进容器那一句原文。 */
  stowExcerpt: string
  /** 容器离开那一句原文。 */
  departureExcerpt: string
}

/**
 * 找出「收进容器 → 容器离开 → 又回到身上」且中间无取回动作的道具（issue #113）。
 */
export function findPropContainerDepartures(
  chapters: readonly { chapterNumber: number; content: string }[],
  castNames: readonly string[] = [],
): PropContainerDepartureHit[] {
  const cast = castNames.map(name => String(name ?? '').trim()).filter(Boolean)
  const usable = chapters
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
  const allLocationPhrases = Object.values(PROP_LOCATION_PHRASES).flat() as readonly string[]
  const hits: PropContainerDepartureHit[] = []
  for (const chapter of usable) {
    for (const sentence of sentencesOf(chapter.content)) {
      const stow = PROP_STOW_ACTIONS.find(action => sentence.includes(action))
      if (!stow) continue
      const at = sentence.indexOf(stow)
      const destination = destinationNear(sentence, at)
      if (!destination || destination.kind !== 'container') continue
      const possessor = Math.max(sentence.lastIndexOf('把', at), sentence.lastIndexOf('将', at))
      if (possessor < 0 || at - possessor > 24) continue
      const prop = possessorObject(sentence.slice(possessor + 1))
      if (prop.length < 2) continue
      if (allLocationPhrases.includes(prop)) continue
      if (cast.some(name => prop.includes(name) || name.includes(prop))) continue
      // ② 该容器（类）在本章或紧邻一章内离开当事人。
      const departure = usable.find(candidate => candidate.chapterNumber >= chapter.chapterNumber
        && candidate.chapterNumber <= chapter.chapterNumber + 1
        && sentencesOf(candidate.content).find(text => CONTAINER_DEPARTURE.some(marker => text.includes(marker))
          && (Object.keys(PROP_LOCATION_PHRASES) as PropLocationClass[]).some(kind => kind === 'container'
            && PROP_LOCATION_PHRASES[kind].some(phrase => text.includes(phrase)))))
      if (!departure) continue
      // ③ 之后该物又出现在身上（body 族）。
      const returnsAt = usable
        .filter(candidate => candidate.chapterNumber > chapter.chapterNumber + 1
          && candidate.chapterNumber - chapter.chapterNumber <= PROP_RETURN_WINDOW
          && sentencesOf(candidate.content).some(text => text.includes(prop)
            && PROP_LOCATION_PHRASES.body.some(phrase => text.includes(phrase))))
        .map(candidate => candidate.chapterNumber)
      if (returnsAt.length === 0) continue
      const departureSentence = sentencesOf(departure.content)
        .find(text => CONTAINER_DEPARTURE.some(marker => text.includes(marker))) ?? ''
      hits.push({
        prop, stowedAt: chapter.chapterNumber, containerPhrase: destination.phrase,
        departedAt: departure.chapterNumber, returnsAt,
        stowExcerpt: sentence.slice(0, 60), departureExcerpt: departureSentence.slice(0, 60),
      })
    }
  }
  return hits.sort((left, right) => left.stowedAt - right.stowedAt || left.prop.localeCompare(right.prop))
}

/** 道具「收进容器→容器离开→又回到身上」→ 一致性发现（issue #113）。 */
export function findPropContainerDepartureFindings(
  chapters: ReadonlyArray<{ chapterNumber: number; content: string }>,
  castNames: readonly string[] = [],
): Array<{
  stableFactKey: string
  severity: 'warning'
  sourceChapter: number
  evidence: string
  issue: { zhCN: string; enUS: string }
  suggestion: { zhCN: string; enUS: string }
}> {
  return findPropContainerDepartures(chapters, castNames).map(hit => ({
    // key 锚在「哪件物」上、**不带章号**（#86/#89/#98/#108/#111 的教训：
    // 带章号的 key 会随章滚动，作者点「我已知」永远关不掉）。
    stableFactKey: `prop:container-departure:${hit.prop}`,
    severity: 'warning' as const,
    // 证据落在**把它收进容器的那一章**（#79 的口径：不写成正在写的这一章）。
    sourceChapter: hit.stowedAt,
    evidence: `「${hit.prop}」第 ${hit.stowedAt} 章被收进「${hit.containerPhrase}」（${hit.stowExcerpt}），`
      + `第 ${hit.departedAt} 章该容器已离开当事人（${hit.departureExcerpt}），`
      + `而第 ${hit.returnsAt.join('、')} 章它又在身上出现，中间没有取回动作`,
    issue: {
      zhCN: `「${hit.prop}」的位置对不上：第 ${hit.stowedAt} 章它被**收进了「${hit.containerPhrase}」**，第 ${hit.departedAt} 章那个容器已经离开当事人（${hit.departureExcerpt}），可第 ${hit.returnsAt.join('、')} 章它又**回到了身上**——中间没有任何「谁把它拿回来」的动作。读者会以为自己漏读了一段，回头翻又找不到，然后对这条线索失去信任；如果它是本书主线唯一的物证，整条推理也跟着塌。`,
      enUS: `“${hit.prop}” is in the wrong place: chapter ${hit.stowedAt} **puts it into the ${hit.containerPhrase}**, and by chapter ${hit.departedAt} that container has left the character (${hit.departureExcerpt}); yet chapter(s) ${hit.returnsAt.join(', ')} have it **back on the body** — with no on-page action bringing it back. Readers will assume they missed a passage, go back, fail to find it, and stop trusting the thread; if this is the story's only physical evidence, the whole deduction collapses with it.`,
    },
    suggestion: {
      zhCN: `二选一：①**补上取回动作**（在第 ${hit.stowedAt} 与第 ${hit.returnsAt[0]} 章之间写出「谁从那个容器里把它拿回来」的一步，哪怕一句）；②**改掉后一处的位置**，让它与第 ${hit.stowedAt} 章记下的状态一致（仍然在容器里、或在别处）。若你本来就想写「容器离开但东西还在手里」，那要在**收进容器那一章**就把东西取回来——别让收进与回到身上之间空着。两种情况都要落到正文。`,
      enUS: `Pick one: (1) **show the retrieval** — between chapter ${hit.stowedAt} and chapter ${hit.returnsAt[0]}, write the step that takes it back out of that container, even in one clause; (2) **change the later location** so it matches where chapter ${hit.stowedAt} left it (still in the container, or elsewhere). If you meant it to stay in hand while the container left, then retrieve it in the same chapter that stows it — do not leave a gap between stowing and having it back. Either way it must land in the prose.`,
    },
  }))
}