import { splitProseSentences } from './finalized-continuity-facts'

/**
 * 同一件物证被终结两次（issue #73）。
 *
 * 实测样本：主线唯一的实物证据是绞盘下那圈绳上的三个结。
 *
 * - 第 27 章蓝图与正文都写「三个结被**一一解开**，绳头往滚筒底下一塞」——结没了。
 * - 第 29 章又写「露出底下压死的**三个结**。剪子伸进去，一下，一下，一下」——再剪一遍。
 *
 * 两次都被写成同一件事的后果（「全叔二十年装糊涂的护身壳破了」），等于同一件物证
 * 被终结了两次。这是蓝图层的 `【同章道具不得自相矛盾】`（#19）管不到的地方——
 * 那条只管**同一章内**，跨章的「已经没了的东西又被取出」从来没人看。
 *
 * 判据是**结构性的**，不枚举「解开 / 剪断 / 烧掉」这些词：
 * 对同一个名词，问「它是否在不同的章里各自被一个终结动作处理过」。
 * 终结动作本身用一小撮高通用度的动词（解/剪/烧/扔/交/埋/撕/砸/毁/丢/沉），
 * 但**判据的主体是同一个名词**——换一件物证、换一个动作，判据照样成立。
 */

/**
 * 高通用度的「终结」动作：处理掉、毁掉、交出去。
 *
 * `塞进` **不在表里**（issue #77）：中文里「把 X 塞进 Y」绝大多数是**收纳**——
 * 实测样本第 25 章「塞进风灯罩」、第 26 章紧接着就「从灯罩里抽出来」，
 * 中间没有任何东西「没了」。它被判成终结时，一条收纳句会同时产出
 * 「签收联」与「塞进风灯罩」两条误报（报告的正对照：删掉这一个词，3 条变 1 条）。
 */
const TERMINAL_ACTIONS = Object.freeze([
  '解开', '解下', '剪断', '剪掉', '剪开', '烧掉', '烧毁', '扔掉', '丢下', '丢掉',
  '埋掉', '埋下', '撕掉', '撕碎', '砸碎', '砸掉', '毁掉', '毁去', '沉掉', '沉了',
  '交还', '交回', '交出', '抄走', '收走', '夺走', '拿走', '压死',
  // 不可逆的物理毁损（issue #78）：实测样本用这一族写过两次同一种损失
  // （第 21 章票根泡酥、第 30 章原页化成浆），旧表里一个都没有。
  '泡酥', '泡烂', '泡碎', '酥开', '酥掉', '碎成', '碎掉', '化成浆', '化成水',
] as const)

/**
 * 「不可逆消亡」的宣告（issue #78）：比单个动作更强的信号。
 * 实测样本第 21 章单独写了一行「没了。」来钉死这件事。
 */
const ANNIHILATION_DECLARATIONS = Object.freeze(['没了', '再也没有', '不复存在'] as const)

/** 「可取用」的形态（issue #78）：没有获得动作就直接使用。 */
const USABLE_APPEARANCE = Object.freeze([
  '摸出', '取出', '拿出', '掏出', '抽出', '压上', '递到', '蘸水压',
] as const)

/** 「重新获得」的动作：出现它说明这件东西是**重新拿到**的，不是自行复活。 */
const REACQUISITION_ACTIONS = Object.freeze([
  '新领', '重领', '换了一张', '讨了一张', '借来', '买来', '剩下的一角', '另取', '翻出', '找回来',
] as const)

const QUESTIONABLE_QUESTIONS = /[?？]/u

/**
 * 物证名词：连续 CJK 串里长度 3–5 的窗口。
 *
 * 取 3–5 而不是 2–4：2 字窗口（「绳圈」「滚筒」）会把大量日常名词卷进来，
 * 而本样本的锚点「三个结」是 3 字。上限 5 覆盖「靛蓝短褂」这类复合名词。
 */
const PROP_WINDOW = [3, 4, 5] as const

/**
 * 复活检测用的窗口（issue #78）：允许 **2 字**。
 *
 * 实测样本的物证叫「票根」——正好两个字，3 字起的窗口永远抽不到它
 * （「票根表面起毛」会切成「票根表 / 根表面 / 表面起…」）。而 #73 那条的物证
 * 「三个结」是 3 字，所以那条没暴露这个问题。
 *
 * 2 字窗口的噪声靠**两个条件同时成立**压住：该词必须出现在「可用形态」句里
 * （摸出／取出／压上…），又出现在宣告消亡的上下文里——日常词很难两头都占。
 */
