/**
 * 角色卡上的**身体标志**与正文里的写法对账（issue #153）。
 *
 * 现场（常驻测试书 73 章）：角色卡说得最死的一条是叶九的
 *
 * > appearance：…**右小指缺半节**，随身带铜墨盒…
 * > notes：…**右手小指**的旧伤是沉船那夜留下的
 *
 * 正文第 5/11/45 章都照写右手，**第 51 章换成了左手**：
 *
 * > 笑停在脸上。叶九的**左手**从袖里出来，缺半节的小指往后一收。
 *
 * 而第 51 章的蓝图 `characters` 里就有叶九、`appearance` 确实进了提示词——
 * 系统告诉过模型「右小指」，输出仍是左手。之后第 66/67/73 章只写「缺半节的小指」，
 * 不再交代哪只手，这个错就被埋掉了。
 *
 * ## 为什么这是机制缺口
 *
 * 全仓唯一碰 `appearance` 的判据是 `findAppearanceGaps`——它只判「角色卡有没有外貌」。
 * 正文写了什么，它完全不知道：**「这一章有没有用上这张卡」不判，「用错了」更不判**。
 * 而「左/右」与「部位」都是**闭合词类**，这一点机器完全可以判。
 *
 * ## 判据（两条，都要求「卡上先声明过」）
 *
 * 1. **卡上声明**：从 `appearance + notes` 里，以**标记词**（缺/断/疤/伤/残/瘸/瞎/茧/墨垢）
 *    为锚点**向前回看**取最近的「侧」与「部位」——所以「右小指缺半节」给出 (右, 小指)、
 *    「右手虎口留着一道旧疤」给出 (右, 虎口)、「左肩有一道…旧疤」给出 (左, 肩)。
 *    ⚠️ 反过来（先取侧再找标记）会把「右手虎口」误拆成「右手」——部位要取**离标记最近**的那个。
 * 2. **正文对账**：同一句里，角色名出现、**相反侧**出现、且该部位带标记词（标记可在前/在后 8 字内）
 *    → 报一条「卡上说右、正文写左」。
 *
 * ⚠️ 刻意只报**左右相反**这一档：它是确定的（卡上有唯一答案、正文有唯一读法）。
 * 「这一章根本没写到卡上的特征」是另一条判据（用量统计），而且它的阈值需要更多语料标定；
 * 「同一枚指印的缺口朝哪个方向」牵涉到同一物件在多章的多次描述，属物件特征账本，不在本模块。
 */
import type { ConsistencyFinding } from './consistency-preflight'

/** 卡的「身体标志」判据只用标记词做锚点（封闭词类：身体上的异常/痕迹）。 */
const BODY_MARKERS = /缺|断|疤|伤|残|瘸|瞎|茧|墨垢/gu

/** 部位词（封闭集合，按**最长优先**匹配——「小指」要先于「手」被认出来）。 */
const BODY_PARTS = Object.freeze(['无名指', '小指', '拇指', '食指', '中指', '虎口', '手臂', '肩', '腿', '脚', '掌', '手'])

/** 侧别（封闭二元）与它的相反侧。 */
const SIDES = Object.freeze(['左', '右'])
const OPPOSITE: Readonly<Record<string, string>> = Object.freeze({ 左: '右', 右: '左' })

/** 卡上声明的身体标志：哪一侧、哪个部位、用什么标记词说出来的。 */
export interface DeclaredBodyMark {
  side: string
  part: string
  /** 卡上原话里的标记词（缺/疤/…），用于证据引用。 */
  marker: string
}

/**
 * 从角色卡文本里抽出**有侧别**的身体标志。
 *
 * ⚠️ 以标记词为锚点向前回看（而不是从侧面词向后找标记）：
 * 「右手虎口留着一道旧疤」里，如果先取「右手」再找标记，部位会停在「手」；
 * 只有从「疤」往回看，才会先遇到「虎口」——那才是真正被描述的部位。
 */
export function declaredBodyMarks(cardText: string): DeclaredBodyMark[] {
  const text = String(cardText ?? '')
  const marks: DeclaredBodyMark[] = []
  for (const match of text.matchAll(new RegExp(BODY_MARKERS.source, 'gu'))) {
    const at = match.index ?? 0
    const window = text.slice(Math.max(0, at - 14), at)
    let part = ''
    let partAt = -1
    for (const candidate of BODY_PARTS) {
      const found = window.lastIndexOf(candidate)
      if (found > partAt) { partAt = found; part = candidate }
    }
    let side = ''
    let sideAt = -1
    for (const candidate of SIDES) {
      const found = window.lastIndexOf(candidate)
      if (found > sideAt) { sideAt = found; side = candidate }
    }
    // 侧与部位都必须出现；且部位必须在侧之后（「右小指」而不是「小指远端右手」这种错位）。
    if (!side || !part || partAt < sideAt) continue
    if (marks.some(mark => mark.side === side && mark.part === part)) continue
    marks.push({ side, part, marker: match[0] })
  }
  return marks
}

export interface BodyMarkChapterInput {
  chapterNumber: number
  content: string
}

export interface BodyMarkCardInput {
  name: string
  /** `characters.appearance` */
  appearance: string
  /** `characters.notes`（同一角色的补充说明，常写着旧伤的来历）。 */
  notes?: string
}

/** 切句（与其它判据同一口径：句末标点与换行）。 */
function sentencesOf(content: string): string[] {
  return String(content ?? '').split(/(?<=[。！？])|\n+/u).map(sentence => sentence.trim()).filter(Boolean)
}

