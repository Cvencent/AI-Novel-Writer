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
 * 「转移保管」而非消亡的收尾去向（issue #122）。
 *
 * `收走` / `拿走` / `抄走` 本身只说明东西换了手或换了地方，不说明它没了：
 * 实测 ch38「柯明远收走报告，看一眼，折好，塞进公文包外袋。」三章后
 * 「柯明远把先前那份报告抽出来，压在表旁」——东西一直在包里，却被报成
 * 「第 38 章被写没了、第 41 章又复活」。
 *
 * 判据是结构性的：动作之后紧跟**收进容器/归档**的去向。这是封闭的动词类，
 * 不是道具名词表；「交出/交还」这种**移交给对方**的收尾没有去向动词，仍是真终结。
 */
const CONTAINMENT_DESTINATIONS = /(?:塞进|搁进|装进|放进|夹进|卷进|收进|归档|入档|封存|锁进|压进)/u

/** 该动作后面紧跟「收进某处保管」时不算消亡。 */
function isContainmentAction(narration: string, action: string): boolean {
  const index = narration.indexOf(action)
  if (index < 0) return false
  return CONTAINMENT_DESTINATIONS.test(narration.slice(index + action.length, index + action.length + 14))
}

/**
 * 「不可逆消亡」的宣告（issue #78）：比单个动作更强的信号。
 * 实测样本第 21 章单独写了一行「没了。」来钉死这件事。
 */
const ANNIHILATION_DECLARATIONS = Object.freeze(['没了', '再也没有', '不复存在'] as const)

/**
 * 「看不见了」而不是「没了」的谓语（issue #122）。
 *
 * 宣告句的主语若是**知觉对象**（声音/字/痕迹/气味）或**藏匿动作的结果**，
 * 消失的是它此刻的可感知性，不是这件实物被销毁：
 *
 * - 实测 ch39「木板响了两声，没了。」——响的是跳板，不是道具；
 * - 实测 ch52「柯明远推担保书过来之前说过一句话，原话没了。」——没的是那句话；
 * - 实测 ch48「温珩把下摆往下扯了一寸。黄纸角没了。」——被衣襟盖住了，
 *   下一章又从夹层里「摸出一片黄纸角」。（这一形态无法与销毁区分，所以不做判据。）
 *
 * 这里只收**封闭的知觉名词类**（声/响/音/字/墨/痕/影/味），它们是同类事物的
 * 公共词根，不是某个道具的名字。判据：宣告句自身的主语落在这一类里 → 不是物证消亡。
 */
const PERCEPTION_SUBJECTS = /(?:声|响|音|字|墨|痕|影|味|话|口气|样子|神色)/u

/** 宣告句自身的（去掉宣告词后的）主语是否只是一个知觉对象。 */
function declaresPerceptionLoss(sentence: string): boolean {
  const narration = narrationOnly(sentence)
  for (const marker of ANNIHILATION_DECLARATIONS) {
    const index = narration.indexOf(marker)
    if (index < 0) continue
    // 取宣告词之前最近的逗号/句号之后的内容，即这句宣告的主语小句。
    const before = narration.slice(0, index)
    const subject = before.slice(Math.max(before.lastIndexOf('，'), before.lastIndexOf('。'),
      before.lastIndexOf('；'), before.lastIndexOf('、')) + 1)
    if (PERCEPTION_SUBJECTS.test(subject)) return true
  }
  return false
}

