/**
 * 章节标题的**句法同构**检测（issue #106）。
 *
 * 现象：那本 49 章的悬疑长篇，标题在后半程收敛成同一套句式——
 * **「【物件/纸张】＋方位词＋的＋【线索/痕迹】」**：
 *
 *   36 墨盒底下的旧票根   40 报告上的空白     44 铜墨盒旁的湿痕
 *   37 短褂夹层里的木片   41 口供上的指印     45 名单上的半页
 *   38 库门前的稽核令     42 客源单上的空船位 47 底板下的最后一册
 *   43 补底根之前         48 册子里的空号段
 *
 * 分块统计（同一口径）：ch1–10 2/10、ch11–20 2/10、ch21–30 2/10、**ch31–40 4/10、
 * ch41–50 8/9** —— 前 30 章只是偶发，第 34 章起几乎一章不落。读者打开目录看到的是
 * **一整列同构的标题**；导出文件的文件名与小标题都用它，标题层是目录的门面。
 *
 * 产品里标题层**只有一条检查：全书不得重名**（`duplicate_title`，字面相等）。
 * 句式同构不是重名，一句都报不出来。而正文层已经建了五层位置轴
 * （#71 章首 / #28#65#66 章末 / #81#87#92 登场句 / #94 段落起手 / #95 物件过手）——
 * **标题层是第六层，完全空白**。
 *
 * 判据刻意**结构性、不写题材词表**（本仓在 #30/#43/#70/#80/#93/#96/#99 反复吃过亏）：
 *   - 「方位词」是**封闭语法类**（汉语方位词是个封闭集合，任何题材通用），不是题材词表；
 *   - 只认两种句法骨架：`X〈方位〉的 Y` 与 `X〈方位〉` 收尾（多字方位才算，避免「湿票不入底」
 *     这类以单字方位收尾的普通动宾短语误入）；
 *   - 方位前一个字若是**虚词/序数**（「最/之/不/无/究竟…」）则不算——「最后的一页」
 *     「无底的船」不是方位结构；这份前缀表是**封闭的语法类**（否定词＋序数词），不是内容词表。
 *
 * 只报**连续窗口**里达标的那一段（与 #71/#66 同一口径）：读者感到的是「这几章连着都
 * 这么取名」，全书比例不是那个现象。
 */

/** 单字方位词（封闭语法类）。 */
const LOCATIVE_SINGLE = ['上', '下', '里', '中', '内', '外', '前', '后', '旁', '间', '底', '边', '侧', '顶'] as const
/**
 * 多字方位词（封闭语法类）。
 * 只有这些能作为**标题收尾**判定依据：单字收尾太容易撞上普通动宾短语
 * （「湿票不入底」「潜到水底」），实测会把干净样本 0202 报成假阳性。
 */
const LOCATIVE_MULTI = [
  '上面', '下面', '里面', '外面', '底下', '当中', '中间', '旁边', '背后', '面前',
  '之前', '之后', '里头', '外头', '上头', '下头',
] as const
/**
 * 方位词前一个字若是这些，就不是方位结构（「最后的…」「无底的…」「其后的…」）。
 * 只收**真正的虚词/否定词与序数词**——它们是封闭的语法类。
 *
 * ⚠️ **刻意不收量词**（个/块/片/根/层/条…）：第一版把它们也列进来，结果把 issue 自己
 * 清单里的两条判成了非方位结构——「短褂夹层**里**的木片」（前一字是「层」）、
 * 「补底**根之前**」（前一字是「根」）。量词在这里同时也是**普通名词**，收进来就是漏报。
 */
const NON_LOCATIVE_PREFIX = new Set(['最', '之', '其', '不', '无', '非', '未', '第'])

const HAN = /[\u3400-\u9fff]/u

/**
 * 标题的句法骨架。目前只分辨「方位结构」这一族——它是这条 issue 的实测形态，
 * 也是长篇里最容易自发收敛的一族（写「一件东西上的一个线索」写顺了手）。
 */
export type TitleShape = 'locative' | 'other'

/** 判断一个标题是否落在「方位结构」族里。 */
export function titleShapeOf(title: string): TitleShape {
  const text = String(title ?? '').trim()
  if (!text) return 'other'
  const locatives = [...LOCATIVE_MULTI, ...LOCATIVE_SINGLE]
  for (const locative of locatives) {
    const at = text.indexOf(locative)
    if (at <= 0) continue
    // 方位词前一个字必须是汉字，且不能是否定/序数类虚字（「最」「之」「不」「无」…）。
    const before = text.slice(at - 1, at)
    if (!HAN.test(before) || NON_LOCATIVE_PREFIX.has(before)) continue
    const after = text.slice(at + locative.length)
    // 骨架 A：`X〈方位〉的 Y`（方位后紧跟「的」再接内容）。
    if (after.startsWith('的') && after.length > 1) return 'locative'
    // 骨架 B：`X〈多字方位〉` 收尾（单字收尾不算——误报源，见文件头）。
    if (after === '' && (LOCATIVE_MULTI as readonly string[]).includes(locative)) return 'locative'
  }
  return 'other'
}

export interface TitleShapeChapter {
  chapterNumber: number
  title: string
}

export interface TitleShapeConvergence {
  /** 达标窗口里的章号（升序）。 */
  chapters: number[]
  /** 窗口长度（判据自己的常量，用于解释「最近 N 章里有 M 章」）。 */
  window: number
  /** 窗口内落在方位族的章号（升序）。 */
  hits: number[]
}

