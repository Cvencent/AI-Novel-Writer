/**
 * **陈旧状态时长**：同一件事的「过了多久」在相邻章用了两个互斥的尺度（issue #115）。
 *
 * 现象（那本 24 章的书，逐字）：
 *
 *   第 11 章：「柯有顺的**铺位空了三天**，铺盖卷走了，没人问去了哪里。」
 *   第 12 章（开篇第一句就是「**重抄后一个多月**」）：周叙又问任九「柯有顺的**铺空了三天**。」
 *
 * 两处都是**当前状态的陈述**，不是回忆；而两章之间正文自己宣告推进了「一个多月」，
 * 铺位不可能还是「三天」。
 *
 * 为什么现有判据碰不到它（issue 给的两条原因，都成立）：
 *   ① `chapter-time-anchor` 的 `undated` 判的是「**有没有**交代跨日」，不是「交代得**对不对**」——
 *      第 12 章明明白白写着「一个多月」，在这条判据里是**达标**的，恰好躲过检查；
 *   ② 没有任何判据**跨章比对「同一状态的时长表述」**。
 *
 * 判据（**结构性，无词表**）：
 *   1. 抽「**状态历时句**」：`<短名词 1–3 字>` + `<状态动词>` + `了` + `<数量>` + `<日历单位>`。
 *      状态动词与日历单位都是**封闭的功能类**（见下），名词从正文里取、不写词表。
 *   2. 抽「**章级时间推进宣告**」：`<…后/过了/隔了/又过>` + 数量 + 日历单位。
 *   3. 若同一 `<状态动词>了<时长>`（且名词有共享字，判为同一事物）出现在**前后两章**，
 *      而两章之间（含后一章自身）宣告推进的时长**大于**那句声称的时长 → 报「陈旧状态时长」。
 *
 * ⚠️ 边界（本仓 #30/#43/#70/#93 的教训）：
 *   - 日历单位只收 `个月/月/天/日/夜/年`——**刻意不收**「息／盏茶／时辰」这类**短单位**：
 *     它们在同章内反复出现（「过了两息」），收进来会误报（#84 的同一收窄）。
 *   - 数值下限：声称时长必须 ≥ `STALE_DURATION_MIN_DAYS`（1 天）——「空了一瞬」不算，
 *     那种状态本来就允许在同一天内重复出现。
 *   - 只比**相邻/近邻**（`STALE_DURATION_WINDOW` 章之内）：隔了十几章再说「空了三天」
 *     可能是新的一件事（铺位又空了），不是矛盾。
 */

/** 状态动词（**封闭的功能类**：表示「某物处于某种停滞状态」），不是题材词表。 */
export const STATE_VERBS = Object.freeze(['空', '关', '停', '搁', '歇', '断'] as const)

/**
 * 日历单位（**封闭的功能类**）。
 * ⚠️ 刻意不收「息／盏茶／时辰／刻」这类**短单位**：同章内大量出现（「过了两息」），
 * 收进来会把同一天内的正常叙述判成「时间推进」。
 */
export const CALENDAR_UNITS = Object.freeze(['个多月', '个月', '天', '日', '夜', '年'] as const)

/** 声称时长（天）低于它就不判：一天以内的状态本来允许同章重复。 */
export const STALE_DURATION_MIN_DAYS = 1
/** 只比近邻这么多章内的两次陈述（更远的可能是新的一件事）。 */
export const STALE_DURATION_WINDOW = 3

const NUMBER_CHARS = '一二两三四五六七八九十百半零'

export interface StateDurationStatement {
  chapterNumber: number
  /** 状态短语原文（如「铺位空了三天」）。 */
  phrase: string
  /** 状态动词（封闭类成员）。 */
  verb: string
  /** 状态前紧邻的名词核心（1–3 字，用于判「同一事物」）。 */
  subject: string
  /** 声称的状态时长（天）。 */
  claimedDays: number
  /** 时长原文（如「三天」）。 */
  durationText: string
}