/** 「可取用」的形态（issue #78）：没有获得动作就直接使用。 */
const USABLE_APPEARANCE = Object.freeze([
  '摸出', '取出', '拿出', '掏出', '抽出', '压上', '递到', '蘸水压',
  // 蘸潮/蘸水（issue #80 实测）：ch30「他把票根蘸了潮，压上去」——票根在动词之前，
  // 且与「压上」之间被逗号隔开；只认后置宾语会漏掉这条 #78 的真阳性。
  '蘸了潮', '蘸潮', '蘸了水',
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

/**
 * 纯功能字串：整串由数词/量词/指示词/方位词组成，没有任何实词性汉字（issue #122）。
 *
 * 滑窗枚举（2–5 字）必然切出不属于任何名词的碎片：实测真实书稿上抽出
 * 「一张」（数词+量词）、「那张」（指示词+量词）、「里那」（方位词+指示词——
 * 原文是「内衬里那」，「名词 + 方位词 + 指代」被切成了两字名词）。
 * 这些词在语料里各章都出现，于是被判成「一件在第 N 章被写没了、后面又复活的道具」。
 *
 * 判据是**封闭语法类**，不是名词表：这些字属于数词/量词/指示词/方位词这几个
 * 封闭功能类（`#113` 的 `prop:relocation` 与 `#96` 的「任九」踩过同一类碎片）。
 * 只要候选里有一个实词性汉字就放行——所以「三个结」（数词+量词+实词）不受影响，
 * 而「一张」「那张」「里那」被挡掉。量词本义是名词的字（张/页/册/门/件/套）
 * 也在这一类里，但要求**整串都是**功能字才会被拒，故「册子」「门轴」照常通过。
 */
const NUMERAL_CHARS = '一二三四五六七八九十百千万亿两半几每各某'
const DEMONSTRATIVE_CHARS = '这那其该此彼'
// 只收「本身不能单独做名词」的量词：页/册/篇/份/件/套/桩/门 本义就是名词，
// 不能算功能字——否则「那页」这种合法指代会被当成碎片丢掉（#80 的真阳性）。
const MEASURE_CHARS = '张条只个块片根截支枝枚颗粒堆串副对双把'
const LOCALIZER_CHARS = '里中上下内外面边侧底前后左右旁'
// 趋向补语（来/去/过/起/开/回）同样不能单独做名词：ch29「绳圈翻过来」被切成
// 「过来」，再和 ch33「递过来」对成一件「复活的道具」。
const DIRECTION_CHARS = '来去过起开回'
const FUNCTION_ONLY_CHARS = new RegExp(
  `^[${NUMERAL_CHARS}${DEMONSTRATIVE_CHARS}${MEASURE_CHARS}${LOCALIZER_CHARS}${DIRECTION_CHARS}]+$`, 'u')

function isFunctionOnlyToken(token: string): boolean {
  return FUNCTION_ONLY_CHARS.test(token)
}

/** 单纯的名词性片段（不看动作）：#78 的抽取用同一口径。 */
function isPlainNounAnchor(token: string): boolean {
  return !/^[的了着把将在和与及]|(?:的|了|着)$/u.test(token)
}

/**
 * 消亡侧候选额外要求「不是纯功能字串」。
 *
 * 只在**消亡侧**加这道闸，因为指示性指代在两侧的角色不同：实测 ch43
 * 「徐哥那张，拿走了。」与「一张临时移交单」会切出「那张」「一张」，
 * 它们落进消亡侧就变成「一件在第 N 章被写没了的道具」——3/3 假阳性的主源。
 * 而再现侧本来就要求候选落在「摸出／取出」这类动作的宾语区间里，
 * 同样的「那页」在那里是正当的指代（#80 的真阳性靠它）。
 */
function isNounLikePropSurviving(token: string, cast: ReadonlySet<string>): boolean {
  return !isFunctionOnlyToken(token) && isNounLikeProp(token, cast)
}

/**
 * 物证候选：名词性片段，且**不是角色名**（issue #80）。
 *
 * 抽取器此前不接收名册，于是「周叙」这样的主角名被当成一件「在 ch3 被写没了、
 * ch4 又复活」的道具——真实书稿上 4/4 假阳性、其中 1 条是主角名。
 * 人不是道具：名册里的名字（含片段包含关系，例如名册有「周叙」时「周叙」与其
 * 子串都排除）直接丢弃。
 *
 * 刻意**不做**「场所/职务」的反向词表（报告建议 2 自己也不建议）：那是词表，
 * 换一本书就失效。场所类噪声由「必须是动作宾语」这条（建议 3）兜住。
 */
function isNounLikeProp(token: string, cast: ReadonlySet<string>): boolean {
  if (!isPlainNounAnchor(token)) return false
  if (cast.has(token)) return false
  // 「周叙」在名册里时，「周叙」两字窗口与其更短子串都不该当道具；
  // 反过来名册里是短名（「全叔」）而候选更长（「全叔那」）时也要排除。
  for (const name of cast) {
    if (name.includes(token) || token.includes(name)) return false
  }
  return true
}

/**
 * 「可取用形态」动词**宾语**在句中的起始位置（issue #80 建议 3）。
 *
 * 分析到动词为止的**最长宾语片段**：中文里宾语在动词之后（「摸出票夹」），
 * 也常见「把 X 摸出」的处置式（宾语在动词前）。两种都返回。
 *
 * 只按「动作词同句出现」判时，中文的「主体 + 动词」句子天然满足消亡上下文 +
 * 可用形态两个条件，于是主语（角色名）也被当成可取用的道具——这正是 #80 的
 * 主要假阳性来源。
 */
function usableObjectSpans(sentence: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  for (const marker of USABLE_APPEARANCE) {
    for (let index = sentence.indexOf(marker); index >= 0; index = sentence.indexOf(marker, index + 1)) {
      // 动词之后的连续 CJK 串就是宾语（可能带定语：「空白票根」）。
      const after = sentence.slice(index + marker.length)
      const object = /^[\u4e00-\u9fa5]+/u.exec(after)?.[0]
      if (object) spans.push({ start: index + marker.length, end: index + marker.length + object.length })
      // 处置式：「把 X 摸出」——查询动词前最近的「把/将」之后的内容。
      // 宾语与动词之间可能隔着逗号和短句（「把票根蘸了潮，压上」），所以回溯 8 字
      // 而不是要求紧邻，否则 #78 的 ch30 真阳性会漏掉。
      const before = sentence.slice(0, index)
      const disposal = /(?:把|将)([\u4e00-\u9fa5]{1,8})$/u.exec(before)
      if (disposal?.[1]) spans.push({ start: before.length - disposal[1].length, end: before.length })
    }
  }
  return spans
}

/**
 * 去掉句中被引号包起来的部分，只留叙述（issue #122）。
 *
 * 中文小说里「把你爹那份旧航次账抄件**交出来**」「账本随船，明早原样**交回**」
 * 「徐哥那张，**拿走**了」都是**台词里的索取或转述**——东西还在原处，一件都没被处理掉。
 * 判据只认「叙述里真的发生了这个动作」，否则每一句带「交出/交回/拿走」的威胁
 * 都会变成一条物证消亡记录。#122 实测的 3 条假阳性里有 2 条正是这个形态。
 *
 * 引号是**封闭字符类**（“ ” 「 」 『 』 "），不是词表。未闭合的开引号按「到句尾」处理，
 * 因为 `splitProseSentences` 会把带前引号的残句并入上一句（`”“徐哥那张，拿走了。`）。
 */
function narrationOnly(sentence: string): string {
  let result = ''
  let depth = 0
  for (const character of sentence) {
    if ('“「『"'.includes(character)) { depth += 1; continue }
    if ('”」』"'.includes(character)) { depth = Math.max(0, depth - 1); continue }
    if (depth === 0) result += character
  }
  return result
}

/** 某句里出现的终结动作（只看叙述，不看台词）。 */
function terminalActionsIn(sentence: string): string[] {
  const narration = narrationOnly(sentence)
  return TERMINAL_ACTIONS.filter(action => narration.includes(action) && !isContainmentAction(narration, action))
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
    // issue #122：同一个物证在**同一组章号**上必然只是「同一处上下文的两种切法」——
    // 实测 ch48 的「黄纸角没了」/ ch49 的「摸出一片黄纸角」会同时切出「黄纸角」与
    // 「黄纸」，两条都报。旧判据还要求来源句相同，而消亡侧与再现侧取的根本不是同一句，
    // 于是这条合并不了。只按章号集合判即可：不同物证同章同序的概率可忽略，
    // 而同一物证在同组章号上重复报是必然噪声。
    const duplicate = kept.some(existing => (
      existing.chapters.join(',') === candidate.chapters.join(',')
      || (existing.chapters.length === candidate.chapters.length
        && existing.chapters.every((chapter, index) => chapter === candidate.chapters[index]))
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
function annihilatedPropsInChapter(content: string, cast: ReadonlySet<string>): Map<string, string> {
  const props = new Map<string, string>()
  const sentences = splitProseSentences(String(content ?? ''))
  for (let index = 0; index < sentences.length; index += 1) {
    const sentence = sentences[index]!
    const actions = terminalActionsIn(sentence)
    const narration = narrationOnly(sentence)
    const declared = ANNIHILATION_DECLARATIONS.some(marker => narration.includes(marker))
      && !declaresPerceptionLoss(sentence)
    if (actions.length === 0 && !declared) continue
    /**
     * 独立宣告句的前指范围（issue #122）。
     *
     * 只有**整句就是宣告本身**时（「没了。」独占一句），它的主语才要从前面继承：
     * 实测 #78 的真阳性是「票根表面起毛……」「第三下，纸面从中间酥开……」「没了。」，
     * 物证名在与宣告相隔两句的地方，只看紧邻句会漏掉它。
     *
     * 但宣告**嵌在别的分句里**时，它的主语就是那句自己的主语，不能外借：
     * 实测 ch39「木板响了两声，没了。」——「没了」是响声停了，前两句里的「空白」
     * 跟它毫无关系，旧判据把它抽成一件「第 39 章被写没了、第 43 章又复活的道具」。
     * 同时宣告必须是叙述：ch17「“没了。”」是角色说出口的判断，不是叙述者的宣告。
     */
    const standalone = declared && narration.replace(/[\s\p{P}\p{S}]/gu, '') !== ''
      && ANNIHILATION_DECLARATIONS.some(marker => narration.replace(/[\s\p{P}\p{S}]/gu, '') === marker)
    const inheritsPrior = actions.length === 0 && standalone && index > 0
    // 物证名可能更早：ch21 的「票根表面起毛……」与「第三下，纸面从中间酥开……」是**两句**，
    // 而宣告在后一句，所以独立宣告句要覆盖到前两句（只对 standalone 生效）。
    const scope = inheritsPrior
      ? `${sentences.slice(Math.max(0, index - 2), index).join('')}${sentence}`
      : sentence
    const evidence = (inheritsPrior ? sentences[index - 1] ?? sentence : sentence).trim()
    for (const run of scope.matchAll(/[\u4e00-\u9fa5]+/gu)) {
      for (const length of PROP_WINDOW_WITH_SHORT) {
        for (let start = 0; start + length <= run[0].length; start += 1) {
          const token = run[0].slice(start, start + length)
          if (!isNounLikePropSurviving(token, cast)) continue
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
  options: { maxGap?: number; castNames?: readonly string[] } = {},
): PropRevival[] {
  const maxGap = options.maxGap ?? PROP_REVIVAL_MAX_GAP
  // 角色名册（issue #80）：抽取器此前不接收它，于是「周叙」这样的**主角名**被当成
  // 一件「在 ch3 被写没了、ch4 又复活」的道具——真实书稿上 4/4 假阳性。
  // 人不是道具，直接排除。
  const cast = new Set((options.castNames ?? []).map(name => String(name).trim()).filter(Boolean))
  const ordered = [...chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)

  // 每章：以「可取用」形态出现的名词，以及出现过「重新获得」动作的名词。
  const appearances = new Map<number, { props: Set<string>; reacquired: Set<string>; excerpt: Map<string, string> }>()
  for (const chapter of ordered) {
    const entry = { props: new Set<string>(), reacquired: new Set<string>(), excerpt: new Map<string, string>() }
    for (const sentence of splitProseSentences(String(chapter.content))) {
      const reacquired = REACQUISITION_ACTIONS.some(marker => sentence.includes(marker))
      // 「可取用」必须是**宾语**（issue #80 建议 3）：不只是动作词同句出现，
      // 而是该词就是那个动作的宾语（「摸出票夹」里的「票夹」）。
      // 只按同句出现判时，中文里「主体 + 动词」的句子天然满足两个条件——
      // 「周叙摸出票夹」里的主语「周叙」于是也被当成一件可取用的道具。
      const usableObjects = usableObjectSpans(sentence)
      if (usableObjects.length === 0 && !reacquired) continue
      for (const run of sentence.matchAll(/[\u4e00-\u9fa5]+/gu)) {
        for (const length of PROP_WINDOW_WITH_SHORT) {
          for (let start = 0; start + length <= run[0].length; start += 1) {
            const token = run[0].slice(start, start + length)
            if (!isNounLikeProp(token, cast)) continue
            // 候选只要**落在宾语区间内**即可，不要求从区间起点开始：
            // 「从怀里摸出空白票根」的宾语是「空白票根」，「票根」落在其中（#78 的真阳性）。
            const tokenStart = sentence.indexOf(token)
            if (usableObjects.some(span => tokenStart >= span.start && tokenStart < span.end)) {
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
    for (const [prop, annihilationExcerpt] of annihilatedPropsInChapter(String(chapter.content), cast)) {
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
  //
  // issue #122：同一个名字还有**不同切法**（ch48/49 的「黄纸角」与「黄纸」），
  // 它们各自过一遍上面的逻辑，产出同一组章号的两条记录。所以两个键都要参与归并：
  // 先按「名词 + 再现章号」去重，再按「消亡章 + 再现章号集合」补齐切法合并，
  // 后者保留名字最长的那个（信息最多）。
  const byName = new Map<string, typeof raw[number]>()
  for (const item of raw) {
    const key = `${item.prop}|${item.appearedAt.join(',')}`
    const existing = byName.get(key)
    if (!existing || item.annihilatedAt < existing.annihilatedAt) byName.set(key, item)
  }
  const merged: Array<typeof raw[number]> = []
  for (const item of [...byName.values()].sort((left, right) => right.prop.length - left.prop.length)) {
    const sameStory = merged.find(existing => existing.annihilatedAt === item.annihilatedAt
      && existing.appearedAt.join(',') === item.appearedAt.join(','))
    if (!sameStory) merged.push(item)
  }
  return merged
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
