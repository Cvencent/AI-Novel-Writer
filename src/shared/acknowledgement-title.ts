/**
 * 「我已知，稍后处理」列表里给作者看的摘要（issue #120）。
 *
 * 现象：弹层底部的「已标记稍后处理（N）」折叠区**直接渲染 `stableFactKey`**——
 * 作者挂起 16 条提醒后，回看时看到的是 `chapter-opening:scene-first:41`、
 * `prop:revival:内襟`、`foreshadowing:undelivered:15:19` 这种内部键：
 * 既认不出这条挂起的是哪个问题，也不知道点「恢复提醒」会冒出什么。
 *
 * 根因在**存储层**：`consistency_acknowledgements` 只有 `stable_fact_key` 与 `acknowledged_at`
 * 两列（`m09-preflight-ack.ts`），没有可读标题——界面**想**渲染人话也没有来源。
 * 所以这条与 #112（`zhCN`/`enUS`/`evidence` 三字段扫内部产物）同族，但换了一个出口：
 * ack 区渲染的是第四个字段 `stableFactKey`，三字段扫描盖不到。
 *
 * 解法（两条路并用，**不新增列、不做 schema 迁移**，于是**历史 ack 也能修**）：
 *   1. **优先配对当前这一轮的 finding**：`readConsistencyPreflight` 在按 ack 过滤**之前**
 *      就已经算出了全部 finding，把 `issue` 的原话摘要拿来用——那是一等一的权威文案。
 *   2. **配不上时**（那条判据在最近几章已不再命中——实测那本书 16 条 ack 里 15 条如此）
 *      用本模块的**封闭目录**把键翻译成人话，并注明「这条在最近几章已不再报出」。
 *
 * ⚠️ 这里的目录是**我们自己 key 命名空间的封闭消息表**（与 `DESTINATION_LABELS`、
 * `HOOK_FORM_TEXT` 同一类），**不是**「按题材写死的词表」：它列出的是本仓判据的**固定前缀**，
 * 是可枚举、可用结构测试穷尽的闭集。`acknowledgement-title.test.ts` 会**扫描全部
 * `stableFactKey` 字面量**并断言每一个前缀都能译出人话——新加判据若忘了登记，测试直接红。
 */
import { stripEmphasis } from './author-visible-text'


export interface AcknowledgementTitle {
  zhCN: string
  enUS: string
}

/**
 * key 前缀 → 人话。**两级**：先试 `family:sub`，再退回 `family`。
 *
 * 只登记**本仓判据产生的前缀**（每一个都由 `stableFactKey:` 字面量穷举出来）。
 */
