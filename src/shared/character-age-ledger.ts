/**
 * 正文层的人物年龄账本（issue #149）。
 *
 * 现场（常驻测试书 69 章）：
 *
 *   ch64  铁链后头挤出个人，**女的**……温珩……把**女人**往身后挪了半步。
 *   ch65  邵广海按成年人程序处置：「黑户。按规矩该送走。」
 *   ch68  （周叙）那一年**她七岁**。没有户籍。
 *   处置单：徐汐按无籍遣送。
 *
 * 她是「七岁上船」，而第 7/54/55 章把沉船钉在**三年前**——到 ch64 应当是十岁上下。
 * 但第 64 章把她写成「女人」、第 65 章按成年人程序处置，前后没有任何一处报出矛盾。
 *
 * ## 为什么这确实是机制缺口（而不是「模型写歪了」）
 *
 * 全仓此前**只有** `character-age.ts` 碰过「岁」，而它解析的是**角色卡**的 `age` 字段；
 * 正文层 0 处读取。更要紧的是：这个角色**连角色卡都没有**（`characters` 表 7 行不含徐汐），
 * 所以连「拿卡里的年龄去对」这条路也走不到——「她多大」这件事全系统没有任何一处存着。
 *
 * ## 本模块能做与刻意不做
 *
 * 做两件事：
 * 1. **读**：把正文里的年龄声明抽出来（封闭形态：「数字 + 岁/周岁」），归属只在**可判定**时给出
 *    （同一句里出现**唯一**一个在册人名）；
 * 2. **报**：一章里出现了年龄声明，却**一处都归不到在册角色**——也就是「这条年龄没有任何
 *    落点，日后无从对账」。这正是 issue 的「没有任何一处存它做对账」在读得到的那一端。
 *
 * ⚠️ 刻意**不做**「代词主语的核心指」：实测两处真年龄声明都是**代词主语**
 * （「那一年**她**七岁」、台词里的「**她**哥要……送她出港——七岁」），没有名字。
 * 要归到「徐汐」需要跨句指代消解，而本仓没有那一层；猜错会把年龄记到别人头上，
 * 比不记更糟（与 #144 的教训同一条：**归属判不准的判据不许交付**）。
 * 所以代词主语的那一类**只记下来、不归属**，等日后有了点名写法再一并比。
 *
 * ⚠️ 也**不做**「女人 / 妇人 这类称谓 vs 儿童年龄」的冲突比对：那同样要求把称谓与年龄
 * 归到同一个人，而实测 ch64 的「女人」与 ch68 的「七岁」分别落在两章、都是无名的局部指代。
 * 硬判会产出无法定位的提醒。这一档留待指代消解；本轮把**能对账的那一半**先落地。
 */
import type { ConsistencyFinding } from './consistency-preflight'

/** 年龄声明的形态（封闭语法）：数字 + 「岁」/「周岁」。 */
const AGE_TOKEN = /([零一二两三四五六七八九十百\d]{1,3})\s*(?:周)?岁/gu
/**
 * **人称**代词（封闭语法类）：用来判断这一小句是不是在说人，而不是说物件/年份。
 *
 * ⚠️ 只收真正的人称代词。「自己/对方/人家」看起来像，但它们同样可以指物
 * （「这坛酒自己三十岁」这种写法少见，但「这棵树立在自己院里」很常见）；
 * 指示词「这/那」更不行——实测第一版把它们算进去，于是「这坛酒三十岁」被判成人物年龄。
 */
const PERSON_PRONOUN = /(?:他们|她们|我们|你们|他|她|我|你)/u

/** 明确的「人」的指称（在判断是否在说人时与代词同权）。 */
const PERSON_NOUN = /(?:孩子|小孩|男孩|女孩|少年|少女|丫头|男童|女童|婴儿|男孩儿)/u

const CHINESE_DIGITS: Readonly<Record<string, number>> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}

/** 「二十三」这类纯位数中文数 → 数字（与 `character-age.ts` 同一口径，但独立实现以免耦合）。 */
function numberOf(token: string): number | null {
  if (/^\d+$/u.test(token)) return Number(token)
  if (token === '十') return 10
  if (/^十/u.test(token)) {
    const ones = CHINESE_DIGITS[token.slice(1)]
    return ones === undefined ? null : 10 + ones
  }
  const tenIndex = token.indexOf('十')
  if (tenIndex === -1) return CHINESE_DIGITS[token] ?? null
  const tens = CHINESE_DIGITS[token.slice(0, tenIndex)]
  const rest = token.slice(tenIndex + 1)
  const ones = rest ? CHINESE_DIGITS[rest] : 0
  if (tens === undefined || ones === undefined) return null
  return tens * 10 + ones
}

