/**
 * 口头约定的**极性**被复述反了（issue #142）。
 *
 * 现场：第 60 章温珩要周叙答应的是**「不要写」**——
 *
 *   「答应我。座号**不写**进任何册。」   →   周叙：「**不写**。」
 *
 * 第 63 章复述成**「答应了要写」**：
 *
 *   「一七四。」温珩说，「你答应过**写进册**。」
 *
 * 而第 63 章整段戏（抽走回执副本、说「答应过的事不写下来，不算」）正建立在这个反了的
 * 前提上；`chapter_commits` 也把反的那版记成了事实，会随「最近章节摘要」进入后续起草。
 * 第 64 章自己又回到「你的座号，我**不往册上写**」——说明不是设定改了，是那一句说反了。
 *
 * 上游三层全对（蓝图 bp60/bp63、第 63 章短细纲都写「不写」），只有正文这一层反了，
 * 而**没有任何一层比对「承诺的内容」**：
 * - `findCrossChapterAssertionReversals`（#52）只认「是 X」↔「不是 X」同形短语，
 *   「答应不写」与「答应写」两者句式不同形，正则两头都抽不到（实测 0 命中）；
 * - `foreshadowing-commitments`（#68/#88）只管蓝图 `foreshadowing` 里的「留待第 N 章」；
 * - #35 只管「上一章的悬置有没有被承接」，管不到**承接得对不对**。
 *
 * 判据（结构性，全封闭词类，不写具体情节词）：
 * 1. **承诺句**：出现封闭的承诺动词（答应/约定/说好/许诺/应下/保证），且同句（或紧邻下一句）
 *    有「动作短语」（动词 + 受事，如「写进册」「交出去」）；
 * 2. **复述句**：后续章里同一动作短语再次出现，且**主语是「答应/约定」类动词**；
 * 3. 比对两次的**否定极性**（同一动作短语前是否有否定标记「不/别/勿/没」）——不同即报。
 *
 * 刻意不做：
 * - 不判「哪一次才对」——只报「同一句约定被复述成了相反方向」，由作者决定；
 * - 不用语义相似度：动作短语必须**字面相同**（归一标点后），避免把「写进册」与
 *   「往册上写」判成同一个（那是同义改写，不是矛盾——第 64 章正是这种合法换写）。
 */
import type { ConsistencyFinding } from './consistency-preflight'

/** 承诺动词（封闭类）。 */
const PROMISE_VERBS = ['答应', '约定', '说好', '许诺', '应下', '保证', '许了'] as const
/** 否定标记（封闭类）。 */
const NEGATION = '不别勿没'
/**
 * 动作短语：`<动词><受事>`，动词限封闭的一组常见承诺动作（写/记/交/给/说/带/送/留/收/报）。
 *
 * 取「动作 + 紧随其后的受事」为一短语，长度上限 6——实测「写进册」（3）、
 * 「写进任何册」（5）都是这个量级。
 *
 * ⚠️ **比对用核心短语，不是原串**（issue #142 实测）：同一句约定在两章常被写成
 * 「写进**任何**册」与「写进册」——字面不同、语义相同。所以比对前先剔除
 * **封闭的限定字类**（任何/所有/一切/这/那/某/每）。这些字只改指代范围、不改动作方向；
 * 方向由否定标记决定。剔掉之后两者都是「写进册」，才能比。
 * 但**不做同义改写归一**（如「写进册」vs「往册上写」）——第 64 章正是后一种合法换写，
 * 强行归一会把正常换写误报成矛盾。
 */
const ACTION_PHRASE = /([写记交给说带送留收报])([^\s，。！？；：「」“”]{1,5})/gu
/**
 * 限定字（封闭类）：只改指代范围，不改动作方向。
 * ⚠️ 要按**任意位置**剔除，不能只剔开头：「写进**任何**册」里的限定字在趋向补语「进」之后，
 * 只剔开头会得到「进任何册」，与「写进册」仍然配不上（issue #142 实测）。
 */
const LIMITING_CHARS = '任何所有一切这那某每'

/** 比对口径：动作字 + 受事，剔掉任意位置的封闭限定字。 */
function corePhrase(phrase: string): string {
  const verb = phrase[0] ?? ''
  const rest = [...phrase.slice(1)].filter(character => !LIMITING_CHARS.includes(character)).join('')
  return verb + rest
}

export interface PromiseMention {
  chapterNumber: number
  /** 动作短语（归一后）。 */
  phrase: string
  /** 该处是否被否定（「不写」「别写」「没写」）。 */
  negated: boolean
  /** 原文（供证据展示）。 */
  sentence: string
}

/** 是否在短语前紧邻否定标记（允许一个「要/能/许」这类情态字插在中间）。 */
function isNegatedAt(sentence: string, phraseStart: number): boolean {
  // 往前看 3 个字：覆盖「不写」「别写」「没写」「不要去写」。
  const head = sentence.slice(Math.max(0, phraseStart - 3), phraseStart)
  return [...head].some(character => NEGATION.includes(character))
}

