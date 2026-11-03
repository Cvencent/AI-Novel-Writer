import { StructuredContractDiagnostic } from './structured-contract-diagnostic'
import { CHARACTER_ROLES, type CharacterRole } from './character-role'
import type { WritingLanguage } from './writing-language'
// 时点标注的形态常量与读标注的 `timeAnchorOf` 同源（issue #84）——
// `splitBlueprintLabels` 拆的与下游读的必须是同一个正则，否则两边会慢慢漂开。
import { BLUEPRINT_TIME_ANCHOR_LABEL_PATTERN } from './chapter-time-anchor'

export interface BlueprintRelationshipFact {
  from: string
  to: string
  relation: string
}

/** A recurring named character first introduced by this blueprint. */
export interface BlueprintNewCharacterCandidate {
  name: string
  role: CharacterRole
}

/** Stable provenance input; validation code and qualification hash this same manifest. */
export const BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST = Object.freeze({
  schemaVersion: 1,
  requiredFields: Object.freeze([
    'chapterNumber',
    'title',
    'role',
    'purpose',
    'keyEvents',
    'characters',
    'relationships',
    'suspenseHook',
    'costsAndTurns',
    'foreshadowing',
  ] as const),
  characters: Object.freeze({ minimumItems: 1, unique: true } as const),
  relationships: Object.freeze({
    required: true,
    emptyAllowed: true,
    requiredFields: Object.freeze(['from', 'to', 'relation'] as const),
    endpointsMustAppearInCharacters: true,
  } as const),
  exactChapterCoverage: true,
} as const)

