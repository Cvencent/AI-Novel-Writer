/**
 * 「AI 味」的可机器判子集（issue #93）。
 *
 * 诉求来自用户：「AI 审稿时应该还有一个维度：写作有没有 AI 味，尽量和真实小说类似。」
 * 核查后发现产品的**起草侧**其实有一份很具体的反制清单
 * （`builtin-prompt-templates.ts` 的【AI 味反制】与【写作质量硬约束】），
 * 而**审稿侧**只有编辑部 style 一栏的三个字「重复、AI 味、视角漂移、角色声音」——
 * 实测那本书 54 条审稿意见里 **category 含风格的 0 条**。也就是说：
 * **缺的不是「防」，而是「查」**；而「查」这一侧一个字都没有。
 *
 * 本模块把那份清单里**可机器判**的一半落成判据，接在与 #82/#83 同一条通道上
 * （`finalized-prose-audit` → 写前预检 + 审稿），于是**不依赖模型也会说出来**：
 *
 *   1. 比喻配额（仿佛／犹如／宛如／如同）——起草清单：全章 ≤2（AI 味反制段写 ≤3，取更严的 2）
 *   2. 模板化生理反应（喉结／攥拳／咬唇…）——清单：全章 ≤1，且不与上一章同一种
 *   3. 段尾总结句（「他知道，这一切才刚刚开始」式）——清单：禁止
 *   4. 平均句长——清单：≤22 字
 *
 * **刻意不做的**（避免假阳性，本仓反复吃过词表过拟合的亏 #30/#43/#70/#80）：
 * - 不做「像…一样」的宽泛匹配：实测那本书**裸「像」12 次 / 10 章**，其中绝大多数是
 *   「像被什么东西撞了一下」这类正常叙述；只收**明确的比喻连接词**（仿佛/犹如/宛如/如同）；
 * - 不做「信息密度」「句长方差」这类需要**人类基线**才能判的指标（issue #93 的 C 方案）——
 *   没有标定过的基线，报出来的数字没有意义；
 * - 阈值全部取自**起草侧清单原文**，不另拍数字：两处口径一致，作者在一边看到的问题
 *   在另一边也认得出（这正是 issue #93 说的「两边不对称」）。
 */
import type { ConsistencyFinding } from './consistency-preflight'

/** 明确比喻连接词。刻意不收裸「像」——那在本样本里是正常叙述（见文件头）。 */
export const METAPHOR_CONNECTORS = Object.freeze(['仿佛', '犹如', '宛如', '如同'] as const)

/**
 * 模板化生理反应（起草清单点名的那些 + 同一族的写法）。
 *
 * 清单原文点的是「鼻血、耳鸣、雪花点、左臂痉挛、咬舌尖、攥紧拳头、喉结滚动」。
 *
 * ⚠️ **刻意不收裸「攥紧／攥住／攥着」**（真实语料实测的假阳性）：
 * 中文里「攥着」绝大多数是**字面意义的握持**——实测那本书
 * 「伙计攥着一条湿布」「手里攥着半块干饼」被抓成「紧张套话」，
 * 而那两句只是「手里拿着东西」。这正是本仓反复吃过的词表过拟合（#30/#43/#70/#80）：
 * 一个词在正常叙述里也常见时，收它就等于把整本书的日常动作卷进来。
 * 只保留**对象被限定**的形式：`攥紧拳`（不含「攥紧布」这类）。
 */
export const PHYSIOLOGICAL_CLICHES = Object.freeze([
  '喉结', '攥紧拳', '咬唇', '咬了咬唇', '咬紧牙', '咬舌尖', '鼻血', '耳鸣',
  '痉挛', '倒吸', '瞳孔', '脊背发凉', '心里一紧', '心头一紧', '指尖发凉', '手心冒汗',
] as const)

