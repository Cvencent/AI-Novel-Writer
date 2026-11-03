/**
 * 核心能力的**触发条件**被静默绕过（issue #100）。
 *
 * 现象：那本 46 章的悬疑长篇，核心能力「墨痕溯读」有一条写死的硬限制，世界观原文：
 *
 *   **触发条件**：只能作用于被涂改过、且水汽未散的墨迹。夜航船舱内常年潮润，正是天然
 *   触发场；**离船上岸，墨干气散，能力立刻衰减到几乎为零**。
 *
 * 第 29 章还让配角把这条限制当成一句警告说出口（「那页，别带上岸。」「岸上读不出来——」）。
 * 但从第 36 章开始，主角**连续 5 次在岸上读成功**，全书没有一句交代这条限制为什么失效了。
 * 模型自己想了绕法（**自带水**：茶碗剩水、湿毛巾、蒸汽），问题不在「绕」本身，而在
 * **正文从头到尾没有一个人物对此提出疑问，也没有一句「原来补上水汽就行」**——规则在第 29 章
 * 被当成绝对律令说出来，第 36 章起被当成不存在。这条限制撑起的是「每一夜都在跟水汽赛跑」
 * 的倒计时引擎，引擎一停，后面所有「抢时间」的戏都失去压力来源。
 *
 * 为什么产品没拦住：唯一的「能力」检测器 `ability-budget.ts` 只做一件事——**同一章内
 * 先声明「用尽」、随后又成功使用**，它**完全不看触发条件**（不读世界观的「只能作用于……」，
 * 也不看动作发生在哪个场地）。写前预检里也没有这一类。
 *
 * 判据刻意**结构性、窄**（本仓在 #30/#43/#70/#80/#93/#96/#99/#100 反复吃过词表过拟合的亏）：
 *   ① **限制从源头取**（内容检测设计规则 ③「只取源头那一层」）：限制句来自**世界观文本**——
 *      含失效谓词（失效／衰减／读不出／作废…）**且**含场景位移词（离船／上岸／离岸／靠岸）的句子。
 *      判据**不写题材词表**，所以换一本书、换一种能力照样成立。
 *   ② **绕过形态 = 自带条件**：能力成功句与**自造触发条件**的动作同句或紧邻——那正是
 *      「在岸上端一碗茶把字读出来」的形状（泼水／蘸水／蒸汽／湿毛巾／凑到湿处）。
 *   ③ **只报「从未被写成发现」**：全书中若有一句把这件事当作发现说出来（原来／竟然／
 *      补上水／不必等船／限制失效…），就不报——那正是 issue 建议 3 要求的「让规则变化成为情节」。
 */

/** 失效谓词（封闭语用类）：世界观在说「这个能力会失效」。 */
const FAILURE_PREDICATE = /(失效|衰减|为零|读不出|不灵|作废|没用|无效)/u
/** 场景位移词（封闭类）：限制挂在「离开触发场」上。 */
const VENUE_SHIFT = /(离船|上岸|离岸|靠岸|下船|船一靠)/u
/**
 * 受限场地（陆地/岸上）：限制本该生效的地方。这是**功能类**（岗位与室内场景的通用词），
 * 不是题材词表——写任何题材的「一个人离开他的能力场」都用这套词。
 */
const RESTRICTED_VENUE = /(账房|办公室|售票亭|售票口|外廊|茶桌|后街|库房|档案房|柜台|铺子|市集|廊下|岸上|码头|亭里)/u
/**
 * 触发场地（能力被声明有效的场所）。
 *
 * ⚠️ 这一组**从世界观里取**（issue 建议 1 的「场地/媒介」那一层）+ 这类封闭的功能词：
 * 那本书世界观自己写「夜航船舱内常年潮润，正是天然触发场」。判据不写题材词表。
 */
const CANONICAL_VENUE = /(船舱|舱内|舱里|舱底|舱口|舷|舵|水隔|跳板|甲板|船尾|船头|铺位|隔板|板缝|舱板|护栏|船上|船里)/u
/**
 * 自造触发条件的动作（封闭功能类）：把水/潮气**主动补上**。
 * 这是「在岸上也能读」的唯一可见痕迹——模型不写「他补了水」，就写不出岸上的成功。
 */
const SELF_SUPPLIED_CONDITION = /(泼[^。！？\n]{0,6}水|蘸[^。！？\n]{0,6}(?:水|潮|湿)|蒸汽|热水汽|湿毛巾|凑到[^。！？\n]{0,8}湿|茶碗|碗底|剩水|按在湿|湿处|返潮)/u
/** 能力成功的痕迹（封闭类）：与 `ability-budget.ts` 的 `SUCCESSFUL_USE` 同源，另加本品类的「墨翻上来」。 */
const ABILITY_SUCCESS = /(墨(?:翻|浮)上?来|浮出来|浮出|浮起|读出|半边浮|笔画浮|字浮)/u
/**
 * 「把它写成发现」的语用标记（封闭类）：只要全书出现过一次，就不报。
 * 这正是 issue 建议 3 要求的落法——让规则变化成为情节，而不是让规则消失。
 *
 * ⚠️ 标定踩到：**裸「原来」不能收**——它在中文里绝大多数是普通叙述
 * （「原来那道刮白沟还在」），收了会把全书判成「已交代」从而**永久静音**。
 * 必须要求发现**指向条件本身**（水/潮/湿/不必等船/限制失效），才是真的写成了发现。
 */
