import { splitProseSentences } from './finalized-continuity-facts'

/**
 * 章末收束的体检（issue #65 / #66）。
 *
 * 两条 issue 指向同一个盲区：全书**怎么收尾**从来没有被机器看过一眼。
 *
 * - #28 只管蓝图里那个「【收束：类型】」标签**彼此**是否重复（画面同构），
 *   却没有人核对标签与正文最后一幕是否一致——实测 10 章有 7 章不符，
 *   于是「不得重复上一章落幅」这条约束建立在假信息上。
 * - 蓝图给「对话收束」开了合法的口子，但没有管**对白在做什么**：25 章里
 *   末段含对白的 7 章，有 6 章末句是「二选一/警告/条件通牒」，且全落在第 15
 *   章之后。画面换了、人物换了、钩子文本也不重复，读者听到的还是同一个声音。
 *
 * 判据只取**能可靠算出来的那一维**：本章是不是**收在台词里**。
 * 「物件落幅 vs 人物动作收束」这类细分需要语义理解，粗分类必然出错——
 * 本仓已经吃过词表假阳性的亏（#30 / #43），宁可少判一维也不给作者刷噪声。
 */

/** 正文最后一段（按空行切，取最后一个有内容的块）。 */
export function closingParagraph(content: string): string {
  const blocks = String(content ?? '')
    .split(/\n\s*\n/u)
    .map(block => block.trim())
    .filter(Boolean)
  return blocks.at(-1) ?? ''
}

const OPEN_QUOTES = '“「『"'
const CLOSE_QUOTES = '”」』"'