/** 段尾总结句的腔调（起草清单：禁止段尾总结句 / 结尾哲理感悟）。 */
export const SUMMARY_TAIL_PATTERNS = Object.freeze([
  '他知道，', '她知道，', '他明白，', '她明白，',
  '命运的齿轮', '才刚刚开始', '都在这一刻', '这一切都', '或许这就是',
  '说不清道不明', '注定要',
] as const)

/**
 * 起草清单的配额（原文：比喻 ≤2、生理反应 ≤1、平均句长 ≤22、意象每词 ≤2）。
 *
 * `motifDensityChars` 是「意象配额」那一条的**密度化**口径（issue #96）：
 * 清单原文是「每个词在本章最多出现 2 次」，但实测那本书 **43/43 章**都超 2 次 ——
 * 按字面实现等于每章都报，正是「规则层输出全是假阳性时等于零信息」（#30）。
 * 所以改成按**密度**判：同一个词在本章的出现间隔不得小于这个字数。
 * 120 字 ≈ 800 字章的 7 次，实测在该样本上触发 7/43 章（报告点名的票根×10、存根×12 都在其中），
 * 而正常用词（柜台、篷布这类 170+ 字/次）不触发。
 */
export const AI_FLAVOR_QUOTAS = Object.freeze({
  metaphor: 2,
  physiological: 1,
  averageSentenceChars: 22,
  motifPerChapter: 2,
  /** 意象密度：同一实词在本章的平均出现间隔（字/次）不得小于它。 */
  motifDensityChars: 120,
})

/**
 * 虚词／功能字（**封闭语法类**，不是开放词表）。
 *
 * 判「哪个实词重复最多」时必须先把含这些字的窗口剔掉：中文里「了一」「的那」「他把」
 * 「在桌」这类窗口在每章都会大量出现（实测「了一」出现在 42/43 章），
 * 不剔掉的话最高频词永远是它们，判据等于没判。
 *
 * 只收**语法功能字**（助词/介词/连词/代词/量词/趋向动词），**不收任何实词**——
 * 这条边界很重要：一旦开始收「墨」「票」这类实词，就变成了词表（#30/#43/#70/#80 的坑）。
 */
export const FUNCTION_CHARACTERS: ReadonlySet<string> = new Set([
  ...'的了在是把被和与就也都这那一不没他她我你么什怎为其而且或但如若因所以至从向对给让着过很更最又还再才只已将并等种些个件张条只次回到去来说做看想要能可得地着',
])

/** 一个窗口里是否含虚词／功能字（含则不作为「意象」候选）。 */
export function hasFunctionCharacter(window: string): boolean {
  for (const character of window) if (FUNCTION_CHARACTERS.has(character)) return true
  return false
}

export interface MotifHit {
  /** 本章重复最多的实词。 */
  word: string
  /** 该词在本章出现的次数。 */
  count: number
  /** 本章字数（去空白）。 */
  chapterChars: number
  /** 平均多少字出现一次。 */
  charsPerOccurrence: number
  /** 命中处所在的段落号（从 1 起，最多 3 个）。 */
  paragraphIndexes: number[]
}

/**
 * 找一章里「被反复用同一个实词拎着走」的那个词（issue #96 的「意象配额」）。
 *
 * 判据**不用词表**：正文切成 2–4 字窗口，剔掉含虚词/功能字的窗口与在册角色名的片段，
 * 再按「同一窗口在本章的出现次数」排序；**去掉被更长候选包含的子串**
 * （「票」⊂「票根」，两者都报会把同一个东西算两次 —— 与 #73「去子串锚点」同一教训）。
 * 胜出者只要满足密度门槛就报。
 *
 * 为什么按长度降序取子串关系而不是简单取最长：`桌面` 与 `在桌` 会同时命中，
 * 前者是实词、后者含虚词已被剔掉；但 `票根` 与 `票` 都合法时，应保留更具体的那个。
 */
/**
 * 「被处置的对象」用词：能把物拿起来／放下去／盯着看的动作词。
 *
 * 这是「意象」与「人物/场所」的分界（issue #96 的标定反馈）：票根被抽出来、折好、按在桌上
 * ——它是**被处置的东西**；而「任九把清单拍在舱板上」「账房伙计递的话」里，那个词是**施动者**。
 * 判据只用**位置关系**（动词后 4 字内出现候选词），不判语义。
 */
