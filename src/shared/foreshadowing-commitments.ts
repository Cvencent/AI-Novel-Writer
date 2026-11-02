/**
 * 蓝图 `foreshadowing`（伏笔）里的**远期承诺**（issue #68）。
 *
 * 问题：这个字段是「只写不读」的。模型会在里面写下带明确章号的承诺——
 * 「留待第 15 章揭开」「为第 19—22 章父亲旧账的反转留扣」「与第 22 夜…接榫」——
 * 但没有任何环节把它送到目标章去：生成第 N 章蓝图时只带最近 3 章的 5 个短字段
 * （`keyEvents`/`costs`/`suspenseHook`/`closingShot`/`staging`，**不含 foreshadowing**），
 * 起草第 N 章时那句「必须埋下或回收的伏笔」取的又只有**本章自己**的 foreshadowing。
 * 26 章实测：4 条远期承诺 3 条在目标章正文 0 命中。
 *
 * 取数口径要从「按位置」（最近 N 章）改成**按承诺**（指向本章的那些章）。
 * 这里只做能可靠解析的那一类：**文中明确写了章号**的承诺。没写章号的伏笔
 * 留给作者自己判断——猜它指向哪一章只会制造假信号。
 */

/** 蓝图里本模块需要的字段（保持窄，避免把整个 ChapterBlueprint 拖进来）。 */
export interface ForeshadowingSource {
  chapterNumber: number
  foreshadowing?: string
}

export interface ForeshadowingCommitment {
  /** 写在哪一章的 foreshadowing 里。 */
  plantsAt: number
  /** 承诺兑现的章号（区间会展开；升序，去重）。 */
  paysOffAt: number[]
  /** 承诺原文（截断后，用于进提示词与证据展示）。 */
  text: string
}

/** 单章承诺文本的进上下文上限：伏笔是短句，超长说明写成了剧情梗概。 */
export const FORESHADOWING_TEXT_LIMIT = 120

/** 一次最多带多少条承诺进上下文，避免长篇后期这一项无限增长。 */
export const FORESHADOWING_COMMITMENT_LIMIT = 12

/**
 * 从一段 foreshadowing 文本里抽出它指向的章号。
 *
 * 覆盖样本里出现过的三类写法：
 *   「留待第 15 章揭开」            → 单章
 *   「为第 19—22 章…留扣」          → 区间
 *   「与第 22 夜『…』接榫」          → 单章（章/夜/晚 混用）
 * 另外接受「第 A 至 B 章」这类中文连接词。
 */
export function chapterRefsInForeshadowing(text: string): number[] {
  const source = String(text ?? '')
  if (!source.trim()) return []
  const found = new Set<number>()
  const push = (value: number) => { if (Number.isSafeInteger(value) && value >= 1 && value <= 5000) found.add(value) }
  // 区间：第 A—B 章 / 第 A-B 章 / 第 A~B 章 / 第 A 至 B 章
  const range = /第\s*(\d{1,4})\s*(?:[—\-~～]|至|到)\s*(\d{1,4})\s*章/gu
  for (const match of source.matchAll(range)) {
    const from = Number(match[1]), to = Number(match[2])
    // 区间写反了（第 22—19 章）时按升序理解，不丢承诺。
    const [low, high] = from <= to ? [from, to] : [to, from]
    // 防跑飞：一个区间最多展开 24 章，超过说明这不是「伏笔承诺」（例如「第 1—100 章」）。
    if (high - low <= 24) for (let chapter = low; chapter <= high; chapter += 1) push(chapter)
    else { push(low); push(high) }
  }
  // 单章：第 N 章 / 第 N 夜 / 第 N 晚（三种都出现在样本里）
  for (const match of source.matchAll(/第\s*(\d{1,4})\s*[章夜晚]/gu)) push(Number(match[1]))
  return [...found].sort((left, right) => left - right)
}

/** 归一化承诺文本：压平空白、去引号包裹，并按上限截断。 */
function normalizeCommitmentText(text: string): string {
  const flattened = String(text ?? '').replace(/\s+/gu, ' ').trim()
  if (flattened.length <= FORESHADOWING_TEXT_LIMIT) return flattened
  return `${flattened.slice(0, FORESHADOWING_TEXT_LIMIT)}…`
}

/**
 * 从一批蓝图里解析出所有**远期**承诺。
 *
 * 只保留指向**后面**章节的（`paysOffAt > plantsAt`）：foreshadowing 按定义是埋给未来
 * 的；文本里提到自己这一章（「本章埋下水隔边的新撬痕」）是**埋设**而不是承诺，
 * 当成承诺会让每一章都对自己产生一条假提示。
 */