const PROP_WINDOW_WITH_SHORT = [2, 3, 4, 5] as const

export interface ChapterProse {
  chapterNumber: number
  content: string
}

export interface PropTermination {
  prop: string
  /** 终结它的章号（升序）。 */
  chapters: number[]
  /** 每章里那句原文（用于证据展示）。 */
  excerpts: string[]
}

/**
 * 锚点必须是**名词性片段**：不得包含触发它的那个动作词（issue #77）。
 *
 * 抽取器在动作词前后的窗口上滑窗，必然产出「塞进风灯罩」这类**动宾短语**——
 * 作者读到「同一件物证『塞进风灯罩』」完全不知道指哪件东西。直接排除「含动作词」
 * 的候选，比枚举「动词开头」更稳（动作词落在窗口中间、末尾都能挡掉）。
 */
function isNounLikeAnchor(token: string, action: string): boolean {
  if (token.includes(action)) return false
  // 以「的/了/着/把/将/在/和/与」开头或收尾的片段不是独立名词。
  return !/^[的了着把将在和与及]|(?:的|了|着)$/u.test(token)
}

/** 单纯的名词性片段（不看动作）：#78 的抽取用同一口径。 */
function isPlainNounAnchor(token: string): boolean {
  return !/^[的了着把将在和与及]|(?:的|了|着)$/u.test(token)
}

/** 某句里出现的终结动作。 */
function terminalActionsIn(sentence: string): string[] {
  return TERMINAL_ACTIONS.filter(action => sentence.includes(action))
}

/** 一个名词在某章是否被终结动作处理过。 */
function terminatorsIn(content: string): Array<{ action: string; sentence: string }> {
  const found: Array<{ action: string; sentence: string }> = []
  for (const sentence of splitProseSentences(content)) {
    for (const action of terminalActionsIn(sentence)) found.push({ action, sentence })
  }
  return found
}

/** 某章里出现过、且同句或紧邻句带终结动作的名词片段。 */
function terminatedPropsInChapter(content: string): Map<string, string> {
  const props = new Map<string, string>()
  for (const { action, sentence } of terminatorsIn(content)) {
    const index = sentence.indexOf(action)
    // 只看动作**前面**的那一小段：中文里「解开三个结」的宾语在动词后，
    // 但「三个结被解开」在动词前。两种都要覆盖，所以整句都在窗口内。
    const span = sentence.slice(Math.max(0, index - 12), index + action.length + 6)
    for (const run of span.matchAll(/[\u4e00-\u9fa5]+/gu)) {
      for (const length of PROP_WINDOW) {
        for (let start = 0; start + length <= run[0].length; start += 1) {
          const token = run[0].slice(start, start + length)
          if (!isNounLikeAnchor(token, action)) continue
          if (!props.has(token)) props.set(token, sentence)
        }
      }
    }
  }
  return props
}

/**
 * 合并「同一件事的不同切法」（issue #77）。
 *
 * 旧判据靠「一个名字包含另一个名字」（「三个结」⊂「下三个结」）。它在
 * 「签收联 / 塞进风灯罩」这种**同句异名**的情况下完全失效——两者互不包含，
 * 章号列表又完全相同，于是同一句报两遍。
 *
 * 现在按「**章号集合 + 来源句**」判定同一件事：同句产出的候选必然指向
 * 同一处上下文，无论名字是否互相包含。同一组里保留最长（信息最多）的那个。
 */
function mergeSameEvidence<T extends { prop: string; chapters: number[]; excerpts: string[] }>(
  candidates: readonly T[],
): T[] {
  const sorted = [...candidates].sort((left, right) => (
    right.prop.length - left.prop.length || left.prop.localeCompare(right.prop)
  ))
  const kept: T[] = []
  for (const candidate of sorted) {
    const duplicate = kept.some(existing => (
      existing.chapters.join(',') === candidate.chapters.join(',')
      && existing.excerpts[0] === candidate.excerpts[0]
    ))
    if (!duplicate) kept.push(candidate)
  }
  return kept
}

/**
 * 找出「同一件物证在不同章里各自被终结过一次」的情况。
 *
 * 只报**跨章**（同一章内的矛盾由蓝图层 #19 与同章检测负责），
 * 且章号要相邻或接近（间隔 > 8 章时，读者早已不记得那件东西，「重新出现」更像
 * 是新引入而不是自相矛盾）。
 *
 * 反噪措施：
 * - 要求这个名词在**至少两章**里都带终结动作；
 * - 名词里不得含疑问句（「三个结是什么」不是终结）；
 * - 上限 4 条，按覆盖章数排序。
 */