export function blueprintSemanticGenerationContract(writingLanguage: WritingLanguage): string {
  if (writingLanguage === 'en-US') {
    return `[Immutable blueprint JSON contract]
Output {"blueprints":[...]} only. Every item must contain all of these fields: ${BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.requiredFields.join(', ')}.
chapterNumber must cover every target chapter exactly once, without duplicates or out-of-range values. title, role, purpose, keyEvents, and suspenseHook must be non-empty strings. title must be unique across the whole book: never reuse a title from an earlier chapter (recentBlueprints/chapter_list). A **retitled repeat counts as reuse** (issue #110): taking an existing title and appending a particle or a clause ("压印" to "压印的", "无人认领" to "无人认领，一并化浆") reads in the contents as the same chapter printed twice and is rejected; to carry a chapter forward, pick a wording with its own identity. keyEvents must not replay a scene already written in a finalized chapter.
suspenseHook is always required; even without a mystery, state one concrete unresolved decision, threat, revelation, or consequence that creates forward pressure. **Entrances must not repeat** (issue #81): a character's first appearance in adjacent chapters must not use the same posture + place + clothing formula (in the sample one character entered the same way in 11 chapters — standing somewhere, barefoot, hem dripping — with two pairs matching 22 and 13 characters verbatim). The entrance is the start button of every scene, so a repeated one hurts more than a repeated closing shot. When keyEvents says how a character comes in, change that formula: whether they are tired, whether the clothes are dry, what is in their hands, who they stand beside, whether they speak or act first. Its **pragmatic form must rotate** (issue #66): do not end every chapter with someone forcing the protagonist into a binary choice (sign or the ship is impounded, do not go ashore tonight, you take my place). Recent chapters' hook forms are listed in references — read what was just used. Available forms: an open question, a newly exposed fact, a forced decision, an approaching deadline, a shift in someone's attitude, an unexplained piece of evidence. Adjacent chapters must not use the same form, and three consecutive chapters must never all close on a conditional or threatening line: with setting, speaker, and wording all different, readers still hear the same voice at every chapter end, which formalises the suspense and blunts it.
Hook carry-over is required (issue #20): this chapter must explicitly address the previous chapter's suspenseHook (its name/person/object/decision is in recentBlueprints). Continue it, twist it, or settle it — and if it is deliberately deferred, say so and why in this chapter's keyEvents. Never silently switch to an unrelated topic: a hook whose line is simply dropped reads to the reader as a broken promise.
Pending decisions outside the hook must also carry over (issue #35): the previous chapter's prose usually leaves more than one thing hanging — someone promised to take a shift, hand over an object, come back at a stated time, keep quiet, or stand in for another. Only the recorded suspenseHook is guaranteed to be handled downstream. When references/the material list a predecessor item the previous chapter's prose left open, this chapter must either advance it, twist it, or defer it explicitly in keyEvents (saying what is deferred and why). A decision a character stated aloud and that no later chapter ever mentions reads to the reader as an unfinished thread.
Key objects must change hands on the page (issue #38): prose, not the blueprint, decides who holds an object. When a key object was refused, seized, or ended in another character's hands in the previous chapter, this chapter may not simply have the viewpoint character produce it — keyEvents must show the handoff (who gives it to whom, under what condition) or another seizure. Never describe an object as "already in his pocket" because the blueprint said it was handed over: the reader only believes what happened on the page.
**Handwriting traits must stay consistent** (issue #97): if the book's core ability is recognising who wrote something by their hand, one writer's traits (entry stroke, turn, exit stroke, pressure) may take only one form across the whole book; never give the same person "the turn snaps short" and then "steady and even, sharp on entry", and never attach the same trait phrase to two different people — readers then have no reference table and every identification loses its footing. If the handwriting really does change (an injured hand, a forgery, being told to write it), say on the page why it changed. Never contradict yourself inside one chapter (issue #19): keyEvents must not both take a key object away (seized / handed over / burned) and have the same side read or use it in that chapter. If the object must be lost and regained here, write the recovery as its own event (who returns it, at what price); otherwise split the two across chapters. And never let remembering substitute for reading the physical object: if the established rule is that the ink layer on the object must be read, memory cannot replace it. A **hard limit on the core ability must not be silently bypassed** (issue #100): if the worldbuilding fixes the ability's trigger condition ("it fails the moment you go ashore", "only at night", "requires blood"), this chapter must not have it succeed under the forbidden condition — **unless the chapter turns that into a discovery** (even one line: "he tried it; a little moisture was enough"), or states the workaround's cost. Readers see a rule the author set up and then broke without explanation, which costs more trust than a weaker ability; and such a limit is usually the book's pacing engine ("every night he races the drying ink") — once it lapses, every time-pressure scene loses its source. If you no longer want the limit, go back and revise the worldbuilding and the foreshadowing it anchors instead of letting it vanish in place.
characters must list named people only (already in the character facts, or declared in this item's newCharacterCandidates), with at least one unique non-empty full name. Every named person who is not already in the character roster MUST also be declared in this item's newCharacterCandidates with a role; otherwise do not put them in characters at all — an undeclared name never gets a card, so post-finalization state writes and consistency checks will never cover them, and the next chapter will have no memory of them (issue #42). A walk-on who appears once and carries no plot should be described by role label in keyEvents, not given a name. Role-only labels such as "the examiner", "the guard" or "the clerk" must never appear in characters; describe them in keyEvents instead.
newCharacterCandidates is optional. When present, include only important named characters first introduced by this blueprint and expected to recur. Every item must contain name and role, name must exactly copy one entry from characters, and role must be protagonist, antagonist, supporting, or minor. Omit it or use [] when there are no candidates; never include incidental figures.
relationships is required and may be []; every item must contain non-empty from, to, and relation fields. from and to must exactly copy full names from the same item's characters array and may not self-reference.
costsAndTurns is required: state the concrete cost or irreversible consequence paid in this chapter (bounded, traceable). When nothing is paid, say so in one short clause. The cost must rotate: never reuse the same cost type or the same beat template as the adjacent chapters (the previous chapters' costs are in recentBlueprints); when the golden-finger's price was paid the same way last chapter, pay a different kind of price this chapter. The cost must leave a ledger (issue #36): whatever is written in costsAndTurns must still be unpaid at the end of this chapter — a forgotten fact may not be recovered for free in the same chapter, a lost item may not be picked back up two sentences later, and an injury, deadline, or exposure risk may not evaporate on the next page. To recover or lift a loss, the character must pay another price (read again, ask someone, expose their position, give something up) and that new price must be written down too. Never write the recovery into the cost field itself ("forgot where the stub was, felt along the water lock and found it" is not a cost).
foreshadowing is required: state what this chapter plants or pays off. Write none when the chapter carries none.
Closing shot must rotate (issue #28): end keyEvents with a "【收束：类型】" label naming this chapter's closing shot, from only these types: character-action close, dialogue close, object close, time/place switch, direct question close, interior monologue. Adjacent chapters must not repeat the same closing shot, and must never end on the same character holding the same pose (standing in the doorway, saying nothing) chapter after chapter — a repeated close makes chapters indistinguishable even when every hook differs. References list the recent chapters' closing shots; read them before choosing.
Staging must rotate (issue #32): also end keyEvents with a "【装置：地点＋起手动作】" label naming how this chapter's core scene is set up (e.g. "舱底＋拧水隔"). The same place-plus-opening-action pair must not repeat in adjacent chapters — especially for a recurring ability scene (the golden-finger read, an examination, an audit), change the setting and the opening move; never run the same "back aboard → down to the hold → turn the water lock → dip the stub" sequence chapter after chapter. State the time anchor (issue #84): also end keyEvents with a "【时点: …】" label saying *when* this chapter happens (e.g. "the same night (directly after the previous chapter)", "the next morning", "three days later"). This is the only place in the pipeline that produces a time anchor — without it the drafting contract's "same day" default always applies and a day change can never be written (in a 34-chapter sample book "next day / the following day / half a month" appeared 0 times, while "last night" was used across 11 chapters with no referent). When several chapters in a row happen on the same night with no time anchor, readers read them as one night repeating.
Character reactions must vary (issue #33): do not express the same character's reaction to questioning, setback, or threat with the same negated micro-phrase (did not move / did not answer / said nothing) chapter after chapter. When they stay silent, show it differently — a bodily action, a glance, breathing, the work in their hands, or cut away to another moment — and do not make "asked a question → the other party answers nothing" your every chapter's closing beat. Entrance actions must rotate (issue #82): do not start chapter after chapter by having a character crouch, stoop or bend to enter the scene — in the sample book 19 of 26 chapters began with someone crouching (40 times overall; a supporting character had 10 of his 11 chapters crouching), so by chapter 10 the reader can predict "he is about to crouch down and do something", and the characters stop being distinguishable by what they do. When you write how a character comes into this scene, change that one fixed move: let them stand, walk, speak first, be busy with something else, or be called over — make *how* they do the thing an identifying trait.
Preserve complete narrative content.
Do not omit required fields, combine chapters, rename fields, explain, or output Markdown or code fences.`
  }
  return `【不可变蓝图 JSON 合同】
只输出 {"blueprints":[...]}，每项必须完整包含：${BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.requiredFields.join('、')}。
chapterNumber 必须覆盖本批每个目标章节且不得重复或越界；title、role、purpose、keyEvents、suspenseHook 必须是非空字符串。title 必须全书唯一：不得复用已有章节的标题（见 recentBlueprints/chapter_list）——**「同题加尾」也算复用**（issue #110）：把已有标题原样当前缀再补一个「的」或一个分句（「压印」→「压印的」、「无人认领」→「无人认领，一并化浆」）在目录里读起来就是同一章写了两遍，会被判重驳回；承接上一章请换一个**有区分度**的措辞。keyEvents 不得重演已定稿章节里已经写过的场景。
**标题句法必须轮换**（issue #106）：不要与最近几章共用同一**句法骨架**——是禁结构、不是禁词。样本里第 41–48 章有 8/9 章都是「【物件】＋方位词＋的＋【线索】」（口供上的指印 / 名单上的半页 / 底板下的最后一册 / 册子里的空号段），一整列同构标题在目录里比在正文里更显眼，还把铺垫章、对峙章、代价章统一成同一个形状。**「X 上的 Y」「X 里的 Y」「X 之前的 Y」算同一骨架，换名词不算换结构**；连着三四章同形就该换取题方式。可用的取题角度：人物或动作（谁做了什么）、本章的转折或代价、一句台词或一个疑问、时间或场景的变化。references 里给了最近几章的标题，先看清刚用过什么结构。
suspenseHook 始终必填；即使本章没有谜团，也要写明一个制造推进压力的具体未决决定、威胁、揭示或后果。**人物登场不得同构**（issue #81）：同一个角色在相邻章的登场段不得用同一套「姿态＋地点＋穿戴」交代（样本里温珩 11 章都是「站在某处、赤脚、靛蓝短褂下摆滴水」，其中两对逐字重合 22 字与 13 字）——登场句是每场戏的开机键，同构比收束收敛更伤。keyEvents 里写这个角色怎么进场时，换掉那套固定交代：他累不累、衣服干没干、手里拿着什么、跟谁站在一起、先出声还是先动手。钩子的**语用方式必须轮换**（issue #66）：不要每章都写成「有人用一句话把主角逼到一个二选一」（不签就扣船、今晚别下船、你替我上）。references 里给了最近几章的钩子类型，先看清刚用过什么。可用的形态：未解的具体疑问、刚暴露的新事实、被迫作出的选择、一个正在逼近的时点、某人态度的一次转变、一件尚未解释的物证。相邻两章不得重复同一种形态，连续三章也不得都以条件/警告句收尾——画面与人物都换了、钩子文本也不重复，读者却会在每章末尾听到同一个声音，悬念因此被形式化。
上一章钩子必须接（issue #20）：本章必须显式回应上一章的 suspenseHook（其具名的人/物/决定见 recentBlueprints）——继续推进、反转或了结皆可；确实要搁置时，必须在本章 keyEvents 里写明「搁置了什么、为什么」。不得默默换成无关话题：钩子点名的人或决定在本章再不出现，读者读到的是「上一个坑没人埋」。
上一章的期限必须结算（issue #101）：上一章抛出的**带后果的期限**（「明早签字结案」「天亮前得还」「日落前核完」「明日中午，逾时结案」）在本章必须落到正文里，三种之一：**兑现**（在期限前办成，写出结果）、**逾期**（写明期限到了没做到、后果是什么）、**明确延期**（谁改的口、为什么改）。三者都没有就是漏账——读者对期限的敏感度是靠兑现累积的，给一次不兑现就学会「这个期限不会来」，到第十二次全书的压力来源就废了。期限在这套系统里最容易变成**只写不读**：生成时写进去当钩子，生成后没人回来对账。若这条期限只是随口一句、不再重要，也就用一句话收掉它，别让它一直悬着。
钩子以外的悬置承诺也要接（issue #35）：上一章正文留下的悬置事情通常不止一件——谁答应替班、谁答应交出某物、谁说了明晚再来、要求谁闭嘴、谁被点名顶替。目前只有登记在案的 suspenseHook 有下游通道，其余全凭模型自觉。当材料/参考里列出「上一章正文留下而尚未落地的承诺或决定」时，本章必须继续推进、反转或在 keyEvents 里明确搁置（写明搁置了什么、为什么）。一个人物当众说出口的决定，后续章节整章不提，读者读到的是「这条线断了」。
关键道具必须当面易手（issue #38）：谁持有物件由正文决定，不由蓝图决定。上一章某件关键物件被拒绝交出、被夺走、或结尾仍在他人手上时，本章不得直接写成本视角人物「从怀里摸出」——必须在 keyEvents 里写出交接动作（谁交给谁、在什么条件下）或另一次夺取。不得因为蓝图写了「某人推过来」就把物件当成本方已有：读者只认页面上发生过的动作。蓝图自身也不要写「温珩推过来的油纸包」这种原文里并不存在的既成事实。
**笔迹特征必须一致**（issue #97）：若本书的核心能力是「靠笔迹认出是谁的手」，同一个书写者的笔迹特征（起笔／横折／收笔／笔压）在全书中只能有一套；不得把同一个人写成「横折收得急」又写成「稳、匀，起笔带锋」，也不得把同一句特征安在两个不同的人身上——那会让读者拿不到可对照的特征表，任何一次「我认出来了」都失去依据。若确实要写笔迹变化（手受伤、被人仿写、临时被指使），就在正文里写明为什么会变。同一章内不得自相矛盾（issue #19）：本章 keyEvents 不得一边写「收走／夺走／烧掉／交出」某件关键道具，一边又让同一方读取或使用它。若本章确实要先失去再拿回，必须把重新取得的过程写成独立事件（谁还回来、付出什么），否则把这两件事拆到不同章节。尤其不得把「凭记忆复现」当成读取实物——前文规则要求读取的是实物上的墨层，记忆不能替代它。
**能力的硬限制不得静默绕过**（issue #100）：世界观若给核心能力写死了触发条件（「离船上岸即失效」「只能在夜里」「必须见血」这类），本章就不得让它在受限条件下照样成功——**除非本章把这件事写成一次发现**（哪怕一句「他试过，补上水汽就成」），或写清绕法的代价。读者读到的是「作者亲手立的规矩后面自己破掉且不解释」，比能力弱更伤信任；而这类限制往往正是全书的节奏发动机（「每夜都在跟水汽赛跑」），它一失效，后面所有「抢时间」的戏都失去压力来源。若这条限制本来就不打算要，就回去改世界观与相关伏笔，别让它原地消失。
characters 必须只写具名角色（角色名单里已建档的，或本章 newCharacterCandidates 声明的），至少含一个唯一非空姓名。凡不在角色名单里的具名角色，**必须**同时写进本章 newCharacterCandidates（含 role），否则不得写进 characters：未声明的名字不会建卡，定稿后的角色状态回写与一致性检查都收不到他，下一章起草时对他也毫无记忆（issue #42）。只出场一次、不承担情节的路人，改用身份称呼写进 keyEvents，不要起名字。「检测教员」「门卫」「店员」这类只有身份没有姓名的角色不得写进 characters，只能写进 keyEvents 的场景描述。
newCharacterCandidates 可选；提供时只声明由本章首次引入且预计后续复用的重要具名角色，每项必须包含 name、role，name 必须逐字复制 characters 中的一个完整姓名，role 只能是 protagonist、antagonist、supporting、minor。无候选时可省略或传 []，一次性路人不得声明为候选。
relationships 必须是数组，无关系时传 []；每项必须含非空 from、to、relation，from/to 必须精确出现在同项 characters 中且不能自指。
costsAndTurns 必填：写明本章当场付出的具体代价或不可逆后果（有限、可追溯）。确实没有付出时，用一句短话说明。代价必须轮换：不得与相邻章（上一章的代价见 recentBlueprints 的 costs 字段）使用同一种代价类型或同一个桥段模板；上一章刚付过同类代价时，本章必须换一种付法。代价必须留账（issue #36）：写进 costsAndTurns 的必须是「付出去、且在本章没有被抹平」的代价——遗忘的信息不得在本章内被无偿想起，丢失的东西不得隔一句就捡回，伤势、时限、暴露风险不得下一段就消失。角色要找回或解除损失，必须付出另一笔代价（再溯读一次、求人提醒、暴露行踪、放弃别的东西），并把这一笔也写清；严禁把「怎么找回来」写进代价字段（「忘了存根藏在哪一侧，摸了半条水隔才找着」这种写法等于没有代价）。
foreshadowing 必填：写明本章埋下或回收的伏笔；本章没有时写 none。
收束方式必须轮换（issue #28）：在 keyEvents 末尾用「【收束：类型】」标注本章的落幅方式，类型只能是：人物动作收束、对话收束、物件落幅、时空切换、悬念直陈、内心独白。相邻若干章不得连续使用同一种落幅，尤其不得连续让同一个角色以同一个姿态（站在舱门/梯口、一言不发）收尾——即使每章钩子各不相同，落幅同构仍会让读者分辨不出读到第几章。references 里给了最近几章的落幅沿用情况，先看清再选本章的收束方式。
场景装置必须轮换（issue #32）：在 keyEvents 末尾另用「【装置：地点＋起手动作】」标注本章核心戏的搭建方式（如「舱底＋拧水隔」「码头售票口＋翻票根」）。同一套「地点＋起手动作」不得与相邻章重复——尤其是能力使用场景（金手指、验尸、查账这类每章都要来一次的动作），必须换场合、换起手，不得连续多章都是「回船上→进舱底→拧水隔→蘸水」。references 里给了最近几章的装置，先看清再选。时点必须写明（issue #84）：在 keyEvents 末尾另用「【时点：…】」标注本章发生在**什么时候**（例：「当夜（紧接上一章）」「次日清晨」「三日后」「同日深夜」）。这是全链路唯一产出时间推进的地方——不标它，起草契约的「同一天紧接」默认就永远生效，跨日永远写不出来（实测一本 34 章的书「次日/翌日/第二天/半个月」合计 0 次，「昨夜」在 11 章里指代不明）。连续多章都发生在同一夜且不标时点时，读者会读成同一夜反复。
人物反应必须换写法（issue #33）：同一人物面对追问、受挫、被威胁时的反应，不得连续多章都用同一批否定式短句（没动／没答／没应／没说话／一言不发）表达。该沉默时换一种呈现——身体动作、视线、呼吸、手上的活、换一个时间点切走——也不要把「提问→对方不回答」当成每章的固定收场动作。人物进场动作必须轮换（issue #82）：不得连续多章都让角色以同一个低身姿态（蹲／半蹲／俯身／弯腰／屈膝）进入场景——样本里 26 章有 19 章都从「某人蹲下」开始（全书 40 次、配角 11 章出场里 10 章同段含「蹲」），读者读到第 10 章左右就能预判「下一段他要蹲下来做点什么」，角色的区分度也被抹掉。写这个角色怎么进这一场戏时，换掉那套固定动作：让他站着／走着／先出声／手里正忙着别的事／被人叫住进场，把「他怎么做这件事」写成可辨认这个人的信息。
from/to 必须逐字复制同一项 characters 中的完整字符串；任一端点不在 characters 时，删除该关系或使用 []，不得发明别名、简称或补写角色。
叙述内容须保持完整。
不得省略必填字段、合并章节、输出近义字段、解释、Markdown 或代码围栏。`
}