export interface ProseAgeStatement {
  chapterNumber: number
  /** 声明所在的那一句（证据引用，截断到 60 字）。 */
  sentence: string
  /** 读出来的岁数。 */
  age: number
  /** 这一处年龄所属的在册角色；归不定时为 null。 */
  attributedTo: string | null
}

/** 切句（与其它判据同一口径：句末标点与换行）。 */
function sentencesOf(content: string): string[] {
  return String(content ?? '')
    .split(/(?<=[。！？])|\n+/u)
    .map(sentence => sentence.trim())
    .filter(Boolean)
}

/**
 * 分句（比切句更细）：按逗号类停顿切开。
 *
 * ⚠️ 归属必须在小句范围内判（issue #149 实测踩到的坑）：ch69 那一句是
 * 「她哥要赶在**邵广海**把这孩子弄走之前送她出港——**七岁**。」
 * 整句里出现的唯一在册人名是邵广海，而「七岁」说的是「她」。按整句归属会把
 * **年龄记到一个错误的人头上**——那不是漏报，是写错了账本，比不记更糟。
 */
function clausesOf(sentence: string): string[] {
  return sentence.split(/[，,、；;：:—–]/u).map(clause => clause.trim()).filter(Boolean)
}

/**
 * 抽出**人物**的年龄声明（issue #149）。
 *
 * 三条收窄，都是为了不把物件/年份的「岁」当成人物年龄：
 * - 所在小句里要有人称代词或**在册人名**（否则「这坛酒三十岁」这类描述会被算进去）；
 * - 岁数落在 1–120（筛掉「万岁」「千岁」这类夸张与编号）；
 * - 归属只在**同一个小句**里恰好一个人称代词/在册人名、且其中含**在册人名**时给出；
 *   只有代词没有名字 → `attributedTo: null`（判不了，如实记下来）。
 */
export function proseAgeStatements(
  chapterNumber: number,
  content: string,
  castNames: readonly string[],
): ProseAgeStatement[] {
  const names = castNames.map(name => String(name ?? '').trim()).filter(Boolean)
  const statements: ProseAgeStatement[] = []
  for (const sentence of sentencesOf(content)) {
    const clauses = clausesOf(sentence)
    // ⚠️ 两层判断，范围不同（issue #149 实测踩出来的）：
    // - 「是不是在说人」用**整句**：年龄记号常自己占一个小句（「——七岁。」），
    //   主语在别的小句里（「她哥要……送她出港」）——按小句判会把这一处整个漏掉；
    // - 「记在谁头上」用**小句**：小句里出现的人名可能是旁及对象（ch69 的邵广海），
    //   按整句归属会把年龄记错人。
    const sentenceAboutPerson = PERSON_PRONOUN.test(sentence) || PERSON_NOUN.test(sentence)
      || names.some(name => sentence.includes(name))
    if (!sentenceAboutPerson) continue
    for (const [index, clause] of clauses.entries()) {
      const ages: number[] = []
      for (const match of clause.matchAll(new RegExp(AGE_TOKEN.source, 'gu'))) {
        const value = numberOf(match[1]!)
        if (value !== null && value >= 1 && value <= 120) ages.push(value)
      }
      if (ages.length === 0) continue
      const named = names.filter(name => clause.includes(name))
      // 只在这一个「年龄小句」自己不带主语时，才回看邻句取主语；
      // 带主语时就看自己（避免把「周叙看着她，她七岁」判成两个人）。
      let attributedTo: string | null = named.length === 1 ? named[0]! : null
      const hasOwnSubject = PERSON_PRONOUN.test(clause) || PERSON_NOUN.test(clause) || named.length > 0
      if (!hasOwnSubject) {
        for (const back of [1, 2]) {
          const previous = clauses[index - back]
          if (!previous) break
          // ⚠️ 邻句里**有人称代词**时，主语是那个人（「她哥要赶在邵广海…之前送她出港——七岁」），
          // 句中的邵广海只是旁及对象。这种情况**不归属**（回看取到的是错的人）。
          if (PERSON_PRONOUN.test(previous)) break
          const previousNamed = names.filter(name => previous.includes(name))
          if (previousNamed.length === 1) { attributedTo = previousNamed[0]!; break }
          if (previousNamed.length > 1) { attributedTo = null; break }
        }
      }
      // 同一小句里既有人名又有代词（「周叙看着她七岁」这种写法）→ 代词可能指别人，判不准就不归属。
      if (PERSON_PRONOUN.test(clause) && named.length > 0) {
        const otherNamed = names.filter(name => sentence.includes(name) && !clause.includes(name))
        if (otherNamed.length > 0) attributedTo = null
      }
      for (const age of ages) {
        statements.push({
          chapterNumber,
          sentence: sentence.length > 60 ? `${sentence.slice(0, 60)}…` : sentence,
          age,
          attributedTo,
        })
      }
    }
  }
  return statements
}