const OBJECT_ACTIONS: readonly string[] = Object.freeze([
  '拿起', '放下', '搁', '按', '压', '捏', '盯', '翻开', '摊开', '折', '塞', '收走', '递',
  '抽', '摸出', '举', '凑近', '扔', '捡', '夹', '蘸', '划', '写上', '抄', '撕', '藏',
  '放进', '掏出', '挑起', '压上', '翻', '敲', '撬', '看', '擦', '卷', '扯', '扯下',
])

/** 施动者的典型后接词（人做主语时的谓语起手）。 */
const AGENT_ACTIONS: readonly string[] = Object.freeze([
  '把', '站', '说', '走', '接', '点头', '低头', '抬头', '伸手', '往前', '往后', '问',
  '答', '笑', '抬眼', '转身', '蹲', '坐', '进来', '出去', '叫', '喊', '听', '看',
])

/**
 * 候选词在本章**作宾语**与**作施动者**的次数（issue #96 标定反馈的核心判据）。
 *
 * 「作宾语」= 候选词紧跟在处置动作之后（动词 + 0–4 字 + 候选词）；
 * 「作施动者」= 候选词之后紧跟施动谓语（候选词 + 0–2 字 + 谓语起手）。
 * 两者都是**位置关系**，不依赖任何语义词表。
 */
export function countObjectVersusAgent(word: string, content: string): { asObject: number, asAgent: number } {
  const text = String(content ?? '')
  let asObject = 0
  for (const action of OBJECT_ACTIONS) {
    let index = text.indexOf(action)
    while (index >= 0) {
      if (text.slice(index + action.length, index + action.length + 4).includes(word)) asObject += 1
      index = text.indexOf(action, index + 1)
    }
  }
  let asAgent = 0
  let at = text.indexOf(word)
  while (at >= 0) {
    if (AGENT_ACTIONS.some(action => text.slice(at + word.length, at + word.length + 2).includes(action))) asAgent += 1
    at = text.indexOf(word, at + 1)
  }
  return { asObject, asAgent }
}