export const PROP_TERMINATION_MAX_GAP = 8

export function findRepeatPropTermination(
  chapters: readonly ChapterProse[],
  options: { maxGap?: number } = {},
): PropTermination[] {
  const maxGap = options.maxGap ?? PROP_TERMINATION_MAX_GAP
  const byProp = new Map<string, { chapters: number[]; excerpts: string[] }>()
  const ordered = [...chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
  for (const chapter of ordered) {
    for (const [prop, sentence] of terminatedPropsInChapter(String(chapter.content))) {
      if (QUESTIONABLE_QUESTIONS.test(sentence)) continue
      const entry = byProp.get(prop) ?? { chapters: [], excerpts: [] }
      if (!entry.chapters.includes(chapter.chapterNumber)) {
        entry.chapters.push(chapter.chapterNumber)
        entry.excerpts.push(sentence.trim())
      }
      byProp.set(prop, entry)
    }
  }
  const candidates: PropTermination[] = []
  for (const [prop, entry] of byProp) {
    if (entry.chapters.length < 2) continue
    const chapters = [...entry.chapters].sort((left, right) => left - right)
    // 章号要相邻或接近：间隔太大时读者记不住，重新出现更像新引入。
    const contiguous = chapters.every((chapter, index) => (
      index === 0 || chapter - chapters[index - 1]! <= maxGap
    ))
    if (!contiguous) continue
    candidates.push({ prop, chapters, excerpts: entry.excerpts })
  }
  return mergeSameEvidence(candidates)
    .sort((left, right) => right.chapters.length - left.chapters.length
      || right.prop.length - left.prop.length || left.prop.localeCompare(right.prop))
    .slice(0, 4)
}
export interface PropRevival {
  prop: string
  /** 宣告它消亡的章号。 */
  annihilatedAt: number
  /** 它又以「可取用」形态出现的章号（升序）。 */
  appearedAt: number[]
  /** 消亡那句原文。 */
  annihilationExcerpt: string
  /** 再现那句原文。 */
  appearanceExcerpt: string
}

/**
 * 某章里被宣告消亡的物证名（终结动作，或强宣告句）。
 *
 * 宣告句常常是**独立短句**，而物证名在它前一句：
 *
 *   第三下，纸面从中间酥开，碎成几片，沾在他掌心的茧上，一捻就烂。
 *   没了。
 *
 * 只看宣告句本身会得到零个物证名（「没了」只有两个字）。所以独立宣告句要
 * **回看前一句**——这正是报告建议 2 说的「出现『没了。』这类独立短句」也要算数。
 */
function annihilatedPropsInChapter(content: string): Map<string, string> {
  const props = new Map<string, string>()
  const sentences = splitProseSentences(String(content ?? ''))
  for (let index = 0; index < sentences.length; index += 1) {
    const sentence = sentences[index]!
    const actions = terminalActionsIn(sentence)
    const declared = ANNIHILATION_DECLARATIONS.some(marker => sentence.includes(marker))
    if (actions.length === 0 && !declared) continue
    // 独立宣告句（自身不含物证名）时把前一句一并纳入取样范围，证据仍落在前一句上。
    // 但物证名可能更早：实测样本第 21 章「票根表面起毛……」与
    // 「第三下，纸面从中间酥开，碎成几片……」是**两句**，而宣告动作在后一句——
    // 所以取样范围要覆盖到「最近一句提到物证的句子」，而不只是紧邻的前一句。
    const scope = actions.length === 0 && index > 0
      ? `${sentences.slice(Math.max(0, index - 2), index).join('')}${sentence}`
      : sentence
    const evidence = (actions.length === 0 ? sentences[index - 1] ?? sentence : sentence).trim()
    for (const run of scope.matchAll(/[\u4e00-\u9fa5]+/gu)) {
      for (const length of PROP_WINDOW_WITH_SHORT) {
        for (let start = 0; start + length <= run[0].length; start += 1) {
          const token = run[0].slice(start, start + length)
          if (!isPlainNounAnchor(token)) continue
          // 含终结动作的片段是动宾短语，不是物证名（#77 的同一口径）。
          if (actions.some(action => token.includes(action))) continue
          if (!props.has(token)) props.set(token, evidence)
        }
      }
    }
  }
  return props
}

export const PROP_REVIVAL_MAX_GAP = 12

/**
 * 「已被写死的物证又自己回来了」（issue #78）。
 *
 * 实测样本：主角唯一的溯读工具「空白票根」在第 21 章被写碎、第 22 章正文
 * 自己承认「票根昨夜泡碎了，他读不了」，第 23–27 章对它的下落一个字都没有，
 * 第 28、30 章又「从怀里摸出空白票根」压上去读——**没有任何取得动作**。
 *
 * #73 的判据抓不到它：那只要求「同一件东西被终结两次」，而这里只有**一次**终结。
 * 所以单独立一条：某章宣告不可逆消亡，后续章又以「可取用」形态出现，
 * 且中间没有「重新获得」的动作。
 */
export function findAnnihilatedPropRevival(
  chapters: readonly ChapterProse[],
  options: { maxGap?: number } = {},
): PropRevival[] {
  const maxGap = options.maxGap ?? PROP_REVIVAL_MAX_GAP
  const ordered = [...chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)

  // 每章：以「可取用」形态出现的名词，以及出现过「重新获得」动作的名词。
  const appearances = new Map<number, { props: Set<string>; reacquired: Set<string>; excerpt: Map<string, string> }>()
  for (const chapter of ordered) {
    const entry = { props: new Set<string>(), reacquired: new Set<string>(), excerpt: new Map<string, string>() }
    for (const sentence of splitProseSentences(String(chapter.content))) {
      const usable = USABLE_APPEARANCE.some(marker => sentence.includes(marker))
      const reacquired = REACQUISITION_ACTIONS.some(marker => sentence.includes(marker))
      if (!usable && !reacquired) continue
      for (const run of sentence.matchAll(/[\u4e00-\u9fa5]+/gu)) {
        for (const length of PROP_WINDOW_WITH_SHORT) {
          for (let start = 0; start + length <= run[0].length; start += 1) {
            const token = run[0].slice(start, start + length)
            if (!isPlainNounAnchor(token)) continue
            if (usable) {
              entry.props.add(token)
              if (!entry.excerpt.has(token)) entry.excerpt.set(token, sentence)
            }
            if (reacquired) entry.reacquired.add(token)
          }
        }
      }
    }
    appearances.set(chapter.chapterNumber, entry)
  }

  const raw: Array<PropRevival & { chapters: number[]; excerpts: string[] }> = []
  for (const chapter of ordered) {
    for (const [prop, annihilationExcerpt] of annihilatedPropsInChapter(String(chapter.content))) {
      const appearedAt: number[] = []
      let appearanceExcerpt = ''
      for (const later of ordered) {
        if (later.chapterNumber <= chapter.chapterNumber) continue
        if (later.chapterNumber - chapter.chapterNumber > maxGap) break
        const entry = appearances.get(later.chapterNumber)!
        if (!entry.props.has(prop)) continue
        // 中间有「重新获得」动作 → 不是自行复活，跳过。
        if (entry.reacquired.has(prop)) continue
        appearedAt.push(later.chapterNumber)
        if (!appearanceExcerpt) appearanceExcerpt = entry.excerpt.get(prop) ?? ''
      }
      if (appearedAt.length === 0) continue
      raw.push({
        prop, annihilatedAt: chapter.chapterNumber, appearedAt, annihilationExcerpt, appearanceExcerpt,
        chapters: [chapter.chapterNumber, ...appearedAt], excerpts: [annihilationExcerpt],
      })
    }
  }
  // 同一件物证可能被**连续几章**都在宣告消亡（实测第 21 章写碎、第 22 章又明文确认
  // 「票根昨夜泡碎了」），于是一条事实报两次。按「名词 + 再现章号集合」归并，
  // 取**最早**的消亡章（读者第一次读到它没了的那一章）。
  const byName = new Map<string, typeof raw[number]>()
  for (const item of raw) {
    const key = `${item.prop}|${item.appearedAt.join(',')}`
    const existing = byName.get(key)
    if (!existing || item.annihilatedAt < existing.annihilatedAt) byName.set(key, item)
  }
  return [...byName.values()]
    .sort((left, right) => right.appearedAt.length - left.appearedAt.length
      || right.prop.length - left.prop.length || left.prop.localeCompare(right.prop))
    .slice(0, 4)
    .map(item => ({
      prop: item.prop,
      annihilatedAt: item.annihilatedAt,
      appearedAt: item.appearedAt,
      annihilationExcerpt: item.annihilationExcerpt,
      appearanceExcerpt: item.appearanceExcerpt,
    }))
}