/** 数值字面量 → 数字（只处理中文小说里常见的写法）。 */
function numericValue(raw: string): number {
  if (/^\d+$/u.test(raw)) return Number(raw)
  const table: Record<string, number> = {
    零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
    十: 10, 半: 0.5, 百: 100,
  }
  if (!raw) return 0
  // 「十二」→12、「二十」→20、「二十三」→23、「半」→0.5
  if (raw === '半') return 0.5
  if (raw.includes('百')) {
    const [hundreds, rest] = raw.split('百')
    return (table[hundreds!] ?? 1) * 100 + (rest ? numericValue(rest) : 0)
  }
  if (raw.includes('十')) {
    const [tens, ones] = raw.split('十')
    const tensValue = tens === '' ? 1 : (table[tens!] ?? 0)
    return tensValue * 10 + (ones ? (table[ones!] ?? 0) : 0)
  }
  return table[raw] ?? 0
}

/** 日历单位 → 天（近似；月取 30、年取 365——判的只是「量级明显更大」）。 */
export function calendarUnitToDays(unit: string): number {
  if (unit.includes('月')) return 30
  if (unit.includes('年')) return 365
  return 1
}

function numericLiteral(): string {
  const escaped = [...NUMBER_CHARS].join('')
  return `[0-9${escaped}]+`
}

/**
 * 抽一章里的「状态历时句」（issue #115）。
 *
 * 形态：`<名词 1–3 字>` + `<状态动词>` + `了` + `<数量>` + `<日历单位>`。
 * 名词从正文取（不写词表）；状态动词与单位是封闭功能类。
 */
export function stateDurationStatements(chapterNumber: number, content: string): StateDurationStatement[] {
  const text = String(content ?? '')
  const verbs = STATE_VERBS.join('')
  const units = [...CALENDAR_UNITS].sort((left, right) => right.length - left.length).join('|')
  const number = numericLiteral()
  const pattern = new RegExp(`([\\u4e00-\\u9fff]{1,3})[${verbs}]了(${number})(${units})`, 'gu')
  const out: StateDurationStatement[] = []
  for (const match of text.matchAll(pattern)) {
    const subject = match[1]!.replace(/^的/u, '')
    const verb = match[0].charAt(match[1]!.length)
    const durationText = `${match[2]!}${match[3]!}`
    const claimedDays = numericValue(match[2]!) * calendarUnitToDays(match[3]!)
    if (!subject || claimedDays < STALE_DURATION_MIN_DAYS) continue
    out.push({
      chapterNumber, phrase: `${subject}${verb}了${durationText}`,
      verb, subject, claimedDays, durationText,
    })
  }
  return out
}

/**
 * 抽一章里宣告的「时间推进」（章级）：`<…后/过了/隔了/又过>` + 数量 + 日历单位 → 天数。
 *
 * 返回该章宣告的**最大**推进量（一章通常只有一处）。
 */
export function declaredTimeAdvanceDays(content: string): number {
  const text = String(content ?? '')
  const units = [...CALENDAR_UNITS].sort((left, right) => right.length - left.length).join('|')
  const number = numericLiteral()
  const pattern = new RegExp(`(?:后|之后|过后|过了|隔了|又过)(${number})(${units})`, 'gu')
  let max = 0
  for (const match of text.matchAll(pattern)) {
    max = Math.max(max, numericValue(match[1]!) * calendarUnitToDays(match[2]!))
  }
  return max
}

export interface StaleDurationHit {
  /** 同一事物的两次陈述。 */
  earlier: StateDurationStatement
  later: StateDurationStatement
  /** 两章之间正文宣告推进的天数。 */
  advancedDays: number
}