/**
 * 哪些部位**被更宽的部位包着**——所以「侧」可以挂在宽部位上。
 *
 * 实测（#153 现场第 51 章）：「叶九的**左手**从袖里出来，缺半节的小指往后一收。」
 * 这一句并没有写成「左小指」，侧别挂在**手**上；而「小指」是手的一部分。
 * 只认「侧+同一部位」会把这一条整条漏掉——那是本条的现场，漏了就等于没修。
 */
const PART_CONTAINERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  小指: ['手', '掌'],
  拇指: ['手', '掌'],
  食指: ['手', '掌'],
  中指: ['手', '掌'],
  无名指: ['手', '掌'],
  虎口: ['手', '掌'],
})

/** 这一句里是否把这个部位写成了「有标记的」（标记可在部位前后 8 字内）。 */
function marksPart(sentence: string, part: string): boolean {
  const after = new RegExp(`${part}[^。！？\\n]{0,8}(?:缺|断|疤|伤|残|瘸|瞎|茧)`, 'u')
  const before = new RegExp(`(?:缺|断|疤|伤|残|瘸|瞎|茧)[^。！？\\n]{0,8}${part}`, 'u')
  return after.test(sentence) || before.test(sentence)
}

/**
 * 「卡上说这一侧、正文写了相反侧」→ 一致性发现（issue #153）。
 *
 * 三条收窄（每条都由实测逼出，写在下面各自的注释里）。
 */
export function findBodyMarkSideConflicts(
  chapters: readonly BodyMarkChapterInput[],
  cards: readonly BodyMarkCardInput[],
): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = []
  const ordered = [...chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
  if (ordered.length === 0) return findings
  for (const card of cards) {
    const name = String(card.name ?? '').trim()
    if (!name) continue
    const marks = declaredBodyMarks(`${card.appearance ?? ''}；${card.notes ?? ''}`)
    if (marks.length === 0) continue
    for (const chapter of ordered) {
      for (const sentence of sentencesOf(chapter.content)) {
        // 收窄 ①：**同一句里必须出现角色名**。身体标志的归属靠这一条，
        // 而代词主语的句子（「她的左手…」）判不准指向谁——不猜（与 #149/#144 同一条）。
        if (!sentence.includes(name)) continue
        for (const mark of marks) {
          const wrongSide = OPPOSITE[mark.side]!
          // 收窄 ②：换掉的那一侧要与**同一部位**一起出现（「左手」「左肩」），
          // 不是句里随便有个「左」就算。手指/虎口允许侧别挂在「手」上（见 PART_CONTAINERS）。
          const containers = PART_CONTAINERS[mark.part] ?? []
          const wrongSideOnPart = sentence.includes(wrongSide + mark.part)
            || containers.some(container => sentence.includes(wrongSide + container))
          if (!wrongSideOnPart) continue
          // 收窄 ②b：若是靠「手」这一层判出来的，还必须确认这一句**没有**把部位本身
          // 标成卡上那一侧——「叶九左手接过册子，右小指缺半节」是合法句（左手在动作、
          // 右小指在被描述），不构成矛盾。
          if (!sentence.includes(wrongSide + mark.part) && sentence.includes(mark.side + mark.part)) continue
          // 收窄 ③：这一句还要把这个部位写成「有标记的」。否则「叶九左手接过册子」
          // 这种纯动作句会被报成「侧别写反」——那不是特征描述，没有左右可言。
          if (!marksPart(sentence, mark.part)) continue
          const excerpt = sentence.length > 60 ? `${sentence.slice(0, 60)}…` : sentence
          findings.push({
            // 章号是既成事实，不随写作推进而变（#86/#89/#98/#108）。
            stableFactKey: `character:body-mark-side:${chapter.chapterNumber}:${name}:${mark.part}`,
            severity: 'warning' as const,
            sourceChapter: chapter.chapterNumber,
            evidence: `第${chapter.chapterNumber}章：角色卡写「${mark.side}${mark.part}…${mark.marker}」，正文写的是「${excerpt}」`,
            issue: {
              zhCN: `身体标志换了一侧：「${name}」的角色卡写的是**${mark.side}${mark.part}**（${mark.marker}），而这一章正文写成了${OPPOSITE[mark.side]}${mark.part}——「${excerpt}」。读者靠这类痕迹记人（尤其中性描写多、外貌写得少的角色），左右一换就等于换了一个人；而这类错落在人物身体上，是最容易被抓住的一类不一致。`,
              enUS: `A body mark moved to the other side: “${name}”'s card says ${mark.side === '左' ? 'left' : 'right'} ${mark.part} (${mark.marker}), but this chapter writes the other side — “${excerpt}”. Readers remember characters by such marks, and a flipped side effectively swaps the person.`,
            },
            suggestion: {
              zhCN: `二选一：把正文这一处改回卡上的**${mark.side}${mark.part}**；或者若作者其实想让它在另一侧，就改角色卡（并在后面的章节统一）。改完顺带核一下前后章是否也只写了「缺半截的小指」这种不交代左右的说法——那种写法会让这个错被埋掉。`,
              enUS: `Either restore the card's ${mark.side === '左' ? 'left' : 'right'} ${mark.part} in this sentence, or, if the other side is intended, update the character card and keep later chapters consistent. Also check whether neighbouring chapters only say "the missing fingertip" without a side — that phrasing hides the error.`,
            },
          })
        }
      }
    }
  }
  return findings
}