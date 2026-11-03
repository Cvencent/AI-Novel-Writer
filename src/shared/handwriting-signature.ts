/**
 * 笔迹特征的自相矛盾（issue #97）。
 *
 * 现象：那本书的核心金手指是「溯读」——靠**笔迹特征认出是谁的手**，整条主线的证据链
 * 都架在「这笔字是谁写的」上。而「笔迹特征」这一层**没有任何账本**：
 *
 *   第 11 章「第一层墨浮起来——叶九的，**横折收得急**。」
 *   第 13 章「最上头是**叶九的手，稳、匀，起笔带锋**。」   ← 同一个叶九，换了相反的一套
 *   第 19 章「不是叶九的手。**叶九的笔稳、匀，起笔带锋**。」
 *
 * 第 19 章整段推理（「温珩的名字不是被改上去的」）就建立在「不是叶九的手」上，而它用来
 * 排除叶九的那套特征，正是第 11 章判给叶九的反面。父亲的手同样：「起笔轻，收笔回锋」（第 17 章
 * 纸条）与「起笔重，末横压住」（第 28–39 章签押六处）是同一个人身上的两套互斥特征。
 *
 * 为什么产品没拦住：`finalized-prose-audit.ts` 的体检里没有笔迹一项；`consistency-preflight.ts`
 * 的全部 finding 里没有；审稿的「人物一致性」维度管的是性格与口吻。**模型每次都在自由发挥
 * 「这笔字什么样」，产品侧一次也没有核对过上一章已经写过什么。**
 *
 * 判据（issue 建议 2）**可机器判、不需要模型**，且刻意**窄**（本仓在 #30/#43/#70/#80/#93/#96/#99
 * 反复吃过词表过拟合的亏）：
 *   ① **归属必须严**：只认「**X 的（笔|手|字|签押）**」「**——X 的，**」与亲属称谓
 *      「父亲/他爸 + 签押/纸条」。**刻意不做「同句含角色名」**——标定时那样会把
 *      「跳板落稳时天泛青」「手指抖了一下」这类普通叙述算成笔迹归属（假阳性成片）。
 *   ② **书写质量的形容词是封闭的功能类**（稳匀族／急慌族／重族／轻族），**不收单字**
 *      「稳」「抖」（会撞叙事语域）。
 *   ③ **只报「同一个归属人身上两族并存」**：稳匀 vs 急慌、重 vs 轻。这就是 issue 的两个头号样本。
 *
 * 标定（两本书真实语料）：sim2 命中**恰好 2 条**（叶九 急↔稳匀、父亲 轻↔重，与 issue §一/§三
 * 逐字对应）；0202（该书的笔迹写法本就一致）**0 条**。
 */

/** 稳定/匀称族（书写质量形容词，封闭的功能类）。 */
const STEADY_QUALITY = /(稳、匀|稳匀|笔压稳|起笔齐|收笔匀|收尾匀|没有一丝顿|起笔带锋)/u
/** 急促/慌乱族。 */
const HURRIED_QUALITY = /(收得急|收得很急|笔压[^，。；！？\n]{0,3}慌|发慌|笔压[^，。；！？\n]{0,3}抖|慌，抖|收得利落)/u
/** 重笔族。 */
const HEAVY_QUALITY = /(起笔重|笔压重|末横压住|压得重)/u
/** 轻笔族。 */
const LIGHT_QUALITY = /(起笔轻|力道发虚|笔画软|发虚)/u

/** 相互排斥的质量族（同一归属人身上同时出现即报）。 */
const CONFLICTING_PAIRS: ReadonlyArray<readonly [string, RegExp, string, RegExp]> = [
  ['稳匀', STEADY_QUALITY, '急促', HURRIED_QUALITY],
  ['重笔', HEAVY_QUALITY, '轻笔', LIGHT_QUALITY],
]

export interface HandwritingSignatureHit {
  /** 归属人（角色名，或亲属称谓如「父亲」）。 */
  owner: string
  /** 互斥的两族。 */
  families: [string, string]
  /** 该归属人在正文里的「归属句 → 质量族」记录（升序）。 */
  observations: Array<{ chapterNumber: number; family: string; excerpt: string }>
}

export interface HandwritingChapter {
  chapterNumber: number
  content: string
}

/**
 * 从一句里判定**笔迹归属人**（严口径，issue #97 标定）。
 *
 * 只认三种：`X 的（笔|手|字|签押）`、`——X 的，`、亲属称谓 `父亲/他爸` + `签押/纸条`。
 * **刻意不用「同句含角色名」**：那会把「周叙把票根压上去…」这种叙述也当归属。
 */