/** 判定窗口：连续 N 章。与 #71 的 6 章同值——两者都是「读者感到连着几章都这样」。 */
export const TITLE_CONVERGENCE_WINDOW = 6
/** 窗口内至少 M 章落在同一族即报。取 4/6≈67%：实测 sim2 尾段 8/9 远超、0202 尾段 0/6 远低。 */
export const TITLE_CONVERGENCE_MIN_HITS = 4

/**
 * 找最近窗口里「标题句法收敛」的那一段。
 *
 * 只看**最近的连续窗口**（与 #66/#71 同一做法）：第 20 章出现过两次同构标题不是问题，
 * 连着 6 章里 4 章以上才是读者打开目录会看到的形态。章号必须连续（中间夹着没导入的章
 * 不算一条链——同 #66/#71）。
 */
export function findTitleShapeConvergence(
  chapters: readonly TitleShapeChapter[],
  window = TITLE_CONVERGENCE_WINDOW,
  minHits = TITLE_CONVERGENCE_MIN_HITS,
): TitleShapeConvergence | null {
  const usable = chapters
    .filter(item => Number.isSafeInteger(item.chapterNumber) && String(item.title ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
  if (usable.length < window) return null
  const tail = usable.slice(-window)
  for (let index = 1; index < tail.length; index += 1) {
    if (tail[index]!.chapterNumber !== tail[index - 1]!.chapterNumber + 1) return null
  }
  const hits = tail.filter(item => titleShapeOf(item.title) === 'locative').map(item => item.chapterNumber)
  if (hits.length < minHits) return null
  return { chapters: tail.map(item => item.chapterNumber), window, hits }
}

/**
 * 标题句法收敛 → 一致性发现（issue #106）。
 *
 * `stableFactKey` **不带章号**（#86/#89/#98/#108 的教训）：锚在「是哪一族标题句法收敛」上，
 * 窗口滚动时 key 不变，作者点一次「我已知」即可永久静音；将来真的换掉句式、窗口不再达标
 * 时这条自然消失。
 */
export function findTitleShapeConvergenceFindings(input: {
  chapters: readonly TitleShapeChapter[]
}): Array<{
  stableFactKey: string
  severity: 'warning'
  sourceChapter: number
  evidence: string
  issue: { zhCN: string; enUS: string }
  suggestion: { zhCN: string; enUS: string }
}> {
  const convergence = findTitleShapeConvergence(input.chapters)
  if (!convergence) return []
  const range = `${convergence.chapters[0]}–${convergence.chapters[convergence.chapters.length - 1]}`
  const byChapter = new Map(input.chapters.map(item => [item.chapterNumber, item.title]))
  // 样例取**命中章**（不是窗口前几章）：反例不在样例里才不会再犯 #98 的错。
  const samples = convergence.hits.slice(0, 5)
    .map(chapter => `第${chapter}章「${byChapter.get(chapter) ?? ''}」`).join('、')
  return [{
    // key 锚在「哪一族句法收敛」上，不含章号。
    stableFactKey: 'chapter-title:locative-frame',
    severity: 'warning' as const,
    // 证据落在**已定稿的那几章**里（#79/#108）：填当前章会让界面把旧账标成本章的问题。
    sourceChapter: convergence.chapters[convergence.chapters.length - 1]!,
    evidence: `第 ${range} 章共 ${convergence.window} 章，其中 ${convergence.hits.length} 章标题是同一句法骨架（「物件＋方位＋的＋线索」）：${samples}`,
    issue: {
      zhCN: `最近 ${convergence.window} 章（第 ${range} 章）里有 **${convergence.hits.length} 章**的标题是同一个句法骨架：**「【物件】＋方位词＋的＋【线索】」**（如 ${samples}）。目录是长篇读者最常回看的一屏，也是导出文件的第一个门面——一整列同构标题在目录里比在正文里更显眼，不用读正文就看得出是同一个模板。它还会**掩盖章节之间的差别**：铺垫章、对峙章、代价章被标题统一成「一件东西上的一个线索」，读者在目录里几乎分不出哪章是什么。`,
      enUS: `${convergence.hits.length} of the last ${convergence.window} chapters (chapters ${range}) use the same title skeleton — “【object】＋locative＋的＋【clue】” (e.g. ${samples}). The table of contents is the screen long-form readers revisit most and the first thing an export shows; a column of identical title shapes stands out more there than in the prose, and it flattens the chapters: setup, confrontation and cost chapters all read as “a clue on an object” in the contents.`,
    },
    suggestion: {
      zhCN: `换一种取题方式，让标题本身带出这一章的**功能**：以人物或动作命名（谁做了什么）、以这一章的转折或代价命名、以一句台词或一个疑问命名、以时间或场景变化命名。**规则是不要与最近几章共用同一句法骨架**（不是禁词，是禁结构）——「X 上的 Y」「X 里的 Y」「X 上的 Y 之前」算同一骨架，换名词不算换结构。目录里连着出现三四个同形标题就会显出模板感。`,
      enUS: `Name titles differently so the title itself carries the chapter's function: name a character or an action, the twist or the cost, a line of dialogue or a question, or a shift in time or setting. The rule is not to share one syntactic skeleton with the last few chapters (ban the structure, not the words) — “the Y on the X”, “the Y in the X” and “before the X” count as the same skeleton, and swapping the nouns does not change that. Three or four of the same shape in a row betray the template.`,
    },
  }]
}