/**
 * Provider-neutral generation fact. Persistence-only fields are deliberately
 * absent: callers add those after the model result has crossed this seam.
 */
export interface BlueprintSemanticItem {
  chapterNumber: number
  title: string
  role: string
  purpose: string
  keyEvents: string
  characters: string[]
  newCharacterCandidates: BlueprintNewCharacterCandidate[]
  relationshipHints: BlueprintRelationshipFact[]
  suspenseHook: string
  /** Turn and cost paid in this chapter. */
  costsAndTurns: string
  /** Foreshadowing planted or paid off here. */
  foreshadowing: string
}

export interface BlueprintAuthorItem extends BlueprintSemanticItem {
  userGuidance: string
  notes: string
  notesUpdatedAt: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function fieldValue(
  value: Record<string, unknown>,
  canonical: string,
  aliases: readonly string[] = [],
): unknown {
  if (Object.hasOwn(value, canonical)) return value[canonical]
  for (const alias of aliases) {
    if (Object.hasOwn(value, alias)) return value[alias]
  }
  return undefined
}

function requiredText(value: unknown, path: string): string {
  if (value === undefined) throw new StructuredContractDiagnostic('missing_field', path)
  if (typeof value !== 'string') throw new StructuredContractDiagnostic('invalid_type', path)
  if (!value.trim()) throw new StructuredContractDiagnostic('empty_value', path)
  return value.trim()
}

function normalizedChapterNumber(value: Record<string, unknown>, path: string): number {
  const candidate = fieldValue(value, 'chapterNumber', ['chapter_number'])
  if (candidate === undefined) throw new StructuredContractDiagnostic('missing_field', `${path}.chapterNumber`)
  if (typeof candidate !== 'number' && typeof candidate !== 'string') {
    throw new StructuredContractDiagnostic('invalid_type', `${path}.chapterNumber`)
  }
  const chapterNumber = Number(candidate)
  if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1) {
    throw new StructuredContractDiagnostic('invalid_value', `${path}.chapterNumber`)
  }
  return chapterNumber
}