/**
 * 抽「承诺句」里的动作短语。
 *
 * 只认**同句或紧邻下一句**出现承诺动词的那些句——不要求解析「谁对谁」，
 * 因为作者写的口头约定常常只有一次「答应我」+ 一句动作。
 */
export function promisePhrasesIn(chapterNumber: number, content: string): PromiseMention[] {
  const sentences = String(content ?? '')
    .split(/(?<=[。！？])|\n+/u)
    .map(sentence => sentence.trim())
    .filter(Boolean)
  const mentions: PromiseMention[] = []
  for (const [index, sentence] of sentences.entries()) {
    const hasPromiseVerb = PROMISE_VERBS.some(verb => sentence.includes(verb))
    if (!hasPromiseVerb) continue
    // 承诺动词所在句与下一句都看（「答应我。」「座号不写进任何册。」常分两句）。
    const scope = `${sentence}\n${sentences[index + 1] ?? ''}`
    for (const match of scope.matchAll(ACTION_PHRASE)) {
      const phrase = match[1]! + match[2]!
      const core = corePhrase(phrase)
      if (core.length < 2) continue
      mentions.push({
        chapterNumber,
        phrase: core,
        negated: isNegatedAt(scope, match.index ?? 0),
        sentence: sentence.slice(0, 80),
      })
    }
  }
  return mentions
}

/**
 * 复述句：后续章里出现「承诺动词 + 动作短语」，用于与首现处比对极性。
 *
 * 与 `promisePhrasesIn` 同一抽取，只是调用方按章号排序后两两比。
 */
export function findPromisePolarityReversals(
  chapters: readonly { chapterNumber: number; content: string }[],
  options: { window?: number } = {},
): ConsistencyFinding[] {
  const window = options.window ?? 8
  const ordered = [...chapters]
    .filter(chapter => Number.isSafeInteger(chapter.chapterNumber) && String(chapter.content ?? '').trim())
    .sort((left, right) => left.chapterNumber - right.chapterNumber)
    .map(chapter => ({ chapterNumber: chapter.chapterNumber, mentions: promisePhrasesIn(chapter.chapterNumber, chapter.content) }))

  const findings: ConsistencyFinding[] = []
  const reported = new Set<string>()
  for (const [index, chapter] of ordered.entries()) {
    for (const mention of chapter.mentions) {
      // 找同一个动作短语在本章之后的首次出现（窗口内）。
      for (const later of ordered.slice(index + 1)) {
        if (later.chapterNumber - chapter.chapterNumber > window) break
        const match = later.mentions.find(candidate => candidate.phrase === mention.phrase)
        if (!match) continue
        if (match.negated === mention.negated) continue
        const key = `${chapter.chapterNumber}|${mention.phrase}`
        if (reported.has(key)) continue
        reported.add(key)
        const first = mention.negated ? `不${mention.phrase}` : mention.phrase
        const second = match.negated ? `不${mention.phrase}` : mention.phrase
        findings.push({
          // 章号都是既成事实，不随写作推进变（#86/#89/#98/#108）。
          stableFactKey: `promise:polarity:${chapter.chapterNumber}:${mention.phrase}`,
          severity: 'warning' as const,
          sourceChapter: later.chapterNumber,
          evidence: `第${chapter.chapterNumber}章约定「${first}」（「${mention.sentence.slice(0, 40)}」）；第${later.chapterNumber}章复述成「${second}」`,
          issue: {
            zhCN: `口头约定的方向被复述反了：第 ${chapter.chapterNumber} 章说的是一件事（「${first}」），第 ${later.chapterNumber} 章却复述成相反的方向（「${second}」）。这类约定常常是几章戏的支点——方向一反，人物为什么那样做的动机就跟着反了（守约会被读成背约）。`,
            enUS: `A spoken promise is repeated backwards: chapter ${chapter.chapterNumber} states one direction (“${first}”), while chapter ${later.chapterNumber} repeats the opposite (“${second}”). Such a promise is often the pivot of several scenes — flipping it flips the character's motive (keeping the promise reads as breaking it).`,
          },
          suggestion: {
            zhCN: `把后一次的复述改回与首次约定一致的方向；若确实要写成「约定被记反了」，那就把这次记反写成**一个可辨认的错误**（人物自己发现记错、或另一个人纠正），别让它作为事实陈述过去。`,
            enUS: `Align the later restatement with the original promise. If you intend the promise to be misremembered, make the misremembering visibly a mistake (the character notices, or someone corrects it) instead of asserting it as fact.`,
          },
        })
      }
    }
  }
  return findings.sort((left, right) => left.sourceChapter - right.sourceChapter)
}