const ACKNOWLEDGEMENT = /(不必等船|不必等到船上|补上[^。！？\n]{0,4}(?:水|潮|湿)|自带的?水|原来只[需要要][^。！？\n]{0,6}(?:水|湿|潮)|(?:水|湿|潮)[^。！？\n]{0,6}(?:就|便|即)能读|也能读|照样能读|一样能读|(?:限制|规矩|禁忌)[^。！？\n]{0,8}(?:失效|没了|不算|不灵|破了)|只要[^。！？\n]{0,8}(?:水|湿|潮)[^。！？\n]{0,6}(?:就|便)成)/u

/** 判场地用的上下文窗口：含该动作的段落 + 前 8 段 / 后 2 段（与 issue 的取证口径一致）。 */
const VENUE_WINDOW_BEFORE = 8
const VENUE_WINDOW_AFTER = 2

export interface AbilityLimitBypassHit {
  /** 世界观的限制句（从源头取）。 */
  restriction: string
  /** 自带条件又在受限场景里成功使用的那些章（升序）。 */
  chapters: number[]
  /** 第一处绕过的成功句（证据）。 */
  excerpt: string
}

/** 从世界观里抽出「能力在什么条件下失效」的限制句（issue #100，源头那一层）。 */
export function abilityFailureCondition(worldbuilding: string): string | null {
  const matches: string[] = []
  for (const sentence of String(worldbuilding ?? '').split(/[。；\n]/u)) {
    const text = sentence.trim()
    if (!text) continue
    if (FAILURE_PREDICATE.test(text) && VENUE_SHIFT.test(text)) matches.push(text)
  }
  if (matches.length === 0) return null
  // 取**最短**的那句：它最接近「一句话说明限制」的形态（实测那本书是
  // 「离船上岸，墨干气散，能力立刻衰减到几乎为零」，而更长的那句是在讲背景机制）。
  return [...matches].sort((left, right) => left.length - right.length)[0]!.slice(0, 120)
}

/**
 * 找出「能力在受限场地被成功使用、而全书从未把它写成一次发现」（issue #100）。
 *
 * 判据（三条都要求，标定后**零假阳性**）：
 *   ① 世界观里存在失效限制句（`abilityFailureCondition`）——没有声明过就无所谓被绕过；
 *   ② 该章**在受限场地**（动作所在段落 + 前 8 / 后 2 段的窗口里出现陆地场地词、且不出现
 *      触发场地词——两者都出现时判为 unknown，**不报**，宁漏不误报）；
 *   ③ 成功句用到了**自造触发条件**（自带水/蒸汽/湿处）；
 *   ④ 全书**没有任何一章**把这件事写成发现（`ACKNOWLEDGEMENT`）。
 *
 * 标定（那本书 46 章，21 章含能力场景，与 issue 的逐章地点判定对照）：
 *   16 章判对、**0 章判错**、5 章因场地词不足判为 unknown（不报）。
 *   命中的正是 issue 点名的那几章（ch36/43/46 等），而 0202（世界观没写这种限制）返回 0。
 */
export function findAbilityLimitBypass(input: {
  worldbuilding: string
  chapters: ReadonlyArray<{ chapterNumber: number; content: string }>
}): AbilityLimitBypassHit[] {
  const restriction = abilityFailureCondition(input.worldbuilding)
  // 世界观没写这种限制就不判——没有声明过的规则无所谓被绕过。
  if (!restriction) return []
  const chapters = input.chapters
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
  if (chapters.length === 0) return []
  // 全书有一次「把它写成发现」就不报（issue 建议 3 的落法）。
  if (chapters.some(chapter => ACKNOWLEDGEMENT.test(String(chapter.content)))) return []
  const bypassed: Array<{ chapterNumber: number; excerpt: string }> = []
  for (const chapter of chapters) {
    const paragraphs = String(chapter.content).split(/\n\s*\n/u).map(paragraph => paragraph.trim()).filter(Boolean)
    const successIndex = paragraphs.findIndex(paragraph => ABILITY_SUCCESS.test(paragraph))
    if (successIndex < 0) continue
    // ② 场地判定：动作所在段落 + 前后窗口。两个场地词类都出现 → unknown（不报）。
    const window = paragraphs
      .slice(Math.max(0, successIndex - VENUE_WINDOW_BEFORE), successIndex + VENUE_WINDOW_AFTER + 1)
      .join('\n')
    const aboard = CANONICAL_VENUE.test(window)
    const ashore = RESTRICTED_VENUE.test(window)
    if (aboard || !ashore) continue
    // ③ 自造触发条件：动作段落或紧邻的前一段里。
    const neighbourhood = paragraphs.slice(Math.max(0, successIndex - 1), successIndex + 1).join('\n')
    if (!SELF_SUPPLIED_CONDITION.test(neighbourhood)) continue
    const successParagraph = paragraphs[successIndex]!
    bypassed.push({
      chapterNumber: chapter.chapterNumber,
      excerpt: successParagraph.split(/(?<=[。！？…”」])/u).find(sentence => ABILITY_SUCCESS.test(sentence))?.trim().slice(0, 100)
        ?? successParagraph.slice(0, 100),
    })
  }
  // 只报**累积**形态：一次可能真有交代（如那本书第 39 章恰好回到了船上）。
  if (bypassed.length < ABILITY_BYPASS_MIN_CHAPTERS) return []
  return [{
    restriction,
    chapters: bypassed.map(hit => hit.chapterNumber),
    excerpt: bypassed[0]!.excerpt,
  }]
}