const FAMILY_LABELS: Readonly<Record<string, AcknowledgementTitle>> = Object.freeze({
  // —— 章首 / 章末（位置轴）——
  'chapter-opening': { zhCN: '章首句式收敛', enUS: 'chapter openings converging' },
  'chapter-opening:scene-first': { zhCN: '章首都是「时间/地点状语 + 主句」', enUS: 'openings all scene-first' },
  'chapter-opening:dialogue-opener': { zhCN: '对白起手语跨章复用', enUS: 'dialogue opener reused' },
  'chapter-ending': { zhCN: '章末收束问题', enUS: 'chapter ending' },
  'chapter-ending:label-mismatch': { zhCN: '收束标注与正文不符', enUS: 'closing label vs prose' },
  'chapter-ending:ultimatum-streak': { zhCN: '连续多章通牒式台词收尾', enUS: 'ultimatum endings in a row' },
  'chapter-ending:subjectless-pending': { zhCN: '末句都是「物 + 未完结 + 无人称」', enUS: 'subjectless pending endings' },
  'chatper-ending:subjectless-pending': { zhCN: '末句都是「物 + 未完结 + 无人称」', enUS: 'subjectless pending endings' },
  // —— 标题 ——
  'chapter-title': { zhCN: '章节标题问题', enUS: 'chapter title' },
  'chapter-title:duplicate': { zhCN: '标题「同题加尾」复用', enUS: 'duplicate chapter title' },
  'chapter-title:locative-frame': { zhCN: '标题句法同构（方位框架）', enUS: 'title shape converging' },
  // —— 时间 ——
  'chapter-time': { zhCN: '时间交代问题', enUS: 'chapter time' },
  'chapter-time:undated': { zhCN: '连续多章没有跨日交代', enUS: 'no day-change for many chapters' },
  'chapter-time:stale-duration': { zhCN: '同一状态的用时前后矛盾', enUS: 'stale state duration' },
  'chapter-time:anchor-unmet': { zhCN: '蓝图声明了跨日、正文没写', enUS: 'declared day change not in prose' },
  'chapter-time:anchor-gap-mismatch': { zhCN: '蓝图与正文差的天数不一致', enUS: 'day gap disagrees' },
  'chapter-time:anchor-self-contradiction': { zhCN: '蓝图【时点】自己前后矛盾', enUS: 'blueprint 时点 contradicts itself' },
  'character-age': { zhCN: '人物年龄问题', enUS: 'character age' },
  'character-age:unreconcilable': { zhCN: '正文写了年龄却归不到人', enUS: 'age stated but unattributable' },
  'deadline': { zhCN: '期限宣告未对账', enUS: 'unsettled deadline' },
  'timeline': { zhCN: '设定层时间锚点冲突', enUS: 'timeline anchor conflict' },
  // —— 角色 ——
  'cast': { zhCN: '角色出场/名册问题', enUS: 'cast appearance or roster' },
  'cast:absent': { zhCN: '角色连续多章缺席', enUS: 'cast absent for many chapters' },
  'cast:never-appeared': { zhCN: '在册角色从未登场', enUS: 'cast never appeared' },
  'cast:thin': { zhCN: '主角/反派没填动机', enUS: 'main cast thin' },
  'cast:name-drift': { zhCN: '已登记角色名漂移', enUS: 'cast name drift' },
  'character': { zhCN: '角色卡问题', enUS: 'character card' },
  'character:appearance-gap': { zhCN: '角色卡缺外貌锚点', enUS: 'missing appearance anchor' },
  'blueprint-cast': { zhCN: '蓝图角色与名册不符', enUS: 'blueprint cast vs roster' },
  'blueprint-cast:near-name': { zhCN: '名字与在册角色仅一字之差', enUS: 'near-cast name' },
  'blueprint-cast:unregistered': { zhCN: '蓝图里有未建档角色', enUS: 'unregistered blueprint cast' },
  'synopsis-cast': { zhCN: '细纲与蓝图角色不一致', enUS: 'synopsis cast mismatch' },
  'architecture': { zhCN: '架构「人物群像」漏角色', enUS: 'architecture cast missing' },
  'entrance': { zhCN: '人物登场段同构', enUS: 'entrance shot repeated' },
  'handwriting': { zhCN: '笔迹特征自相矛盾', enUS: 'handwriting traits conflict' },
  // —— 物证 / 道具 ——
  'prop': { zhCN: '物证/道具问题', enUS: 'prop or piece of evidence' },
  'prop:revival': { zhCN: '被写死的物证又自己回来', enUS: 'annihilated prop revived' },
  'prop:repeat-termination': { zhCN: '同一件物证被终结两次', enUS: 'prop terminated twice' },
  'prop:container-departure': { zhCN: '道具位置换了却没有交接', enUS: 'prop container departure' },
  'prop-handover': { zhCN: '物件过手动作固定化', enUS: 'prop handover converging' },
  'continuity': { zhCN: '遗忘被跨章重述', enUS: 'loss restatement' },
  'revocation': { zhCN: '不可逆处境重复宣告', enUS: 'repeated revocation' },
  // —— 正文写法 ——
  'prose': { zhCN: '正文重复写法', enUS: 'prose repetition' },
  'prose:expression': { zhCN: '神态定格短句复用', enUS: 'frozen expression reused' },
  'prose-flavor': { zhCN: 'AI 味配额', enUS: 'AI-flavour quota' },
  'prose-flavor:metaphor': { zhCN: '比喻超配额', enUS: 'simile over quota' },
  'prose-flavor:physiological': { zhCN: '模板化生理反应超配额', enUS: 'physiological cliché over quota' },
  'prose-flavor:summary-tail': { zhCN: '段尾总结腔', enUS: 'summarising tail' },
  'prose-flavor:motif': { zhCN: '同一意象反复承担情绪', enUS: 'motif over quota' },
  'prose-flavor:sentence-length': { zhCN: '平均句长超上限', enUS: 'sentence length above ceiling' },
  'prose-flavor:sentence-length-floor': { zhCN: '叙述句均长低于下限', enUS: 'sentence length below floor' },
  'prose-flavor:sentence-length-drift': { zhCN: '叙述句长单向收敛', enUS: 'sentence length drifting down' },
  'prose:repeated-reaction': { zhCN: '同一反应式短句跨章复现', enUS: 'same reaction line repeats across chapters' },
  'prose:repeated-device': { zhCN: '同一场景装置反复开场', enUS: 'same staging move opens scenes' },
  'prose:prop-terminal': { zhCN: '同一道具被终结两次以上', enUS: 'prop terminated more than once' },
  'prose:prop-moved': { zhCN: '道具换了持有者却没写交接', enUS: 'prop moved without an on-page handover' },
  'prose:stale-duration': { zhCN: '同一状态用了两个不相容的时长', enUS: 'one state with two incompatible durations' },
  'paragraph-opener': { zhCN: '段落起手主语固定', enUS: 'paragraph opener fixed' },
  'quote-style': { zhCN: '引号风格与全书不一致', enUS: 'quote style drift' },
  'glyph': { zhCN: '字形偏旁写错', enUS: 'wrong radical claimed' },
  'numbering': { zhCN: '编号位数自相矛盾', enUS: 'numbering digits mismatch' },
  'declared-count': { zhCN: '自报的字数与写出的字不符', enUS: 'declared character count mismatch' },
  'inventory': { zhCN: '清单件数对不上', enUS: 'inventory count mismatch' },
  'inventory:enumeration': { zhCN: '声明了几项却只列出几项', enUS: 'enumerated fewer items than declared' },
  'inventory:shortfall': { zhCN: '前章的清单件数在后文少了几件', enUS: 'inventory shortfall across chapters' },
  'gauge': { zhCN: '量具读数与换算对不上', enUS: 'gauge reading vs conversion' },
  'gauge:scale': { zhCN: '量具换算与本该章载客量差一个数量级', enUS: 'gauge conversion vs this chapter headcount' },
  'gauge:scale-ratio': { zhCN: '同一量具被写成两套换算比值', enUS: 'same gauge defined at two ratios' },
  'prose:sentence-reuse': { zhCN: '整句在相邻章逐字重复', enUS: 'whole sentence copied across chapters' },
  'prose:short-sentence-reuse': { zhCN: '同一句短叙述句在多章复用', enUS: 'short narrative sentence reused across chapters' },
  'prose:evidence-shape': { zhCN: '被当作证据的物件形态/成因立不住', enUS: 'evidence object does not hold up' },
  'prose:memory-anchor-missing': { zhCN: '回忆的事在前文找不到', enUS: 'remembered scene has no anchor' },
  'blueprint:habit-vs-prose': { zhCN: '蓝图把没发生过的事写成一向如此', enUS: 'blueprint claims a habit the prose denies' },
  'promise': { zhCN: '口头约定被复述反了', enUS: 'promise restated backwards' },
  'chapter-title:unmet': { zhCN: '标题点到的人本章没出场', enUS: 'title names someone absent' },
  // —— 伏笔 / 线索 / 其他 ——
  'foreshadowing': { zhCN: '承诺的伏笔没落地', enUS: 'foreshadowing undelivered' },
  'thread': { zhCN: '叙事线索停摆/逾期', enUS: 'narrative thread' },
  'thread:overdue': { zhCN: '叙事线索已逾期未解决', enUS: 'thread overdue' },
  'thread:dormant': { zhCN: '叙事线索已停摆多章', enUS: 'thread dormant' },
  'assertion-reversal': { zhCN: '结论被后一章反转', enUS: 'assertion reversed' },
  'ability': { zhCN: '能力硬限制被静默绕过', enUS: 'ability limit bypassed' },
  'ability-budget': { zhCN: '能力上限自相矛盾', enUS: 'ability budget conflict' },
  'blueprint': { zhCN: '蓝图字段问题', enUS: 'blueprint field' },
  'blueprint:key-events-length': { zhCN: '蓝图 keyEvents 过长', enUS: 'blueprint keyEvents too long' },
  'fact': { zhCN: '事实账本问题', enUS: 'fact ledger' },
})

