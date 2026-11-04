/**
 * 量具读数与换算的一致性（issue #136）。
 *
 * 现场：全书把「吃水线沉多少」当成主角唯一能凭肉眼核出「多载一人」的物理装置。
 * 第 1 章给出**唯一一次**换算——「往水里沉了**半指**。半指，多一个人。」（即 2 人/指）；
 * 第 59 章同一艘船「比空载时沉出**一指**」，而票是 **32 张**（即 32 人/指）；
 * 第 18 章正文又自造了「**三指**」。三个数差一个数量级，而设定层（世界观）只有定性的
 * 「船每夜多吃一个人的分量，龙骨下沉的刻度可以用肉眼核出来」——**没有刻度单位，
 * 也没有「一指等于几人」**。
 *
 * 所以这不是「模型违反了设定」，而是**设定本身缺了这张换算表，模型每章自己编一个**。
 * 本模块做的是能机器判的那一半：**把书里写出来的换算抽成表，比一次比值是否唯一**。
 *
 * 判据全部结构性，不写人名/道具/单位以外的词表：
 * 1. 「量具语境」= 同一句里出现封闭的**量具名词**（吃水/水线/刻痕/水尺/刻度/标尺）。
 *    这一条是必须的：`半寸`/`两指宽` 在正文里大量是描述尺寸（伤口、缝、纸边），
 *    不加语境会把它们全抽进来（实测全书 30+ 处「N 指/寸」，加语境后只剩 5 处真读数）。
 * 2. **读数** = 量具语境句里的「数量 + 长度单位」（指/寸/分/尺/拃）。
 * 3. **换算句** = 一个读数后面紧跟「，/：」再跟一个**计数**（「半指，多一个人」）。
 *    这是全书唯一一种把「读数→人数」写死的形式。
 * 4. **同章声明量** = 同一章里的「N 张票」「N 个人/人」。
 *
 * 两条判据：
 * - **A. 换算与同章声明量矛盾**：换算句声明「X 读数 = N 人」，而同章又声明载客 K 人，
 *   且 K 与该读数按换算推出的量差得离谱 → 报。（直接抓 ch1 半指=1 人 vs 32 张票，
 *   以及 ch59 一指 vs 32 张票。）
 * - **B. 两处换算出不同比值**：不同章各自给出「读数 = N 人」，算出的 N/读数 不同 → 报。
 *
 * 刻意不做：判定「哪个读数才对」。本仓没有量具设定表（世界观的「刻度可以用肉眼核出来」
 * 不含单位），所以只报「同一套刻度上的比值不唯一」，让作者决定权威写法——这与 #131
 * 「只报对不上、不替作者选」同一口径。
 */
import type { ConsistencyFinding } from './consistency-preflight'

/** 量具语境（封闭名词类）：同一句里出现它，这一句的「N 指/寸」才算读数。 */
const GAUGE_CONTEXT = /(?:吃水|水线|刻痕|水尺|标尺|刻度)/u

/** 长度单位（封闭类）。刻意不收「拃」以外的方言量词。 */
const LENGTH_UNIT = '(?:指|寸|分|厘|尺)'
const QUANTITY = '[一二两三四五六七八九十百半\\d]+'

const READING = new RegExp(`(${QUANTITY})\\s*(${LENGTH_UNIT})`, 'gu')
/**
 * 换算句：「半指，多一个人」「一指：三十二个人」——读数后紧跟标点再接计数。
 *
 * ⚠️ **捕获**「多/少/差」这个增量标记（issue #139）：`半指，多一个人` 说的是
 * 「比开船前对过的刻痕**多沉**半指 = **多**上来一个人」（增量），不是「半指能装一个人」
 * （绝对容量）。上一版把这个前缀写成可选、却仍拿它去比全章载客总量，于是第 1 章那句
 * 本来正确的换算被误报成「0.5 指 = 1 人 vs 32 人」，而且写每一章都跟着报一次。
 */
const CONVERSION = new RegExp(
  `(${QUANTITY})\\s*(${LENGTH_UNIT})\\s*[，,：:]\\s*(多|少|差)?\\s*(${QUANTITY})\\s*(?:个)?\\s*(?:人|条命)`,
  'u',
)
/**
 * 同章声明量。两种语序都要认：
 * - 量词前置：「三十二张票」「三十二个人」「三十二名乘客」；
 * - **名词前置**：「票三十二张」「人三十二个」——实测那一章用的正是这一种
 *   （「票三十二张。人按说也是三十二个。」），只认前置会整章抽不到载客量。
 */