/** 至少这么多章出现「自带条件 + 成功」才报（单次可能确有交代，累积才是规则消失）。 */
export const ABILITY_BYPASS_MIN_CHAPTERS = 2

/**
 * 能力触发条件被绕过 → 一致性发现（issue #100）。
 *
 * `stableFactKey` 锚在**能力限制本身**上、**不带章号**（#86/#89/#98/#108 的教训：
 * 带章号的 key 会随章滚动，作者点「我已知」永远关不掉）。
 * `sourceChapter` 指向**首次绕过的章**（这是旧账，不是正在写的那一章）。
 * 出路三条可执行分支：写出发现 / 写出代价 / 改掉限制（都要求落到正文里，issue 建议 3）。
 */
export function findAbilityLimitBypassFindings(input: {
  worldbuilding: string
  chapters: ReadonlyArray<{ chapterNumber: number; content: string }>
}): Array<{
  stableFactKey: string
  severity: 'warning'
  sourceChapter: number
  evidence: string
  issue: { zhCN: string; enUS: string }
  suggestion: { zhCN: string; enUS: string }
}> {
  const hits = findAbilityLimitBypass(input)
  return hits.map(hit => {
    const chapterList = hit.chapters.join('、')
    return {
      // key 锚在「哪条限制被绕过」上，不含章号。
      stableFactKey: 'ability:limit-bypassed',
      severity: 'warning' as const,
      sourceChapter: hit.chapters[0]!,
      evidence: `世界观写死了能力限制（「${hit.restriction}」），但第 ${chapterList} 章的正文里，能力在受限条件下仍成功使用，且是靠**自造条件**（自带水／蒸汽／湿处）：${hit.excerpt}`,
      issue: {
        zhCN: `世界观明确写了这个能力的硬限制（「${hit.restriction}」），可从第 ${hit.chapters[0]} 章起，**第 ${chapterList} 章**都在限制本该生效的条件下读成功了——而且是靠角色自己**临时补上触发条件**（端一碗茶、湿毛巾、蒸汽）。问题不在「绕」本身，而在**全书没有一个人物对此提出过疑问，也没有一句「原来补上水汽就行」**：规则在预检/正文里被当成绝对律令立起来，之后被当成不存在。这条限制往往正是全书节奏的发动机（「每一夜都在跟水汽赛跑」），它一失效，后面所有「抢时间」的戏都失去压力来源——而作者在这几章收不到任何提示。`,
        enUS: `The worldbuilding states a hard limit on this ability (“${hit.restriction}”), yet from chapter ${hit.chapters[0]} on — chapters ${chapterList} — the ability succeeds under exactly the conditions said to disable it, because the character supplies the trigger himself (a bowl of tea, a wet towel, steam). The problem is not the workaround; it is that no character ever questions it and no line ever says “so adding moisture is enough”. The rule is established as absolute and then treated as nonexistent. That limit is usually the engine of the book's pacing (“every night he races the drying ink”); once it lapses, every time-pressure scene loses its source — and the author gets no signal in those chapters.`,
      },
      suggestion: {
        zhCN: `三选一，任何一种都行，但**必须落到正文里**：①**写成发现**——让主角当场意识到「不必等船，补上水汽就成」（一句话即可，例如「他试过，纸一湿，字就活了」），让规则变化成为情节；②**写出代价**——如果绕法有代价（要带水源、只能在某处、被谁看见），写出来，规则的松动就成了新的紧张点；③**改掉限制**——如果这条限制不再打算要了，就回去改世界观与相关伏笔（第 29 章那句警告也要一并处理），别让立过的规矩原地消失。`,
        enUS: `Pick one and put it on the page: (1) make it a discovery — have the character realise on-page that moisture alone is enough (one sentence will do: “he tried it; the paper went wet and the ink came alive”), turning the rule change into plot; (2) write the cost — if the workaround has a price (carrying water, only working in one place, being seen), state it, so loosening the rule becomes new tension; (3) drop the limit — if you no longer want it, go back and revise the worldbuilding and the foreshadowing it anchors (including that earlier warning line) instead of letting a stated rule vanish in place.`,
      },
    }
  })
}