/** 键里所有非键部分（人名/物名/章号）都当「没有可读标题」处理时用的兜底。 */
const FALLBACK: AcknowledgementTitle = Object.freeze({
  zhCN: '一致性提醒', enUS: 'consistency reminder',
})

/**
 * 把一个 `stableFactKey` 译成人话（issue #120）。
 *
 * 取**最长匹配前缀**：先试 `a:b`，再退回 `a`，都不认得就用兜底。
 * ⚠️ 返回值**一定不含 `:` 分隔的内部形态**——这是可达性要求，也是
 * `acknowledgement-title.test.ts` 的断言（渲染出去的东西不能再是键的样子）。
 */
export function acknowledgementFamilyTitle(stableFactKey: string): AcknowledgementTitle {
  const key = String(stableFactKey ?? '').trim()
  if (!key) return FALLBACK
  const segments = key.split(':')
  // 最长匹配：两段 → 一段（`prose-flavor:motif` 优于 `prose-flavor`）。
  for (const length of [2, 1]) {
    if (segments.length < length) continue
    const candidate = segments.slice(0, length).join(':')
    const label = FAMILY_LABELS[candidate]
    if (label) return label
  }
  return FALLBACK
}

/** 已登记的 key 前缀（供结构测试穷举比对）。 */
export function acknowledgementKnownPrefixes(): string[] {
  return Object.keys(FAMILY_LABELS)
}