export function findChapterMotif(
  chapter: ProseFlavorChapter,
  castNames: readonly string[] = [],
  options: { minCharsPerOccurrence?: number } = {},
): MotifHit | null {
  const content = String(chapter.content ?? '')
  const compact = content.replace(/\s+/gu, '')
  if (compact.length === 0) return null
  const minimumInterval = options.minCharsPerOccurrence ?? AI_FLAVOR_QUOTAS.motifDensityChars
  // 4 字窗口至少要出现这个次数才算「密度超标」。
  const needCount = Math.max(4, Math.ceil(compact.length / minimumInterval))

  const counts = new Map<string, number>()
  for (const run of content.matchAll(/[一-鿿]+/gu)) {
    const text = run[0]
    for (const length of [2, 3, 4]) {
      for (let index = 0; index + length <= text.length; index += 1) {
        const window = text.slice(index, index + length)
        counts.set(window, (counts.get(window) ?? 0) + 1)
      }
    }
  }
  const names = castNames.map(name => String(name ?? '').trim()).filter(Boolean)
  const candidates = [...counts.entries()]
    .filter(([, count]) => count >= needCount)
    .filter(([window]) => !hasFunctionCharacter(window))
    // 在册角色名的片段不算意象（「柯明」是「柯明远」的子串）——人是内容不是道具。
    .filter(([window]) => !names.some(name => name.includes(window)))
  if (candidates.length === 0) return null
  // 去子串：若更长的候选同样高频且包含它，就丢掉短的（同一件事不要报两遍）。
  const maximal = candidates.filter(([window, count]) => !candidates.some(([other, otherCount]) =>
    other !== window && other.length > window.length && otherCount >= count && other.includes(window)))
  // **必须是「被反复处置的东西」，不是「反复在做事的人」**（issue #96 的标定反馈）。
  //
  // ⚠️ 这一步是本条判据最关键的收紧，来自巡检卡拿 24 章全书做的独立标定：
  // 只按「频率 + 词形」筛时，5 条命中里 **4 条是假阳性** ——
  //   「名字」（本书核心概念，全书都在围绕它）、「账房」（场所/职务词×2）、
  //   「任九」（**未建档**的具名人物，不在 castNames 里所以没被上一道滤掉）。
  // 它们的共同点是：**在句子里当施动者**（任九把清舱清单拍在舱板上／账房伙计递的话），
  // 而意象词是**被处置的对象**（票根被抽出来/折好/按在桌上）。
  // 所以判据改成「作宾语的次数 ≥ 1 且多于作施动者的次数」——实测：该书 5 条留 1 条、
  // 另一本 7 条留 5 条，被否掉的两条「伙计」也确实是**人**而不是道具。
  const actioned = maximal.filter(([window]) => {
    const stats = countObjectVersusAgent(window, content)
    return stats.asObject >= 1 && stats.asObject > stats.asAgent
  })
  if (actioned.length === 0) return null
  const [winner] = actioned.sort((left, right) => right[1] - left[1] || right[0].length - left[0].length)
  if (!winner) return null
  const [word, count] = winner
  const paragraphs = content.split(/\n\s*\n/u).map(block => block.trim()).filter(Boolean)
  const paragraphIndexes = paragraphs
    .map((paragraph, index) => ({ paragraph, index: index + 1 }))
    .filter(entry => entry.paragraph.includes(word))
    .slice(0, 3)
    .map(entry => entry.index)
  return {
    word,
    count,
    chapterChars: compact.length,
    charsPerOccurrence: compact.length / count,
    paragraphIndexes,
  }
}

export interface ProseFlavorChapter {
  chapterNumber: number
  content: string
}

/**
 * 统计一组**词表**在正文里的命中次数。
 *
 * ⚠️ 必须**按位置区间去重**：词表里天然存在包含关系（「咬唇」⊂「咬了咬唇」、
 * 「攥紧」⊂「攥紧拳头」），逐个 `indexOf` 相加会把同一处口感算成两次 ——
 * 实测「他咬唇，又咬了咬唇。」算出 3（真实是 2）。本仓在 #73 吃过同一个亏
 * （「三个结」与「下三个结」是同一处），那里的修法是「去子串锚点」，
 * 这里等价地做成：**同一位置只保留最长的那个词**。
 */
function countOccurrences(content: string, needles: readonly string[]): number {
  const text = String(content ?? '')
  // 先按词长降序匹配，长词优先占位；短词若与已占区间重叠就跳过。
  const ordered = [...needles].sort((left, right) => right.length - left.length)
  const claimed: Array<[number, number]> = []
  for (const needle of ordered) {
    let index = text.indexOf(needle)
    while (index >= 0) {
      const end = index + needle.length
      const overlaps = claimed.some(([start, stop]) => index < stop && end > start)
      if (!overlaps) claimed.push([index, end])
      index = text.indexOf(needle, index + 1)
    }
  }
  return claimed.length
}

/** 按中文句末标点切句（与 `prose-repetition` 的口径一致：只留 ≥2 字的实在句）。 */
function proseSentences(content: string): string[] {
  return String(content ?? '')
    .split(/[。！？…]+/u)
    .map(sentence => sentence.replace(/\s+/gu, ''))
    .filter(sentence => sentence.length >= 2)
}

/** 段落口径与 `closingParagraph` 一致：按空行切块。 */
function proseParagraphs(content: string): string[] {
  return String(content ?? '').split(/\n\s*\n/u).map(block => block.trim()).filter(Boolean)
}

export interface ProseFlavorMeasurement {
  chapterNumber: number
  metaphor: number
  physiological: number
  /** 命中段尾总结腔的段落序号（从 1 起）与原文片段。 */
  summaryTails: Array<{ paragraphIndex: number, excerpt: string }>
  averageSentenceChars: number | null
}

