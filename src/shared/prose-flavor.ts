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

/** 起草清单的配额（原文：比喻 ≤2、生理反应 ≤1、平均句长 ≤22）。 */
export const AI_FLAVOR_QUOTAS = Object.freeze({
  metaphor: 2,
  physiological: 1,
  averageSentenceChars: 22,
})

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
): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = []
  const ordered = [...chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
  for (const chapter of ordered) {
    const measurement = measureProseFlavor(chapter)
    const chapterNumber = measurement.chapterNumber
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