function normalizedCharacters(value: unknown, path: string): string[] {
  if (value === undefined) throw new StructuredContractDiagnostic('missing_field', path)
  if (!Array.isArray(value)) throw new StructuredContractDiagnostic('invalid_type', path)
  if (value.length === 0) throw new StructuredContractDiagnostic('invalid_value', path)
  const characters = value.map((candidate, index) => requiredText(candidate, `${path}[${index}]`))
  if (new Set(characters).size !== characters.length) {
    throw new StructuredContractDiagnostic('duplicate_item', path)
  }
  return characters
}

function normalizedRelationships(
  value: unknown,
  path: string,
  characters: readonly string[],
): BlueprintRelationshipFact[] {
  if (value === undefined) throw new StructuredContractDiagnostic('missing_field', path)
  if (!Array.isArray(value)) throw new StructuredContractDiagnostic('invalid_type', path)
  const characterSet = new Set(characters)
  const seen = new Set<string>()
  return value.map((candidate, index) => {
    const relationshipPath = `${path}[${index}]`
    if (!isRecord(candidate)) {
      throw new StructuredContractDiagnostic('invalid_type', relationshipPath)
    }
    const from = requiredText(fieldValue(candidate, 'from', ['source']), `${relationshipPath}.from`)
    const to = requiredText(fieldValue(candidate, 'to', ['target']), `${relationshipPath}.to`)
    const relation = requiredText(candidate.relation, `${relationshipPath}.relation`)
    if (from === to) {
      throw new StructuredContractDiagnostic('relationship_self_reference', relationshipPath)
    }
    if (!characterSet.has(from) || !characterSet.has(to)) {
      throw new StructuredContractDiagnostic('relationship_endpoint_not_in_characters', relationshipPath)
    }
    const key = `${from}\u0000${to}\u0000${relation}`
    if (seen.has(key)) throw new StructuredContractDiagnostic('duplicate_item', path)
    seen.add(key)
    return { from, to, relation }
  })
}