/** 抽「状态历时句」与章级时间推进 → 判「陈旧状态时长」。 */
export function findStaleStateDurations(
  chapters: readonly { chapterNumber: number; content: string }[],
): StaleDurationHit[] {
  const usable = chapters
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
  const statements = usable.flatMap(chapter => stateDurationStatements(chapter.chapterNumber, chapter.content))
  if (statements.length === 0) return []
  const advanceByChapter = new Map(usable.map(chapter => [chapter.chapterNumber, declaredTimeAdvanceDays(chapter.content)]))
  const hits: StaleDurationHit[] = []
  for (let index = 0; index < statements.length; index += 1) {
    const later = statements[index]!
    for (let back = index - 1; back >= 0; back -= 1) {
      const earlier = statements[back]!
      if (later.chapterNumber - earlier.chapterNumber > STALE_DURATION_WINDOW) break
      // 同一件事：状态动词相同、声称时长**逐字相同**（是「照抄上一次的说法」，不是另一次状态）。
      if (earlier.verb !== later.verb || earlier.durationText !== later.durationText) continue
      // 名词须有共享汉字（「铺位」与「铺」共享「铺」）——同一事物，不是两个不同的东西。
      const shared = [...earlier.subject].some(character => later.subject.includes(character))
      if (!shared) continue
      // 两章之间宣告推进的天数（含后一章自身）大于那句声称的时长 → 陈旧。
      let advanced = 0
      for (let chapter = earlier.chapterNumber + 1; chapter <= later.chapterNumber; chapter += 1) {
        advanced = Math.max(advanced, advanceByChapter.get(chapter) ?? 0)
      }
      if (advanced > earlier.claimedDays) hits.push({ earlier, later, advancedDays: advanced })
    }
  }
  return hits
}

/** 陈旧状态时长 → 一致性发现（issue #115）。 */
export function findStaleStateDurationFindings(
  chapters: ReadonlyArray<{ chapterNumber: number; content: string }>,
): Array<{
  stableFactKey: string
  severity: 'warning'
  sourceChapter: number
  evidence: string
  issue: { zhCN: string; enUS: string }
  suggestion: { zhCN: string; enUS: string }
}> {
  return findStaleStateDurations(chapters).map(hit => ({
    // key 锚在「哪个状态短语陈旧了」上、**不带章号**（#86/#89/#98/#108/#111 的教训：
    // 带章号的 key 会随章滚动，作者点「我已知」永远关不掉）。锚「最早陈述」的章号作区分。
    stableFactKey: `chapter-time:stale-duration:${hit.earlier.subject}:${hit.earlier.chapterNumber}`,
    severity: 'warning' as const,
    sourceChapter: hit.earlier.chapterNumber,
    evidence: `第 ${hit.earlier.chapterNumber} 章「${hit.earlier.phrase}」→ 第 ${hit.later.chapterNumber} 章仍说「${hit.later.phrase}」，`
      + `而两章之间正文自己宣告推进了 ${hit.advancedDays} 天（> 声称的 ${hit.earlier.claimedDays} 天）`,
    issue: {
      zhCN: `第 ${hit.earlier.chapterNumber} 章说「${hit.earlier.phrase}」，第 ${hit.later.chapterNumber} 章**过了 ${hit.advancedDays} 天**之后仍在说「${hit.later.phrase}」——同一件事的用时在两个章节里用了互斥的尺度。两处都是**当前状态的陈述**（不是「我记得当时…」的回忆），所以读者会先以为自己漏读了一段，回头翻又找不到，然后对「到底过了多久」失去判断。如果这本书的张力来自期限或倒计时，那么这条会直接抽掉它的承重结构。`,
      enUS: `Chapter ${hit.earlier.chapterNumber} says “${hit.earlier.phrase}”, and chapter ${hit.later.chapterNumber} — after the text itself advances ${hit.advancedDays} days — still says “${hit.later.phrase}”. The same state is measured on two mutually exclusive scales. Both are present-tense statements rather than reminiscences, so readers will first assume they missed a passage, go back, fail to find it, and stop trusting any duration the book gives; if the tension rests on a deadline or countdown, this removes its load-bearing wall.`,
    },
    suggestion: {
      zhCN: `二选一：①把后一处**改成推进后的时长**（「铺空了${hit.advancedDays}天」或不提天数，只写状态）；②如果那件事确实没变（比如铺位一直没人问），就把**中间那段时间在正文里交代掉**——写明这段时间里没有发生过任何与此有关的事，让「还是三天前那个状态」在书里说得通。改法要落到正文，不要只在预检弹层里点「继续」。`,
      enUS: `Pick one: (1) update the later mention to the advanced duration (or drop the day count and state only the condition); (2) if the state really did not change (say nobody ever asked about the bunk), account for the intervening time on the page — show that nothing related happened in it, so “unchanged since three days ago” is coherent. Either way it must land in the prose, not just a click-through on the preflight notice.`,
    },
  }))
}