// ⚠️ 模板串里的 `\s` **必须写双反斜杠**（issue #141）：单反斜杠在模板字符串里
// 不是转义序列，`\s` 会退化成字母 `s`，正则就变成「允许 0 个或多个字母 s」。
// 中文文本里数字与量词之间本来就没有字母 s，所以这种错误**不会报错、在无空格文本上
// 结果还对**——只在「三十二 个人」这类带空格的写法上静默漏匹配。
// 结构性测试 `no-invalid-regex-escape.test.ts` 守这一类。
const HEADCOUNT_POSTFIX = new RegExp(`(${QUANTITY})\\s*(?:张票|个人|名乘客)`, 'gu')
const HEADCOUNT_PREFIX = new RegExp(`(?:票|人)\\s*(${QUANTITY})\\s*(?:张|个|名)`, 'gu')

const NUMERALS: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5,
}

function numeralOf(value: string): number | null {
  if (/^\d+$/u.test(value)) return Number(value)
  if (value.length === 1) return NUMERALS[value] ?? null
  const match = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/u.exec(value)
  if (!match) return null
  return (match[1] ? NUMERALS[match[1]]! : 1) * 10 + (match[2] ? NUMERALS[match[2]]! : 0)
}

/**
 * 单位不同不能直接比数值：`半寸` 与 `半指` 是两把尺子。
 * 这里只把同一单位族内的读数拿来比——指↔指、寸↔寸、尺↔尺。
 * （不换算指/寸的比例：本仓没有权威换算，硬编码一个比例等于替作者定设定。）
 */
function unitFamily(unit: string): string { return unit === '厘' ? '分' : unit }

export interface GaugeChapter {
  chapterNumber: number
  content: string
}

interface Conversion {
  chapterNumber: number
  reading: number
  unit: string
  people: number
  /** 「多/少/差」开头的**增量**换算（比基准多/少 N 人），不是绝对容量。 */
  incremental: boolean
  sentence: string
}

interface Reading {
  chapterNumber: number
  reading: number
  unit: string
  sentence: string
}

function sentencesOf(content: string): string[] {
  return String(content ?? '')
    .split(/(?<=[。！？])|\n+/u)
    .map(sentence => sentence.trim())
    .filter(Boolean)
}

/** 抽「量具语境句」里的读数，以及其中的换算句。 */
function gaugeEvidence(chapters: readonly GaugeChapter[]): { readings: Reading[]; conversions: Conversion[] } {
  const readings: Reading[] = []
  const conversions: Conversion[] = []
  for (const chapter of chapters) {
    const sentences = sentencesOf(chapter.content)
    for (const [index, sentence] of sentences.entries()) {
      // 判据 1：整句必须落在量具语境里，否则「半寸」这类尺寸描写会混进来。
      // ⚠️ 语境可以来自**前一句**：换算句本身常常只写「半指，多一个人。」，
      // 而「吃水线的刻痕……沉了半指」在前一句（实测 ch1 正是这个形态）。
      const contextual = GAUGE_CONTEXT.test(sentence)
        || (index > 0 && GAUGE_CONTEXT.test(sentences[index - 1]!)
          && new RegExp(`^${QUANTITY}\\s*${LENGTH_UNIT}`, 'u').test(sentence))
      if (!contextual) continue
      const found: Reading[] = []
      for (const match of sentence.matchAll(READING)) {
        const reading = numeralOf(match[1]!)
        if (reading === null || reading <= 0) continue
        found.push({ chapterNumber: chapter.chapterNumber, reading, unit: unitFamily(match[2]!), sentence })
      }
      if (found.length === 0) continue
      readings.push(...found)
      const conversion = CONVERSION.exec(sentence)
      const people = conversion ? numeralOf(conversion[4]!) : null
      if (!conversion || people === null || people <= 0) continue
      const reading = numeralOf(conversion[1]!)
      if (reading === null || reading <= 0) continue
      conversions.push({ chapterNumber: chapter.chapterNumber, reading, unit: unitFamily(conversion[2]!),
        people, incremental: Boolean(conversion[3]), sentence })
    }
  }
  return { readings, conversions }
}

/** 同章声明的载客量（「三十二张票」「三十二个人」），取该章出现次数最多的那个值。 */
function headcountOf(chapter: GaugeChapter): number | null {
  const counts = new Map<number, number>()
  const content = String(chapter.content ?? '')
  for (const pattern of [HEADCOUNT_POSTFIX, HEADCOUNT_PREFIX]) {
    for (const match of content.matchAll(pattern)) {
      const value = numeralOf(match[1]!)
      if (value === null || value < 2) continue
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }
  }
  if (counts.size === 0) return null
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || right[0] - left[0])[0]![0]
}