function normalizedNewCharacterCandidates(
  value: unknown,
  path: string,
  characters: readonly string[],
): BlueprintNewCharacterCandidate[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new StructuredContractDiagnostic('invalid_type', path)
  const characterSet = new Set(characters)
  const seen = new Set<string>()
  return value.map((candidate, index) => {
    const candidatePath = `${path}[${index}]`
    if (!isRecord(candidate)) throw new StructuredContractDiagnostic('invalid_type', candidatePath)
    const name = requiredText(candidate.name, `${candidatePath}.name`)
    if (!characterSet.has(name)) {
      throw new StructuredContractDiagnostic('invalid_value', `${candidatePath}.name`)
    }
    if (seen.has(name)) throw new StructuredContractDiagnostic('duplicate_item', path)
    seen.add(name)
    const role = requiredText(candidate.role, `${candidatePath}.role`)
    if (!CHARACTER_ROLES.includes(role as CharacterRole)) {
      throw new StructuredContractDiagnostic('invalid_value', `${candidatePath}.role`)
    }
    return { name, role: role as CharacterRole }
  })
}

export function validateBlueprintSemanticItem(value: unknown): string | undefined {
  try {
    normalizeBlueprintSemanticItem(value)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export function normalizeBlueprintSemanticItem(value: unknown, path = 'blueprint'): BlueprintSemanticItem {
  if (!isRecord(value)) throw new StructuredContractDiagnostic('invalid_type', path)
  const chapterNumber = normalizedChapterNumber(value, path)
  const characters = normalizedCharacters(value.characters, `${path}.characters`)
  const newCharacterCandidates = normalizedNewCharacterCandidates(
    fieldValue(value, 'newCharacterCandidates', ['new_character_candidates']),
    `${path}.newCharacterCandidates`,
    characters,
  )
  const relationshipHints = normalizedRelationships(
    fieldValue(value, 'relationships', ['relationshipHints', 'relations']),
    `${path}.relationships`,
    characters,
  )
  return {
    chapterNumber,
    title: requiredText(value.title, `${path}.title`),
    role: requiredText(value.role, `${path}.role`),
    purpose: requiredText(value.purpose, `${path}.purpose`),
    keyEvents: requiredText(
      fieldValue(value, 'keyEvents', ['key_events']),
      `${path}.keyEvents`,
    ),
    characters,
    newCharacterCandidates,
    relationshipHints,
    suspenseHook: requiredText(
      fieldValue(value, 'suspenseHook', ['suspense_hook']),
      `${path}.suspenseHook`,
    ),
    costsAndTurns: requiredText(
      fieldValue(value, 'costsAndTurns', ['costs_and_turns']),
      `${path}.costsAndTurns`,
    ),
    foreshadowing: requiredText(
      fieldValue(value, 'foreshadowing'),
      `${path}.foreshadowing`,
    ),
  }
}

/**
 * 标题唯一性比对的归一化（issue #110）：剥掉首尾空白与**尾部**标点。
 *
 * 「无人认领，」与「无人认领」只差一个尾标点——不剥掉就会漏过（issue 建议里点名的第一种）。
 * 只剥尾部：句中的逗号是内容（「无人认领，一并化浆」与「无人认领」的区别正是那个分句）。
 */
function normalizeTitleForUniqueness(title: unknown): string {
  return String(title ?? '').trim().replace(/[\s，,。.、；;：:！!？?…]+$/u, '')
}

/**
 * 这个标题是否**复用**了已有标题（issue #110）。
 *
 * 判据：与任一已有标题**互为前缀（含相等）**。这样「压印」/「压印的」与
 * 「无人认领」/「无人认领，一并化浆」都命中，而「空着的那一格」/「空着的第二格」
 * （只共享前 3 字、谁也不含谁）正确地不报。
 *
 * ⚠️ **长度下限 2 字**：单字标题会互相吞（「印」是「压印」的前缀），那会把正常的
 * 单字标题判成重名——本仓 #87 的教训（排序后取前 N 要先按对象分配名额）。
 * 两侧都要 ≥2 字才判：任一侧是单字就不比，宁漏不误报。
 */
function titleIsReused(title: string, existing: readonly string[]): boolean {
  if (title.length < TITLE_UNIQUENESS_MIN_CHARS) return false
  return existing.some(candidate => candidate.length >= TITLE_UNIQUENESS_MIN_CHARS
    && (candidate.startsWith(title) || title.startsWith(candidate)))
}

/** 互为前缀判重的最短长度（issue #110）：单字标题会互相吞，不参与比较。 */
export const TITLE_UNIQUENESS_MIN_CHARS = 2

export function decodeBlueprintSemanticPayload(
  payload: unknown,
  expectedChapterNumbers: readonly number[],
  existingTitles: readonly string[] = [],
): BlueprintSemanticItem[] {
  const candidates = isRecord(payload) && Object.hasOwn(payload, 'blueprints')
    ? payload.blueprints
    : payload
  if (!Array.isArray(candidates)) throw new StructuredContractDiagnostic('invalid_envelope', 'blueprints')

  const expected = new Set(expectedChapterNumbers)
  if (
    expected.size !== expectedChapterNumbers.length
    || expectedChapterNumbers.some(chapter => !Number.isSafeInteger(chapter) || chapter < 1)
  ) {
    throw new StructuredContractDiagnostic('invalid_value', 'expectedChapterNumbers')
  }

  const decoded = candidates.map((candidate, index) => normalizeBlueprintSemanticItem(candidate, `blueprints[${index}]`))
  const seen = new Set<number>()
  // 标题去重：同一批内同名、或与已有章节同名（如两章都叫「待核」）都是合同违规——
  // 标题是目录里最显眼的身份，重名意味着场景重演已经发生（issue #16）。
  //
  // issue #110：「同名」不能只判**精确相等**。「压印」/「压印的」（第 15、21 章）与
  // 「无人认领」/「无人认领，一并化浆」（第 18、22 章）在字面上不同，但读者在目录里读到的
  // 是同一章被写了两遍——「无人认领」本身已是完整断语，第 22 章只在后面加了个补充分句。
  // 而合同写的约束是「title 必须全书唯一：不得复用已有章节的标题」，按本意它们是违反。
  // 现在改成**互为前缀（含相等）即视为复用**，双向判（否则只挡「新标题更长」那种顺序）。
  const titles = [...new Set(existingTitles.map(normalizeTitleForUniqueness))].filter(Boolean)
  for (const blueprint of decoded) {
    if (seen.has(blueprint.chapterNumber)) {
      throw new StructuredContractDiagnostic('duplicate_item', 'blueprints')
    }
    seen.add(blueprint.chapterNumber)
    const title = normalizeTitleForUniqueness(blueprint.title)
    if (titleIsReused(title, titles)) {
      throw new StructuredContractDiagnostic('duplicate_title', 'blueprints.title')
    }
    titles.push(title)
    if (!expected.has(blueprint.chapterNumber)) {
      throw new StructuredContractDiagnostic('unexpected_item', 'blueprints')
    }
  }
  const missing = expectedChapterNumbers.filter(chapter => !seen.has(chapter))
  if (missing.length > 0) {
    throw new StructuredContractDiagnostic('missing_item', 'blueprints')
  }
  return decoded.sort((left, right) => left.chapterNumber - right.chapterNumber)
}

/**
 * Accepts exactly one JSON root or one complete Markdown JSON fence. It never
 * searches narrative prose for a nested JSON fragment.
 */
function parseBlueprintJsonText(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed)
  const candidate = fenced ? fenced[1].trim() : trimmed
  if (!candidate || !/^[{[]/u.test(candidate)) {
    throw new StructuredContractDiagnostic('invalid_envelope', '$')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    throw new StructuredContractDiagnostic('invalid_json', '$')
  }
  return parsed
}

export function parseBlueprintSemanticResponseText(text: string, expectedChapterNumbers: readonly number[],
  existingTitles: readonly string[] = []): BlueprintSemanticItem[] {
  return decodeBlueprintSemanticPayload(parseBlueprintJsonText(text), expectedChapterNumbers, existingTitles)
}

export function decodeBlueprintAuthorPayload(payload: unknown, expectedChapterNumbers: readonly number[]): BlueprintAuthorItem[] {
  const decoded = decodeBlueprintSemanticPayload(payload, expectedChapterNumbers)
  const candidates = isRecord(payload) && Object.hasOwn(payload, 'blueprints') ? payload.blueprints : payload
  if (!Array.isArray(candidates)) throw new StructuredContractDiagnostic('invalid_envelope', 'blueprints')
  const authorFields = new Map(candidates.map((candidate, index) => {
    const path = `blueprints[${index}]`
    if (!isRecord(candidate)) throw new StructuredContractDiagnostic('invalid_type', path)
    const optionalText = (key: 'userGuidance' | 'notes' | 'notesUpdatedAt'): string => {
      const value = candidate[key]
      if (value === undefined) return ''
      if (typeof value !== 'string') throw new StructuredContractDiagnostic('invalid_type', `${path}.${key}`)
      return value
    }
    return [normalizedChapterNumber(candidate, path), {
      userGuidance: optionalText('userGuidance'), notes: optionalText('notes'), notesUpdatedAt: optionalText('notesUpdatedAt'),
    }] as const
  }))
  return decoded.map(item => ({ ...item, ...authorFields.get(item.chapterNumber)! }))
}

export function parseBlueprintAuthorResponseText(text: string, expectedChapterNumbers: readonly number[]): BlueprintAuthorItem[] {
  return decodeBlueprintAuthorPayload(parseBlueprintJsonText(text), expectedChapterNumbers)
}

/** 场景装置标注（「…【装置：舱底＋拧水隔】」）：蓝图合同要求标出核心戏的搭建方式（issue #32）。 */
export function stagingOf(keyEvents: string): string {
  const matches = [...String(keyEvents ?? '').matchAll(/【\s*装置\s*[:：]\s*([^】]{1,40})】/gu)]
  return matches.at(-1)?.[1]?.trim() ?? ''
}

/**
 * 把机器读的标注从 keyEvents 正文里拆出来（issue #65）。
 *
 * 标注是下游读的（`closingShotOf` / `stagingOf`），但它被写进了作者可编辑的
 * 「冲突与转折」框末尾：作者手改这一段时会把标注一起改坏或删掉，而没有任何提示
 * 说它是机器读的。界面因此要把两者分开显示——正文进编辑框，标注以只读形式展示，
 * 保存时再原样拼回去。
 *
 * 只认合同里的那三个标注形态；正文里偶然出现的其他【】不动（可能是作者自己的写法）。
 */
export function splitBlueprintLabels(keyEvents: string): { prose: string; labels: string[] } {
  const source = String(keyEvents ?? '')
  const labels: string[] = []
  const prose = source
    // 时点（issue #84）：与收束/装置同为机器读的标注，一并拆出、一并拼回。
    // 用 `chapter-time-anchor.ts` 的常量而不是就地再写一遍正则——两处形态必须同源，
    // 否则读标注的 `timeAnchorOf` 与拆标注的这里会慢慢漂开。
    .replace(BLUEPRINT_TIME_ANCHOR_LABEL_PATTERN, (match) => {
      labels.push(match.trim())
      return ''
    })
    .replace(/\s*【\s*(?:收束|装置)\s*[:：][^】]{0,60}】/gu, (match) => {
      labels.push(match.trim())
      return ''
    })
    .replace(/^\s+/u, '')
    .trim()
  return { prose, labels }
}

/** 机器读的标注类别（同类别只应有一条：下游按类别取值）。 */
export type BlueprintLabelKind = '时点' | '收束' | '装置'

/** 取一条标注的类别；不是三类标注则返回 null。 */
export function blueprintLabelKind(label: string): BlueprintLabelKind | null {
  const match = /^【\s*(时点|收束|装置)\s*[:：]/u.exec(String(label ?? '').trim())
  return match ? match[1] as BlueprintLabelKind : null
}

/**
 * 把正文与标注拼回 keyEvents（与 `splitBlueprintLabels` 互逆）。
 *
 * ⚠️ **同类别只保留一条，且正文里那条优先**（issue #91）。
 *
 * 原来的实现是「正文 + 所有旧标注直接拼接」。而作者能写字的只有正文框（标注是只读 chip），
 * 于是他照预检提示在正文里写下的新标注会**排在旧标注前面**，库里因此出现
 * 「【收束：物件落幅】【收束：悬念直陈】」这种同类并存；三个下游读取函数全部取
 * `matches.at(-1)` —— **读到的永远是那条旧的**，作者以为改好了，其实一点没生效
 * （实测：正文写【收束：物件落幅】，`closingShotOf` 仍返回「悬念直陈」）。
 *
 * 现在按类别归并：正文里写了的类别以正文为准，同名旧标注被丢弃；正文没写的类别
 * 才用传入的 chip 补上（作者只改了正文、没动 chip 时行为不变）。
 */
export function joinBlueprintLabels(prose: string, labels: readonly string[]): string {
  // 正文里可能已经带着作者手写的标注——先按类别收出来。
  const split = splitBlueprintLabels(prose)
  const chosen = new Map<BlueprintLabelKind, string>()
  // chip（界面拆出来的）先入，正文里的**后入覆盖**：作者的手写优先。
  const order: Array<{ kind: BlueprintLabelKind | null; text: string }> = []
  for (const label of labels) order.push({ kind: blueprintLabelKind(label), text: String(label).trim() })
  for (const label of split.labels) order.push({ kind: blueprintLabelKind(label), text: String(label).trim() })
  const extras: string[] = []
  for (const item of order) {
    if (!item.text) continue
    if (!item.kind) { extras.push(item.text); continue }
    chosen.set(item.kind, item.text)   // 后出现的同类覆盖先出现的
  }
  const body = split.prose.trim()
  const suffix = [...chosen.values(), ...extras].join('')
  return suffix ? `${body}${suffix}` : body
}

/** 收束方式类型：蓝图合同要求 keyEvents 末尾标注本章落幅（issue #28）。 */
export const BLUEPRINT_CLOSING_SHOT_TYPES = Object.freeze([
  '人物动作收束', '对话收束', '物件落幅', '时空切换', '悬念直陈', '内心独白',
] as const)

export type BlueprintClosingShot = typeof BLUEPRINT_CLOSING_SHOT_TYPES[number]

/**
 * 从 keyEvents 里取出收束方式标注（「…【收束：物件落幅】」）。
 *
 * 只认合同里列出的六种类型，返回标准写法；没有标注或类型不认识时返回空串——
 * 调用方据此要么展示「未标注」，要么把本章的落幅摘要交给起草侧，绝不猜测。
 */
export function closingShotOf(keyEvents: string): BlueprintClosingShot | '' {
  const matches = [...String(keyEvents ?? '').matchAll(/【\s*收束\s*[:：]\s*([^】]{1,24})】/gu)]
  const last = matches.at(-1)?.[1]?.trim()
  if (!last) return ''
  return (BLUEPRINT_CLOSING_SHOT_TYPES as readonly string[]).includes(last) ? last as BlueprintClosingShot : ''
}