export function parseForeshadowingCommitments(
  blueprints: readonly ForeshadowingSource[],
): ForeshadowingCommitment[] {
  return blueprints.flatMap(blueprint => {
    if (!Number.isSafeInteger(blueprint.chapterNumber)) return []
    const forwards = chapterRefsInForeshadowing(blueprint.foreshadowing ?? '')
      .filter(chapter => chapter > blueprint.chapterNumber)
    if (forwards.length === 0) return []
    return [{
      plantsAt: blueprint.chapterNumber,
      paysOffAt: forwards,
      text: normalizeCommitmentText(blueprint.foreshadowing ?? ''),
    }]
  })
}

/**
 * 取出「指向第 chapterNumber 章」的承诺，按埋设章升序。
 *
 * `alreadyInContextChapters` 用于起草/蓝图生成：最近几章的蓝图本来就整段在上下文里，
 * 它们的 foreshadowing 不必再以「承诺」形式重复一遍。传 3 表示「第 N-3…N-1 章已可见」，
 * 只保留埋设章**早于**这个窗口的承诺。
 */
export function foreshadowingDueAt(
  commitments: readonly ForeshadowingCommitment[],
  chapterNumber: number,
  options: { alreadyInContextChapters?: number } = {},
): ForeshadowingCommitment[] {
  const window = Math.max(0, options.alreadyInContextChapters ?? 0)
  const newestVisible = chapterNumber - window
  return commitments
    .filter(commitment => commitment.paysOffAt.includes(chapterNumber))
    .filter(commitment => commitment.plantsAt < newestVisible)
    .sort((left, right) => left.plantsAt - right.plantsAt)
    .slice(-FORESHADOWING_COMMITMENT_LIMIT)
}

/**
 * 承诺的「可检索词」：从承诺文本里去掉章号引用与指示词后，取出最长的几个名词性片段。
 *
 * 用于「本章正文有没有真的把这件事写出来」的可定位判据：命中任一即可，
 * 不追求精确——目的是把 0 命中的那几条捞出来给作者看。
 */
/**
 * 只带通用叙事动词、不带具体信息的片段：它们在任何一章的正文里都可能出现，
 * 拿去做「本章有没有兑现」的检索只会产生假命中。
 */
const GENERIC_FRAGMENTS = new Set([
  '揭开', '留扣', '留白', '回收', '接榫', '照应', '呼应', '铺垫', '预告', '埋下', '埋设',
  '留待', '反转', '留扣子', '解开', '兑现', '落扣', '起承', '承接', '说明', '交代',
])

/**
 * 引号类（issue #70）。必须同时覆盖排印弯引号、直角引号与 ASCII 引号。
 *
 * 用 `\u` 转义写而不是字面量：U+2018/2019/201C/201D 与 ASCII 引号在源码里
 * 肉眼几乎不可分。本函数第一版就是把 ASCII 双引号连写两遍（`[「『""]`）、
 * 漏掉 U+201C/U+201D，于是 18 章用弯引号的承诺变成「自带引号的检索词」——
 * 正文永远命不中，提示永久假阳性且作者无法消掉。转义写法让这种错误看得见。
 */
const QUOTE_CHARS = '\u0022\u0027\u2018\u2019\u201c\u201d\u300c\u300d\u300e\u300f'

/** 一段被引号包起来的文字（含两侧引号），整段剥掉。 */
const QUOTED_SPAN = new RegExp(`[${QUOTE_CHARS}][^${QUOTE_CHARS}]{1,60}[${QUOTE_CHARS}]`, 'gu')

/** 任何引号类字符（含未成对出现的）；片段里出现即判该片段不可用。 */
const HAS_QUOTE = new RegExp(`[${QUOTE_CHARS}]`, 'u')

/** 明显的连接/语气残片：以它们起头或收尾的片段不是实体词。 */
const CONNECTOR_EDGE = /^(?:与|和|及|并|的|了|是|在|把|将|被)|(?:与|和|及|并|的)$/u

/**
 * 承诺的「可检索词」：从承诺文本里去掉章号引用与指示词后，取出若干可用的检索片段。
 *
 * 形态上不再只给**整段带定语的短语**（issue #88）：承诺常写成
 *   「埋下短褂头一行父亲的名字与缺小指的指印（指向叶九）」
 * 而正文只会写「名字」「指印」这样的**中心词**，绝不会把那串定语连起来写。
 * 于是整段拿去 `includes` 恒为 0 命中——**正文明明兑现了也判未送达**。
 * 所以每个片段同时产出**中心词变体**（剥掉「…的」前面的定语、以及尾部 2–3 字）。
 *
 * ⚠️ 变体**必须按可区分度筛过**再用，不能直接拿去比对（issue #88 的实测）：
 *   「名字」出现在该书 30/38 章（79%）、「的名字」22/38（58%）——这类词任何一章都命中，
 *   等于把「未送达」判据变成永远不报；而「撬痕」3/38（8%）、「指印」6/38（16%）
 *   才是真正指向那件事的锚点。判据用**文档频率**（出现在样本的多少章）而不是词表：
 *   词表的坑本仓已吃过多次（#30/#43/#70），而频率是**量出来的**、换本书照样成立。
 *
 * 返回的候选由调用方按 DF 过滤（见 `selectDiscriminatingKeywords`）。
 */