/**
 * 给一条 ack 造可读标题（issue #120）。
 *
 * - `finding` 有值时（那条判据这一轮**仍然命中**）用它的原话：摘要取 `issue` 的**首句**
 *   （截到 `maxChars`），这是判据自己写的、最准确的一行；
 * - 配不上时（这条在最近几章**已不再报出**）用封闭目录译出人话并注明这一点，
 *   让作者至少知道「它是不是还在」，而不是面对一串内部键。
 */
export function acknowledgementTitleOf(
  stableFactKey: string,
  finding?: { issue: { zhCN: string, enUS: string } } | null,
  maxChars = 42,
): AcknowledgementTitle {
  if (finding) {
    return {
      zhCN: firstSentence(finding.issue.zhCN, maxChars),
      enUS: firstSentence(finding.issue.enUS, maxChars),
    }
  }
  const family = acknowledgementFamilyTitle(stableFactKey)
  return {
    zhCN: `${family.zhCN}（这条在最近几章已不再报出）`,
    enUS: `${family.enUS} (no longer reported in the recent chapters)`,
  }
}

/**
 * 取首句（到第一个句末标点为止），超长再截断——避免把整段文案塞进一行。
 *
 * ⚠️ **中英两套句末标点都要认**：只认 `。！？` 时英文文案永远切不开（英文用 `.`），
 * 于是整段被硬截在中途——这是本文件第一版的实际缺陷，由测试的英文用例抓出来。
 */
function firstSentence(text: string, maxChars: number): string {
  // issue #154：ack 区是**纯文本**标题，判据文案里的 `**` 会原样显示。
  // 先剥标记再截句：否则截断点可能落在一对 `**` 中间，留下半截标记。
  const trimmed = stripEmphasis(text)
  if (!trimmed) return ''
  const stop = trimmed.search(/[。！？]|[.!?](?=\s|$)/u)
  const sentence = stop >= 0 ? trimmed.slice(0, stop + 1) : trimmed
  return sentence.length <= maxChars ? sentence : `${sentence.slice(0, maxChars)}…`
}