/**
 * 量一章的「AI 味」指标（纯统计，不判好坏）——供判据与测试共同核对。
 *
 * 单独导出是为了让阈值可被检验：判据只是拿这些数字与 `AI_FLAVOR_QUOTAS` 比。
 */
export function measureProseFlavor(chapter: ProseFlavorChapter): ProseFlavorMeasurement {
  const content = String(chapter.content ?? '')
  const paragraphs = proseParagraphs(content)
  const sentences = proseSentences(content)
  const summaryTails = paragraphs.flatMap((paragraph, index) => {
    const hit = SUMMARY_TAIL_PATTERNS.find(pattern => paragraph.includes(pattern))
    if (!hit) return []
    // 判据是「这句话**属于这一段的收尾句**」，不是「落在后半」：段落长度不一，用中点做阈值
    // 会漏掉短段（实测「他推开门，走了进去。他知道，这一切才刚刚开始。」23 字、
    // 命中位置 10 —— 恰在中点之前，但它显然是段尾总结腔）。
    // 改成：命中之后**不再有完整的下一句**（只允许同一句的余下部分）。
    const at = paragraph.indexOf(hit)
    const after = paragraph.slice(at + hit.length)
    // 命中之后的「同一句余下部分」要到段末为止；若后面还有**另一句的实质内容**，
    // 说明这句不是收尾句（它后面读者还会看到具体的事）。
    const followingSentence = after.slice(after.search(/[。！？…]/u) + 1).replace(/[\s。！？…、；：""'']+/gu, '')
    if (followingSentence.length > 0) return []
    return [{ paragraphIndex: index + 1, excerpt: paragraph.slice(0, 60) }]
  })
  return {
    chapterNumber: chapter.chapterNumber,
    metaphor: countOccurrences(content, METAPHOR_CONNECTORS),
    physiological: countOccurrences(content, PHYSIOLOGICAL_CLICHES),
    summaryTails,
    averageSentenceChars: sentences.length === 0 ? null
      : sentences.reduce((sum, sentence) => sum + sentence.length, 0) / sentences.length,
  }
}

/**
 * 逐章判「AI 味」配额（issue #93）。
 *
 * 每项只在**超出起草清单给的配额**时报，且给出可核对的数字与原文片段——
 * 作者据此能直接定位到那一段，而不是被要求「写得更像人写的」。
 */