export function foreshadowingKeywords(text: string): string[] {
  const stripped = String(text ?? '')
    .replace(/第\s*\d{1,4}\s*(?:[—\-~～]|至|到)?\s*\d{0,4}\s*[章夜晚]/gu, ' ')
    // 引号里常是模型编造的前文原话：不能拿来当检索词，先去壳。
    .replace(QUOTED_SPAN, ' ')
  const segments = stripped
    .split(/[，,。；;：:、\s（）()【】\[\]]+/u)
    // 并列结构要拆成**原子**（issue #83）：承诺常写成
    //   「埋下水隔边的新撬痕与全叔那句『这日子你碰不得』」
    // 剥掉引号后整段成了「水隔边的新撬痕与全叔那句」。可正文只会写「水隔边的新撬痕」，
    // 绝不会把这半句话连起来写——于是整段拿去检索**永远命不中**，正文明明兑现了
    // 也照报（实测第 15 章写了「撬痕」，仍被判未送达）。这与 #70 是同一类缺陷：
    // 检索词自带一种正文不可能出现的形态。按并列连词拆开后两侧各自成词，即可命中。
    .flatMap(piece => piece.split(/[与和及并]/u))
    .map(segment => segment.replace(/^(?:埋下|埋设|留待|留扣|留白|为|与|把|将|给|待|回收|接榫|照应|呼应|铺垫|预告|以及|和|并)+/u, '').trim())
    .filter(segment => segment.length >= 2 && segment.length <= 12)
    // 「X与那句」拆出的「那句」这类指示残片：单独出现没有区分度，丢掉。
    .filter(segment => !/^[那句这个那些这种其]+$/u.test(segment))
    .filter(segment => !GENERIC_FRAGMENTS.has(segment))
    // 兜底（issue #70）：嵌套或未成对的引号会让某一段没被整段剥掉。含引号的片段
    // 自带引号，正文里永远不可能出现——绝不能放它去比对，否则整条承诺变永久假阳性。
    .filter(segment => !HAS_QUOTE.test(segment))
    .filter(segment => !CONNECTOR_EDGE.test(segment))
  // 长片段更有区分度：优先 4 字以上，不足时再补 2–3 字的。
  const long = segments.filter(segment => segment.length >= 4)
  // ⚠️ 这里**不再** `.slice(0, 3)`（issue #88）：一条 foreshadowing 常一次写三件事
  // （「回收 X；埋下 Y；为第 19–22 章 Z」），真正被承诺的那件常排在第 4 个之后，
  // 全局只留 3 个会让它**结构上永远进不了检索词**。上限交给调用方的 DF 筛选取前 N。
  return [...new Set([...long, ...segments])]
}

/**
 * 一个片段可用的**检索变体**：整段、中心词（剥「…的」定语）、尾部 2–3 字，
 * 以及**剥掉前置修饰语的中心词**（「水隔边的新撬痕」→「撬痕」）。
 *
 * ⚠️ 最后一条不能省（实测）：只剥「…的」时，「水隔边的新撬痕」的尾部是「新撬痕」，
 * 而正文写的是「撬痕」—— 就差一个修饰字，仍判未送达。中文名词的修饰语可以叠
 * （地点定语 + 形容词 + 中心词），所以尾部还要再退一步取**最后 2 字**；
 * 同时剥掉「新/旧/老/小/大/第 N/原」这类单字修饰前缀。
 */
export function keywordVariants(segment: string): string[] {
  const out: string[] = [segment]
  const attributive = segment.lastIndexOf('的')
  if (attributive >= 0 && attributive < segment.length - 1) out.push(segment.slice(attributive + 1))
  if (segment.length >= 4) out.push(segment.slice(-3))
  if (segment.length >= 4) out.push(segment.slice(-2))
  // 「地点定语 + 形容词 + 中心词」：尾部再剥一层单字修饰前缀（新/旧/老/小/大/原/半/破）。
  const tail = segment.slice(-3)
  if (tail.length === 3) out.push(tail.slice(1))
  return [...new Set(out.filter(candidate => candidate.length >= 2))]
}