export function handwritingOwnerIn(sentence: string, castNames: readonly string[]): string | null {
  const text = String(sentence ?? '')
  for (const name of castNames) {
    const trimmed = String(name ?? '').trim()
    if (!trimmed) continue
    // ⚠️ **必须带「的」**：不要求它时，「全叔手按在第三个结上」会把「全叔」+「手」
    // 误配成笔迹归属（标定踩到的第一处假阳性来源）。
    if (new RegExp(`${escapeRegExp(trimmed)}的(?:笔|手|字|签押)`, 'u').test(text)) return trimmed
    if (new RegExp(`[—\\-]{1,2}${escapeRegExp(trimmed)}的[，,]`, 'u').test(text)) return trimmed
  }
  if (/(父亲|他爸)/u.test(text) && /(签押|纸条)/u.test(text)) return '父亲'
  return null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 一句里命中的质量族（可能多个）。 */
export function handwritingQualityFamilies(sentence: string): string[] {
  const families: string[] = []
  for (const [label, pattern] of [
    ['稳匀', STEADY_QUALITY], ['急促', HURRIED_QUALITY], ['重笔', HEAVY_QUALITY], ['轻笔', LIGHT_QUALITY],
  ] as const) {
    if (pattern.test(String(sentence ?? ''))) families.push(label)
  }
  return families
}

/**
 * 找出「同一个笔迹归属人身上出现两套互斥特征」（issue #97）。
 *
 * 只在**同一归属人同时出现互斥的两族**时报（稳匀↔急促、重笔↔轻笔）——这正是 issue 的
 * 两个头号样本，也是读者能直接察觉的那种矛盾（「同一个人怎么一会儿稳一会儿慌」）。
 */
export function findHandwritingConflicts(input: {
  chapters: readonly HandwritingChapter[]
  castNames: readonly string[]
}): HandwritingSignatureHit[] {
  const castNames = (input.castNames ?? []).map(name => String(name ?? '').trim()).filter(Boolean)
  if (castNames.length === 0) return []
  const byOwner = new Map<string, Array<{ chapterNumber: number; family: string; excerpt: string }>>()
  for (const chapter of input.chapters) {
    if (!Number.isSafeInteger(chapter.chapterNumber)) continue
    for (const sentence of String(chapter.content ?? '').split(/(?<=[。！？…”」])|\n+/u)) {
      const owner = handwritingOwnerIn(sentence, castNames)
      if (!owner) continue
      for (const family of handwritingQualityFamilies(sentence)) {
        const list = byOwner.get(owner) ?? []
        list.push({ chapterNumber: chapter.chapterNumber, family, excerpt: sentence.trim().slice(0, 80) })
        byOwner.set(owner, list)
      }
    }
  }
  const hits: HandwritingSignatureHit[] = []
  for (const [owner, observations] of byOwner) {
    const families = new Set(observations.map(item => item.family))
    for (const [left, , right] of CONFLICTING_PAIRS) {
      if (!families.has(left) || !families.has(right)) continue
      hits.push({
        owner,
        families: [left, right],
        observations: [...observations].sort((a, b) => a.chapterNumber - b.chapterNumber),
      })
      break
    }
  }
  return hits.sort((left, right) => left.owner.localeCompare(right.owner))
}

/**
 * 笔迹特征自相矛盾 → 一致性发现（issue #97）。
 *
 * `stableFactKey` 锚在**归属人**上、**不带章号**（#86/#89/#98/#108 的教训：
 * 带章号的 key 会随章滚动，作者点「我已知」永远关不掉）。
 * `sourceChapter` 指向**最早那条观察所在的章**。
 * 出路（issue 建议 1 的轻量版）：把该角色的笔迹特征**固定下来**，后续判读只引用不改写。
 */
export function findHandwritingConflictFindings(input: {
  chapters: readonly HandwritingChapter[]
  castNames: readonly string[]
}): Array<{
  stableFactKey: string
  severity: 'warning'
  sourceChapter: number
  evidence: string
  issue: { zhCN: string; enUS: string }
  suggestion: { zhCN: string; enUS: string }
}> {
  return findHandwritingConflicts(input).map(hit => {
    const [left, right] = hit.families
    const leftObs = hit.observations.filter(item => item.family === left)
    const rightObs = hit.observations.filter(item => item.family === right)
    const leftChapters = [...new Set(leftObs.map(item => item.chapterNumber))].join('、')
    const rightChapters = [...new Set(rightObs.map(item => item.chapterNumber))].join('、')
    return {
      // key 锚在归属人上，不含章号。
      stableFactKey: `handwriting:conflict:${hit.owner}`,
      severity: 'warning' as const,
      sourceChapter: hit.observations[0]!.chapterNumber,
      evidence: `「${hit.owner}」的笔迹被写成两套互斥特征：「${left}」在第 ${leftChapters} 章、「${right}」在第 ${rightChapters} 章；${leftObs[0]!.excerpt} / ${rightObs[0]!.excerpt}`,
      issue: {
        zhCN: `同一个书写者「${hit.owner}」的笔迹在正文里有两套**互斥**的特征：第 ${leftChapters} 章说「${left}」，第 ${rightChapters} 章说「${right}」。如果这本书的核心能力是「靠笔迹认出是谁的手」，那么读者拿不到一张可对照的特征表——每次判读都只能信叙述，不能自己验证；而当某章用其中一套去**排除**这个人时（「不是他的笔」），读者回看会发现两章对不上，整条推理跟着塌。`,
        enUS: `The same writer “${hit.owner}” is given two **mutually exclusive** handwriting traits: “${left}” in chapters ${leftChapters}, “${right}” in chapters ${rightChapters}. If the book's core ability is recognising who wrote something by their hand, readers cannot build a reference table — every identification can only be taken on trust; and when a chapter uses one of those traits to rule the person out (“not his hand”), going back shows the two chapters contradict each other and the deduction collapses.`,
      },
      suggestion: {
        zhCN: `把「${hit.owner}」的笔迹特征**固定下来**：在角色卡里写下他这两三类可核对的特征（起笔／横折／收笔／笔压），此后每次判读只**引用**、不再重新描述（issue 建议 1）。改法二选一：①选定其中一套，把另一处改掉（若后一套才是后来的设定，就把前一处按新特征重写）；②如果确实要写「笔迹变了」（手受了伤、被人仿写、临时被指使），那就在正文里写明**为什么会变**——让变化成为情节，而不是让特征随机漂移。`,
        enUS: `Fix “${hit.owner}”'s handwriting once: record those two or three checkable traits (entry stroke, turn, exit stroke, pressure) on the character card, and from then on only **cite** them instead of re-describing them. To repair: (1) pick one set and rewrite the other occurrence; or (2) if the handwriting really did change (an injured hand, a forgery, being told to write it), say on the page **why it changed** — make the change plot rather than letting the traits drift at random.`,
      },
    }
  })
}