/** 一段文字里有没有闭合的台词。 */
export function hasDialogue(text: string): boolean {
  return /[“「『"][^”」』"]{1,400}[”」』"]/u.test(String(text ?? ''))
}

/**
 * 末句是否**收在台词里**（最后一个内容字符是收引号，或扫描结束时仍在引号内）。
 *
 * 只问「落在哪」而不问「段里有没有对白」：本样本第 20 章的对白在倒数第二句、
 * 最后收在动作上——按「段内有对白」判会误判成对话收束，正是 #65 要修的那类错误。
 */
export function closesInsideDialogue(sentence: string): boolean {
  const trimmed = String(sentence ?? '').trim()
  if (!trimmed) return false
  if (/[”」』"]$/u.test(trimmed)) return true
  let depth = 0
  for (const character of trimmed) {
    if (OPEN_QUOTES.includes(character)) depth += 1
    else if (CLOSE_QUOTES.includes(character)) depth = Math.max(0, depth - 1)
  }
  return depth > 0
}

export interface ChapterEndingProfile {
  chapterNumber: number
  /** 本章是否收在台词里。这是本模块唯一断言的事实。 */
  closesOnDialogue: boolean
  /** 末句原文（供证据展示，调用方负责截断）。 */
  lastSentence: string
  /** 末句是台词，且是「二选一/警告/条件」体（issue #66）。 */
  ultimatum: boolean
}

/**
 * 通牒式台词的判据（issue #66）。
 *
 * 只认「末句本身是台词，且台词把决定/后果压给对方」这一种形态。
 * 用**句式**而不是关键词堆叠：「不…就…」「要么…要么…」「你替我…」这些结构
 * 与具体用词无关，换一本书、换一批人物仍然成立；纯关键词表（如「就化了」）
 * 只能命中这一本样本，是本仓反复避免过拟合的反面。
 *
 * 每条都带负向前瞻，别把「别人」「特别」「替我高兴」这类日常词判成威胁：
 * 本仓在 #30/#43 已经吃过纯词表假阳性的亏。
 */
const ULTIMATUM_PATTERNS: readonly RegExp[] = [
  // 别 + 动作（别想/别下/别再/别看…），但排除「别人/别的/别处/别样/别家」。
  /(?<![特区告送分类性级识辨差个离惜阔])别(?!人|的|处|样|家)[^。！？!?，]{0,6}(?:[。！？!?]|$)/u,
  // 明写的禁止。
  /(?:不许|不准|不能|不要|休想|不用想)/u,
  // 二选一。
  /(?:不然|否则|要么|要不)/u,
  // 把选择权压回去。
  /(?:你|他|她)自己(?:选|挑|看着办)/u,
  // 命令对方承担（你替我上 / 给我记着）。要跟具体动作，避免「替我高兴」这类客套。
  /(?:给我|替你|替我)(?:上|去|来|看|记|办|签|走|说|交|还)/u,
  // 记恨式警告。
  /(?:记住|记着|走着瞧|试试看|等着瞧)/u,
  // 「但…就…」条件式。
  /但[^。！？!?]{0,20}就[^。！？!?]{0,8}[。！？!?]?$/u,
  // 「不 X，…」的条件句（不签，箱子当场扣下）。限定在一小撮动词上，
  // 否则「不同的地方，他…」这类日常句子会被误判。
  /(?:^|[；;，,。！？])不(?:签|交|给|放|走|去|说|答|认|干|做|借|还|动|来|上|下)[^，,。！？]{0,4}[，,]/u,
]

export function isUltimatumLine(sentence: string): boolean {
  const trimmed = String(sentence ?? '').trim()
  if (!trimmed || !closesInsideDialogue(trimmed)) return false
  // 只拿台词内容判，不含旁白引语（「柯明远把笔收回去」）。
  const spoken = [...trimmed.matchAll(/[“「『]([^”」』]*)[”」』]/gu)].map(match => match[1]).join('')
  const target = spoken || trimmed.replace(/[“”「」『』"]/gu, '')
  return ULTIMATUM_PATTERNS.some(pattern => pattern.test(target))
}

/** 提取一章的收束画像。 */
export function chapterEndingProfile(chapterNumber: number, content: string): ChapterEndingProfile {
  const sentences = splitProseSentences(closingParagraph(content))
  const lastSentence = (sentences.at(-1) ?? '').trim()
  return {
    chapterNumber,
    closesOnDialogue: closesInsideDialogue(lastSentence),
    lastSentence,
    ultimatum: isUltimatumLine(lastSentence),
  }
}

/**
 * 蓝图自报的收束类型 → 可断言的事实。
 *
 * 返回 `'dialogue'` 表示「标签声称收在对白里」、`'prose'` 表示「标签声称收在叙述里」、
 * `null` 表示这条标签**本模块无法核对**（悬念直陈/内心独白/时空切换都不承诺
 * 收在白话还是在台词里，硬比会产生假阳性）。
 */
export function blueprintClosingClaim(label: string): 'dialogue' | 'prose' | null {
  switch (String(label ?? '').trim()) {
    case '对话收束': return 'dialogue'
    case '人物动作收束': return 'prose'
    case '物件落幅': return 'prose'
    default: return null
  }
}

/** 标签与正文是否冲突（issue #65）。无法核对的标签一律返回 false。 */
export function closingLabelConflicts(label: string, profile: ChapterEndingProfile): boolean {
  const claim = blueprintClosingClaim(label)
  if (!claim) return false
  return claim === 'dialogue' ? !profile.closesOnDialogue : profile.closesOnDialogue
}

/**
 * 连续几章都收在通牒式台词里 → 收尾收敛了（issue #66）。
 *
 * 要求**末尾连续**而非「最近 N 章出现过 N 次」：读者感到的是「这一章又是这么收的」，
 * 中间夹一章别的写法就能打断预期。章号断号（中间有没导入的章）也视为断开。
 */
export const ULTIMATUM_STREAK_MIN = 3

export function ultimatumStreak(
  profiles: readonly ChapterEndingProfile[],
  minStreak = ULTIMATUM_STREAK_MIN,
): ChapterEndingProfile[] {
  const ordered = [...profiles].sort((left, right) => left.chapterNumber - right.chapterNumber)
  let streak: ChapterEndingProfile[] = []
  for (const profile of ordered) {
    if (!profile.ultimatum) { streak = []; continue }
    const previous = streak.at(-1)
    if (previous && profile.chapterNumber !== previous.chapterNumber + 1) streak = []
    streak.push(profile)
  }
  return streak.length >= minStreak ? streak : []
}

/**
 * 钩子的**语用形态**（issue #66）：蓝图把 `suspenseHook` 写成条件/警告句时，
 * 正文只能照着收成通牒。这里给生成侧一个可读的标签，让模型先看清最近几章
 * 用过哪种形态，再选本章的。
 *
 * 只分五类、只做粗判：目的是**轮换提示**，不是判定文学质量。
 */
export type HookForm =
  | 'ultimatum'   // 条件/警告：不签就扣船、今晚别下船
  | 'question'    // 直接的未解疑问
  | 'deadline'    // 正在逼近的时点
  | 'revelation'  // 刚暴露的新事实
  | 'decision'    // 待作出的选择
  | 'other'

const HOOK_ULTIMATUM = ULTIMATUM_PATTERNS
const HOOK_DEADLINE = /(?:之前|开航前|天亮前|今夜|明晚|三日内|限期|倒计时|来不及|到期)/u
const HOOK_REVELATION = /(?:原来|竟然|竟是|发现|露出|浮出|写着|竟是|暴露)/u
const HOOK_DECISION = /(?:要么|还是|要不要|该不该|二选一|得选|只能选)/u

export function hookFormOf(hook: string): HookForm {
  const text = String(hook ?? '').trim()
  if (!text) return 'other'
  if (HOOK_ULTIMATUM.some(pattern => pattern.test(text))) return 'ultimatum'
  if (/[?？]/u.test(text)) return 'question'
  if (HOOK_DECISION.test(text)) return 'decision'
  if (HOOK_REVELATION.test(text)) return 'revelation'
  if (HOOK_DEADLINE.test(text)) return 'deadline'
  return 'other'
}

/** 钩子形态给人读的中文/英文标签（进提示词）。 */
export const HOOK_FORM_TEXT: Readonly<Record<HookForm, { zhCN: string; enUS: string }>> = Object.freeze({
  ultimatum: { zhCN: '条件/警告（通牒）', enUS: 'conditional threat (ultimatum)' },
  question: { zhCN: '未解疑问', enUS: 'open question' },
  deadline: { zhCN: '逼近的时点', enUS: 'approaching deadline' },
  revelation: { zhCN: '新暴露的事实', enUS: 'newly exposed fact' },
  decision: { zhCN: '待作出的选择', enUS: 'pending decision' },
  other: { zhCN: '其他', enUS: 'other' },
})