/**
 * 量具换算的两条一致性判据。
 *
 * `minPeopleGap`：换算推出的量与该章声明载客量相差多少倍才报。默认 2——一本书里
 * 「多一个人」与「按 32 张票算」之间本来就有一层「多出来的那一个」，留一倍余量，
 * 只抓数量级级别的矛盾（ch1 的 2 人 vs 32 张票 = 16 倍，ch59 的 1 指 vs 32 人）。
 */
export function findGaugeScaleMismatches(
  chapters: readonly GaugeChapter[],
  options: { minPeopleGap?: number } = {},
): ConsistencyFinding[] {
  const minPeopleGap = options.minPeopleGap ?? 2
  const ordered = [...chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
  const { readings, conversions } = gaugeEvidence(ordered)
  const findings: ConsistencyFinding[] = []

  // A. 换算与该章声明载客量矛盾（同一章里自己打自己）。
  //
  // ⚠️ **增量换算是另一回事**（issue #139）：「半指，多一个人」说的是
  // 「比基准多沉半指 = 多上来一个人」，与「全船坐了 32 人」并不矛盾——
  // 拿它跟总量比会把第 1 章那句正确的换算永久误报（写每一章都报一次）。
  // 增量句只与「本章人数相对票面的变化」有关，而 finding 文案是静态的、
  // 拿不到那个变化量，所以这一支**不判**（宁可漏，不可误报）。
  for (const conversion of conversions) {
    if (conversion.incremental) continue
    const chapter = ordered.find(item => item.chapterNumber === conversion.chapterNumber)!
    const declared = headcountOf(chapter)
    if (declared === null) continue
    // 换算声明「X 读数 = N 人」；该章又说载客 K 人。若 K 远大于「这套刻度能盛的量」，
    // 说明同一句刻度被当成两种容量在用。
    const impliedPeople = conversion.people
    if (declared <= impliedPeople * minPeopleGap) continue
    findings.push({
      stableFactKey: `gauge:scale:${conversion.chapterNumber}`,
      severity: 'warning' as const,
      sourceChapter: conversion.chapterNumber,
      evidence: `第${conversion.chapterNumber}章：「${conversion.sentence.slice(0, 60)}」——按这句换算，${conversion.reading}${conversion.unit || ''}只对应 ${impliedPeople} 人；同章又写载客 ${declared} 人`,
      issue: {
        zhCN: `量具的换算与同章的载客量差了一个数量级：这里说「${conversion.reading}${conversion.unit || ''} = ${impliedPeople} 人」，而同章写的是 ${declared} 人。同一套刻度被当成两种容量在用，读者按哪一句算都不对。`,
        enUS: `The gauge conversion and this chapter's own headcount differ by an order of magnitude: this line says ${conversion.reading}${conversion.unit || ''} equals ${impliedPeople} people, while the same chapter carries ${declared}. The same scale is being used as two different capacities.`,
      },
      suggestion: {
        zhCN: `把换算与载客量对齐：要么改这一句的换算（若 ${declared} 人才是这一读数该代表的数量），要么改读数。这类数字是读者核证据的唯一凭据，差一次之后他就不再核第二次。`,
        enUS: `Align the conversion with the headcount: either change what this line claims the reading means (if ${declared} is the right figure for it), or change the reading itself. Readers use this number to check the evidence, and one mismatch teaches them to stop checking.`,
      },
    })
  }

  // B. 不同章对同一量具给出互斥的比值（比值 = 人/读数，同单位族内比较）。
  //
  // 比值有两个来源，缺一个就抓不到 issue 的核心形态：
  // ① 显式换算句（「半指，多一个人」）→ 人/读数 = 1/0.5 = 2；
  // ② **读数 + 同章声明载客量**（「比空载时沉出一指」+「票三十二张」）→ 32/1 = 32。
  //    ch59 正是第 ② 种，没有「读数，N 人」的句式——只比 ① 会漏掉它。
  // 同单位族内推出来的比值必须一致，否则读者算不出「今晚多没多人」。
  // 比值 = 人/读数，只有**绝对容量**才有意义；增量句（「多一个人」）混进来会把
  // 第 1 章算成 2 人/指、第 59 章 32 人/指，从而报出一条假的「比值不唯一」（issue #139）。
  // ⚠️ 还要排掉「读数本身是增量」的章（issue #139 的第二层）：第 1 章那句
  // 「往水里沉了半指」与紧邻的增量换算「半指，多一个人」是**同一处读数**，
  // 它表示的是「比基准多沉半指」这个差值，不是容量。把差值与全章载客量相除
  // （32 / 0.5 = 64 人/指）仍是同一类错，只是换了个出口。
  // 判据：该章有增量换算、且读数与该换算的读数相同（同单位族）→ 这处读数也不参与比值。
  const incrementalReadings = new Set(conversions
    .filter(item => item.incremental)
    .map(item => `${item.chapterNumber}|${item.unit}|${item.reading}`))
  const derived: Conversion[] = conversions.filter(item => !item.incremental)
    .filter(item => !incrementalReadings.has(`${item.chapterNumber}|${item.unit}|${item.reading}`))
  for (const reading of readings) {
    // 这句本身就是换算句时跳过（已收进 conversions，避免重复计入）。
    if (conversions.some(item => item.chapterNumber === reading.chapterNumber && item.sentence === reading.sentence
      && item.unit === reading.unit)) continue
    const chapter = ordered.find(item => item.chapterNumber === reading.chapterNumber)
    if (!chapter) continue
    const declared = headcountOf(chapter)
    if (declared === null || declared < 2) continue
    if (incrementalReadings.has(`${reading.chapterNumber}|${reading.unit}|${reading.reading}`)) continue
    derived.push({ chapterNumber: reading.chapterNumber, reading: reading.reading, unit: reading.unit,
      people: declared, incremental: false, sentence: reading.sentence })
  }
  // 同一章、同一单位族里只留**一个**代表值（优先显式换算句）：同一处读数在正文里
  // 常被复述两次（「沉了半指」+「半指，多一个人」），那不是两套换算。
  const perChapterUnit = new Map<string, Conversion>()
  for (const conversion of derived) {
    const key = `${conversion.chapterNumber}|${conversion.unit}`
    const existing = perChapterUnit.get(key)
    const explicit = (item: Conversion) => conversions.some(candidate =>
      candidate.chapterNumber === item.chapterNumber && candidate.sentence === item.sentence && candidate.unit === item.unit)
    if (!existing || (explicit(conversion) && !explicit(existing))) perChapterUnit.set(key, conversion)
  }
  const byFamily = new Map<string, Conversion[]>()
  for (const conversion of perChapterUnit.values()) {
    const list = byFamily.get(conversion.unit) ?? []
    list.push(conversion)
    byFamily.set(conversion.unit, list)
  }
  for (const [family, list] of byFamily) {
    if (list.length < 2) continue
    const ratios = list.map(item => ({ ...item, ratio: item.people / item.reading }))
    const max = ratios.reduce((left, right) => left.ratio >= right.ratio ? left : right)
    const min = ratios.reduce((left, right) => left.ratio <= right.ratio ? left : right)
    if (min.ratio <= 0 || max.ratio / min.ratio < minPeopleGap) continue
    const [first, second] = [min, max].sort((left, right) => left.chapterNumber - right.chapterNumber)
    findings.push({
      stableFactKey: `gauge:scale-ratio:${family}`,
      severity: 'warning' as const,
      sourceChapter: second!.chapterNumber,
      evidence: `第${first!.chapterNumber}章「${first!.sentence.slice(0, 40)}」= ${first!.ratio} 人/${family}；第${second!.chapterNumber}章「${second!.sentence.slice(0, 40)}」= ${second!.ratio} 人/${family}`,
      issue: {
        zhCN: `同一个量具被写成了两套换算：第 ${first!.chapterNumber} 章是每${family} ${first!.ratio} 人，第 ${second!.chapterNumber} 章是每${family} ${second!.ratio} 人（差 ${(max.ratio / min.ratio).toFixed(1)} 倍）。读者读完就再也算不出「今晚到底多没多人」。`,
        enUS: `The same gauge is defined two ways: ${first!.ratio} people per ${family} in chapter ${first!.chapterNumber} versus ${second!.ratio} per ${family} in chapter ${second!.chapterNumber} (a ${(max.ratio / min.ratio).toFixed(1)}× difference). After that the reader can no longer work out whether the boat is carrying an extra person.`,
      },
      suggestion: {
        zhCN: `定一处权威换算并让全书一致（设定层最好也写一次刻度单位与「一单位对应几人」，起草时作为强约束注入）。若两次读数确实对应不同载客量，就把各自的载客量写出来，让读者能算出同一个比值。`,
        enUS: `Fix one authoritative conversion and keep it consistent (ideally state the scale unit and its per-unit meaning in the settings, and inject it as a hard constraint when drafting). If the two readings really do correspond to different loads, state each load so the same ratio can be derived.`,
      },
    })
  }
  return findings
}