export interface AgeReconcileChapter {
  chapterNumber: number
  content: string
}

/**
 * 「正文写了年龄，却一处都归不到在册角色」→ 一致性发现（issue #149）。
 *
 * 判据只问一件事：这一章的年龄声明，有没有**任何一处**能落到一个在册角色身上。
 * 一处都落不上，说明这条年龄在系统里没有任何落点——日后所有「她多大」的对账都无从做起。
 *
 * ⚠️ 判据按**章**报一条（把该章所有归不上的声明列在证据里），不按句报：
 * 一次「这章有三处年龄都归不上」比三条重复的提醒更容易让作者动手。
 */
export function findUnreconcilableAgeFindings(
  chapters: readonly AgeReconcileChapter[],
  castNames: readonly string[],
): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = []
  // 没有名册就不判：归属的唯一依据是名册，缺了它每条年龄都「归不上」——
  // 那会变成对每一本有年龄描写的书都刷一条噪声（与 #107「整类跳过」同一考虑）。
  const roster = castNames.map(name => String(name ?? '').trim()).filter(Boolean)
  if (roster.length === 0) return findings
  for (const chapter of [...chapters].sort((left, right) => left.chapterNumber - right.chapterNumber)) {
    const statements = proseAgeStatements(chapter.chapterNumber, chapter.content, roster)
    if (statements.length === 0) continue
    const attributed = statements.filter(statement => statement.attributedTo !== null)
    if (attributed.length > 0) continue
    const quotes = statements.map(statement => `「${statement.sentence}」`).join('、')
    findings.push({
      // 章号是既成事实，不随写作推进而变（#86/#89/#98/#108）。
      stableFactKey: `character-age:unreconcilable:${chapter.chapterNumber}`,
      severity: 'warning' as const,
      sourceChapter: chapter.chapterNumber,
      evidence: `第${chapter.chapterNumber}章写了年龄（${quotes}），但这些句子都没有点名在册角色，年龄归不到任何人`,
      issue: {
        // ⚠️ 不写「她」/「他」（issue #217）：判据只知道这些句子**没有点名在册角色**，
        // 并不知道那个人是谁、是男是女——写死一个代词就是在替作者认人。
        zhCN: `本章给出了年龄（${quotes}），可这些句子用的是人称代词而不是某个在册角色的名字，所以这条年龄**没有任何落点**：角色卡里没有它，事实账本里也没有它。等后面再写这个人时，程序——以及作者自己——都无从知道其年龄，也就无从发现「前文当成孩子、后文按成年人处置」这类矛盾。`,
        enUS: `This chapter states an age (${quotes}), but these sentences use a personal pronoun rather than naming a carded character, so the age lands nowhere: it is not in any character card nor in the fact ledger. When this person appears again, neither the program nor the author has any recorded age to check against — so "written as a child earlier, handled as an adult later" cannot be caught.`,
      },
      suggestion: {
        zhCN: `二选一：① 在这一句里点名（「那一年徐汐七岁」），并把年龄写进该角色的卡里——名字 + 年龄是最小的对账依据；② 若这个人还不需要建卡，就把年龄改成不依赖它也能读懂的写法（「那一年还不到腰高」），别留下一个没有归属的数字。`,
        enUS: `Either name the person in that sentence ("that year Xu Xi was seven") and record the age on their character card — a name plus an age is the minimum basis for checking later — or, if the character does not need a card yet, rewrite the age so it does not leave an unattributed number behind.`,
      },
    })
  }
  return findings
}