/**
 * 按**文档频率**筛出有区分度的检索词（issue #88）——不写词表，用样本量出来。
 *
 * `corpus` 是已知正文（写前预检传全部定稿章）。出现在超过 `maxRatio` 比例章节的
 * 变体被丢掉（「名字」79%、「的名字」58% 这类），留下的才是真正指向那件事的锚点
 * （「撬痕」8%、「指印」16%）。**样本不足时退回整段比对**，不拿小样本的比例下结论。
 */
export function selectDiscriminatingKeywords(
  segments: readonly string[],
  corpus: readonly string[],
  options: { maxRatio?: number; limit?: number; minChapters?: number } = {},
): string[] {
  const maxRatio = options.maxRatio ?? 0.25
  const limit = options.limit ?? 6
  const minChapters = options.minChapters ?? 6
  const total = corpus.length
  if (total < minChapters) {
    // 样本太小：比例没有意义，直接退回整段（与其它判据「样本不足不判」同一口径）。
    return [...new Set(segments)].slice(0, limit)
  }
  const documentFrequency = (candidate: string) =>
    corpus.reduce((count, chapter) => count + (chapter.includes(candidate) ? 1 : 0), 0)
  const candidates: Array<{ variant: string; df: number; fromTail: boolean }> = []
  for (const segment of segments) {
    for (const variant of keywordVariants(segment)) {
      // 「的手势」这类以「的」起头的变体是**残片**（剥定语剥过头），正文里不会有——
      // 留着只会把真正的锚点挤出名额（实测「撬痕」就这样被挤掉过）。
      if (/^[的了与和及并把将被在]$|^[的了]/u.test(variant)) continue
      const df = documentFrequency(variant)
      if (df / total > maxRatio) continue
      candidates.push({ variant, df, fromTail: variant !== segment })
    }
  }
  // 排序（issue #88 实测教训，顺序很关键）：
  //   ① **先分「活词 / 死词」**——df=0 的变体在全样本里从未出现，留它做检索键**永远不可能命中**，
  //      只配当兜底；真正可能命中的是 df>0 的。
  //   ② 活词里 **df 越低越有区分度**（「撬痕」3/38 指向那件事，「那句」6/38 就不太行）→ 升序。
  //   ③ 同 df 时**尾部变体优先**（它才是正文会写的中心词，整段短语反而永远命不中）。
  //   ④ 再按长度降序。
  // 只按长度排会把「林棠临别比出的手势」这类整段短语留下、把「撬痕」挤出去 —— 上一版就是这么错的。
  return [...new Map(candidates.map(item => [item.variant, item])).values()]
    .sort((left, right) => Number(left.df === 0) - Number(right.df === 0)
      || left.df - right.df
      || Number(right.fromTail) - Number(left.fromTail)
      || right.variant.length - left.variant.length)
    .slice(0, limit)
    .map(item => item.variant)
}

/**
 * 把「指向目标章的远期承诺」渲染成一段可直接进提示词的文字（issue #68）。
 *
 * 措辞刻意区分「承诺」与「必须」：这些是作者（或模型）之前写下的**打算**，
 * 不是本章的强制事件。定稿正文才是权威——若正文已经用别的方式兑现或明确搁置，
 * 本章该说明而不是硬塞。这个区分很重要：把远期承诺写成硬约束，会让后期章节
 * 被十几章前的旧计划绑住，而作者已经改主意了。
 */
export function renderForeshadowingDue(input: {
  commitments: readonly ForeshadowingCommitment[]
  targetChapter: number
  language: 'zh-CN' | 'en-US'
}): string {
  if (input.commitments.length === 0) return ''
  const lines = input.commitments.map(commitment => input.language === 'en-US'
    ? `- planted in chapter ${commitment.plantsAt}: ${commitment.text}`
    : `- 第 ${commitment.plantsAt} 章埋下：${commitment.text}`)
  const header = input.language === 'en-US'
    ? [
        `[Earlier chapters promised this one (issue #68)]`,
        `These lines were written in earlier blueprints and name chapter ${input.targetChapter}. Check each one against the finalized prose: realize it in this chapter, explicitly defer it with a reason, or explain how it was already paid off.`,
        `They are earlier intentions, not mandatory events. If the finalized prose already settled the matter another way, say so instead of forcing the old plan back in.`,
      ].join(String.fromCharCode(10))
    : [
        `【早先章节点名本章的承诺（issue #68）】`,
        `下面这些是写在更早蓝图里、且点名了第 ${input.targetChapter} 章的伏笔。逐条对照已定稿正文：在本章兑现它、明确搁置并说明原因、或说明它已经被正文用别的方式了结。`,
        `它们**是早先的打算，不是本章的强制事件**。若定稿正文已经用另一种方式把这件事处理掉了，就照实说明，不要把旧计划硬塞回来。`,
      ].join(String.fromCharCode(10))
  return [header, ...lines].join(String.fromCharCode(10))
}