export function proseFlavorFindings(
  chapters: ReadonlyArray<ProseFlavorChapter>,
  currentChapter: number,
  /** 在册角色名：判「哪个实词重复最多」时要排除人名（人是内容不是道具）。 */
  castNames: readonly string[] = [],
): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = []
  const ordered = [...chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
  for (const chapter of ordered) {
    const measurement = measureProseFlavor(chapter)
    const chapterNumber = measurement.chapterNumber
    // 意象配额（issue #96）：同一章里同一个实词被反复用来承担情绪。
    // 清单原文是「每个词最多 2 次」，但实测 43/43 章都超 —— 按字面实现等于每章都报
    // （#30「规则层输出全是假阳性时等于零信息」），所以按**密度**判（见 motifDensityChars）。
    const motif = findChapterMotif(chapter, castNames)
    if (motif) {
      const paragraphs = motif.paragraphIndexes.map(index => `第${index}段`).join('、')
      findings.push({
        stableFactKey: `prose-flavor:motif:${chapterNumber}`,
        severity: 'warning',
        sourceChapter: chapterNumber,
        evidence: `第${chapterNumber}章「${motif.word}」出现 ${motif.count} 次（平均每 ${motif.charsPerOccurrence.toFixed(0)} 字一次；${paragraphs} 等段）`,
        issue: {
          zhCN: `同一个词在本章被反复用来承担情绪：**「${motif.word}」出现 ${motif.count} 次**，平均每 ${motif.charsPerOccurrence.toFixed(0)} 字一次（本章 ${motif.chapterChars} 字）。起草清单的「意象配额」说不要让同一种物件或意象反复承担情绪——同一个词密集出现时，读者记住的是**这个词**，而不是它在推动的**事件**。`,
          enUS: `One word carries the chapter's emotion over and over: **"${motif.word}" appears ${motif.count} times**, roughly once every ${motif.charsPerOccurrence.toFixed(0)} characters (chapter length ${motif.chapterChars}). The drafting list's motif quota says no single object or image should keep carrying the feeling; when one word is this dense, readers remember the word instead of the event it advances.`,
        },
        suggestion: {
          zhCN: `三选一：①**换指称**（第一次点名之后用「那张纸」「它」「这一角」承接，别每次重述全称）；②**换承载物**（把情绪挪到另一个具体的动静上：手上的活、别人的反应、环境的变化）；③如果它确实要在场好几次，**让每次都带来新信息**（位置变了、状态变了、被谁碰过），而不是重复交代「它是那件重要的东西」。`,
          enUS: `Pick one: (1) vary the reference — after the first mention use "the paper", "it", "that corner"; (2) move the feeling onto something else concrete (the work in their hands, someone's reaction, a change in the setting); (3) if it genuinely must appear this often, make each appearance carry new information (it moved, it changed state, someone touched it) instead of re-announcing that it matters.`,
        },
      })
    }
    if (measurement.metaphor > AI_FLAVOR_QUOTAS.metaphor) {
      findings.push({
        stableFactKey: `prose-flavor:metaphor:${chapterNumber}`,
        severity: 'warning',
        sourceChapter: chapterNumber,
        evidence: `第${chapterNumber}章用了 ${measurement.metaphor} 次比喻连接词（${METAPHOR_CONNECTORS.join('／')}），配额是 ${AI_FLAVOR_QUOTAS.metaphor} 次`,
        issue: {
          zhCN: `本章比喻超了起草时给自己定的配额：**${measurement.metaphor} 次**「${METAPHOR_CONNECTORS.join('／')}」，而清单写的是全章不超过 ${AI_FLAVOR_QUOTAS.metaphor} 次。比喻是最容易被模型当默认修辞手法的写法——它不是错，但连着用会让整章的句子都落在同一个节拍上。`,
          enUS: `This chapter exceeds the drafting quota for simile connectives: ${measurement.metaphor} occurrences of ${METAPHOR_CONNECTORS.join(' / ')}, against a declared maximum of ${AI_FLAVOR_QUOTAS.metaphor}. Simile is the figure a model reaches for by default; not wrong in itself, but repeating it puts every sentence on the same beat.`,
        },
        suggestion: {
          zhCN: `能把比喻换成动作或数字的，直接换：「他的手抖得像筛糠」→「他的手在抖，指节撞在桌沿上」。留下的那一两处，挑真正需要读者停下来想一想的那个。`,
          enUS: `Where the simile can become an action or a number, make it one: "his hands shook like a sieve" → "his hands shook and his knuckles hit the table edge." Keep the one or two that genuinely need the reader to pause.`,
        },
      })
    }
    if (measurement.physiological > AI_FLAVOR_QUOTAS.physiological) {
      findings.push({
        stableFactKey: `prose-flavor:physiological:${chapterNumber}`,
        severity: 'warning',
        sourceChapter: chapterNumber,
        evidence: `第${chapterNumber}章出现 ${measurement.physiological} 处模板化生理反应（${PHYSIOLOGICAL_CLICHES.slice(0, 6).join('／')}…），配额是 ${AI_FLAVOR_QUOTAS.physiological} 处`,
        issue: {
          zhCN: `本章模板化生理反应 **${measurement.physiological} 处**（喉结滚动／攥紧拳头／咬唇这类），清单要求全章最多 ${AI_FLAVOR_QUOTAS.physiological} 处、且不得与上一章同一种。这类反应是「紧张」的通用代用品：用第一处是描写，用第三处就变成标点。`,
          enUS: `This chapter uses ${measurement.physiological} templated physiological reactions (throat-bobbing, clenched fists, bitten lips…). The declared maximum is ${AI_FLAVOR_QUOTAS.physiological}, and it must not repeat the previous chapter's one. These reactions are a generic stand-in for tension: the first is description, the third is punctuation.`,
        },
        suggestion: {
          zhCN: `换成**这个人特有**的反应：他紧张时是先去摸某样东西、还是把话说完就跑题、还是忽然关心一个无关的细节。角色卡里的动机与底线正是用来决定这一处的。`,
          enUS: `Replace it with a reaction specific to this character: what they reach for when tense, how they change the subject, which irrelevant detail they suddenly fixate on. The character card's motivation and limits are what decide this.`,
        },
      })
    }
    if (measurement.summaryTails.length > 0) {
      const sample = measurement.summaryTails.slice(0, 2)
        .map(item => `第${item.paragraphIndex}段「${item.excerpt}…」`).join('；')
      findings.push({
        stableFactKey: `prose-flavor:summary-tail:${chapterNumber}`,
        severity: 'warning',
        sourceChapter: chapterNumber,
        evidence: `第${chapterNumber}章有 ${measurement.summaryTails.length} 处段尾总结腔（${sample}）`,
        issue: {
          zhCN: `本章有 **${measurement.summaryTails.length} 处**段落以总结腔收尾（${sample}）。起草清单把「段尾总结句／结尾哲理感悟」列为严禁出现——它的作用是替读者把这一段的意思说了一遍，而读者本来会自己得出结论。`,
          enUS: `This chapter ends ${measurement.summaryTails.length} paragraph(s) on a summarising note (${sample}). The drafting list forbids closing summary lines and closing moral reflections: they state the meaning of the passage for the reader, who would otherwise draw it themselves.`,
        },
        suggestion: {
          zhCN: `停在具体的那件事上收尾：一个动作、一句没说完的话、一个物件的位置。把「他知道，这一切才刚刚开始」换成他此刻实际做的一件小事。`,
          enUS: `End on the concrete thing: an action, an unfinished line, where an object ended up. Replace "he knew this was only the beginning" with the small thing he actually does next.`,
        },
      })
    }
    if (measurement.averageSentenceChars !== null
      && measurement.averageSentenceChars > AI_FLAVOR_QUOTAS.averageSentenceChars) {
      findings.push({
        stableFactKey: `prose-flavor:sentence-length:${chapterNumber}`,
        severity: 'warning',
        sourceChapter: chapterNumber,
        evidence: `第${chapterNumber}章平均句长 ${measurement.averageSentenceChars.toFixed(1)} 字，清单要求 ≤${AI_FLAVOR_QUOTAS.averageSentenceChars} 字`,
        issue: {
          zhCN: `本章平均句长 **${measurement.averageSentenceChars.toFixed(1)} 字**，超过清单的 ${AI_FLAVOR_QUOTAS.averageSentenceChars} 字。平均句长偏长通常意味着句子都在做同一件事（交代、解释、铺陈），缺短句与纯动作句来打断节奏——读者读起来会觉得「一直在被告诉」，而不是「在看事情发生」。`,
          enUS: `Average sentence length is ${measurement.averageSentenceChars.toFixed(1)} characters, above the declared ${AI_FLAVOR_QUOTAS.averageSentenceChars}. A long average usually means the sentences are all doing the same job (informing, explaining, setting up) with too few short or pure-action sentences to break the rhythm.`,
        },
        suggestion: {
          zhCN: `把解释性段落拆短：每 5 个自然段里放 1 个 12 字以内的短句或纯动作句（清单的原话）。先找那些「虽然／因此／于是」开头的句子——它们通常可以砍掉前半截。`,
          enUS: `Split the explanatory paragraphs: keep one sentence of twelve characters or fewer, or one pure-action sentence, in every five paragraphs. Start with the ones opening on "although / therefore / so" — they usually lose their first half.`,
        },
      })
    }
  }
  void currentChapter
  return findings
}
