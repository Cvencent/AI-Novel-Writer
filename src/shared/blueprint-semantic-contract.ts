import { StructuredContractDiagnostic } from './structured-contract-diagnostic'
import { CHARACTER_ROLES, type CharacterRole } from './character-role'
import type { WritingLanguage } from './writing-language'

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
chapterNumber must cover every target chapter exactly once, without duplicates or out-of-range values. title, role, purpose, keyEvents, and suspenseHook must be non-empty strings. title must be unique across the whole book: never reuse a title from an earlier chapter (recentBlueprints/chapter_list), and keyEvents must not replay a scene already written in a finalized chapter.
suspenseHook is always required; even without a mystery, state one concrete unresolved decision, threat, revelation, or consequence that creates forward pressure.
Hook carry-over is required (issue #20): this chapter must explicitly address the previous chapter's suspenseHook (its name/person/object/decision is in recentBlueprints). Continue it, twist it, or settle it — and if it is deliberately deferred, say so and why in this chapter's keyEvents. Never silently switch to an unrelated topic: a hook whose line is simply dropped reads to the reader as a broken promise.
Pending decisions outside the hook must also carry over (issue #35): the previous chapter's prose usually leaves more than one thing hanging — someone promised to take a shift, hand over an object, come back at a stated time, keep quiet, or stand in for another. Only the recorded suspenseHook is guaranteed to be handled downstream. When references/the material list a predecessor item the previous chapter's prose left open, this chapter must either advance it, twist it, or defer it explicitly in keyEvents (saying what is deferred and why). A decision a character stated aloud and that no later chapter ever mentions reads to the reader as an unfinished thread.
Key objects must change hands on the page (issue #38): prose, not the blueprint, decides who holds an object. When a key object was refused, seized, or ended in another character's hands in the previous chapter, this chapter may not simply have the viewpoint character produce it — keyEvents must show the handoff (who gives it to whom, under what condition) or another seizure. Never describe an object as "already in his pocket" because the blueprint said it was handed over: the reader only believes what happened on the page.
characters must list named people only (already in the character facts, or declared in this item's newCharacterCandidates), with at least one unique non-empty full name. Role-only labels such as "the examiner", "the guard" or "the clerk" must never appear in characters; describe them in keyEvents instead.
newCharacterCandidates is optional. When present, include only important named characters first introduced by this blueprint and expected to recur. Every item must contain name and role, name must exactly copy one entry from characters, and role must be protagonist, antagonist, supporting, or minor. Omit it or use [] when there are no candidates; never include incidental figures.
relationships is required and may be []; every item must contain non-empty from, to, and relation fields. from and to must exactly copy full names from the same item's characters array and may not self-reference.
costsAndTurns is required: state the concrete cost or irreversible consequence paid in this chapter (bounded, traceable). When nothing is paid, say so in one short clause. The cost must rotate: never reuse the same cost type or the same beat template as the adjacent chapters (the previous chapters' costs are in recentBlueprints); when the golden-finger's price was paid the same way last chapter, pay a different kind of price this chapter. The cost must leave a ledger (issue #36): whatever is written in costsAndTurns must still be unpaid at the end of this chapter — a forgotten fact may not be recovered for free in the same chapter, a lost item may not be picked back up two sentences later, and an injury, deadline, or exposure risk may not evaporate on the next page. To recover or lift a loss, the character must pay another price (read again, ask someone, expose their position, give something up) and that new price must be written down too. Never write the recovery into the cost field itself ("forgot where the stub was, felt along the water lock and found it" is not a cost).
foreshadowing is required: state what this chapter plants or pays off. Write none when the chapter carries none.
Closing shot must rotate (issue #28): end keyEvents with a "【收束：类型】" label naming this chapter's closing shot, from only these types: character-action close, dialogue close, object close, time/place switch, direct question close, interior monologue. Adjacent chapters must not repeat the same closing shot, and must never end on the same character holding the same pose (standing in the doorway, saying nothing) chapter after chapter — a repeated close makes chapters indistinguishable even when every hook differs. References list the recent chapters' closing shots; read them before choosing.
Staging must rotate (issue #32): also end keyEvents with a "【装置：地点＋起手动作】" label naming how this chapter's core scene is set up (e.g. "舱底＋拧水隔"). The same place-plus-opening-action pair must not repeat in adjacent chapters — especially for a recurring ability scene (the golden-finger read, an examination, an audit), change the setting and the opening move; never run the same "back aboard → down to the hold → turn the water lock → dip the stub" sequence chapter after chapter.
Character reactions must vary (issue #33): do not express the same character's reaction to questioning, setback, or threat with the same negated micro-phrase (did not move / did not answer / said nothing) chapter after chapter. When they stay silent, show it differently — a bodily action, a glance, breathing, the work in their hands, or cut away to another moment — and do not make "asked a question → the other party answers nothing" your every chapter's closing beat.
Preserve complete narrative content.
Do not omit required fields, combine chapters, rename fields, explain, or output Markdown or code fences.`
  }
  return `【不可变蓝图 JSON 合同】
只输出 {"blueprints":[...]}，每项必须完整包含：${BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST.requiredFields.join('、')}。
chapterNumber 必须覆盖本批每个目标章节且不得重复或越界；title、role、purpose、keyEvents、suspenseHook 必须是非空字符串。title 必须全书唯一：不得复用已有章节的标题（见 recentBlueprints/chapter_list），keyEvents 不得重演已定稿章节里已经写过的场景。
suspenseHook 始终必填；即使本章没有谜团，也要写明一个制造推进压力的具体未决决定、威胁、揭示或后果。
上一章钩子必须接（issue #20）：本章必须显式回应上一章的 suspenseHook（其具名的人/物/决定见 recentBlueprints）——继续推进、反转或了结皆可；确实要搁置时，必须在本章 keyEvents 里写明「搁置了什么、为什么」。不得默默换成无关话题：钩子点名的人或决定在本章再不出现，读者读到的是「上一个坑没人埋」。
钩子以外的悬置承诺也要接（issue #35）：上一章正文留下的悬置事情通常不止一件——谁答应替班、谁答应交出某物、谁说了明晚再来、要求谁闭嘴、谁被点名顶替。目前只有登记在案的 suspenseHook 有下游通道，其余全凭模型自觉。当材料/参考里列出「上一章正文留下而尚未落地的承诺或决定」时，本章必须继续推进、反转或在 keyEvents 里明确搁置（写明搁置了什么、为什么）。一个人物当众说出口的决定，后续章节整章不提，读者读到的是「这条线断了」。
关键道具必须当面易手（issue #38）：谁持有物件由正文决定，不由蓝图决定。上一章某件关键物件被拒绝交出、被夺走、或结尾仍在他人手上时，本章不得直接写成本视角人物「从怀里摸出」——必须在 keyEvents 里写出交接动作（谁交给谁、在什么条件下）或另一次夺取。不得因为蓝图写了「某人推过来」就把物件当成本方已有：读者只认页面上发生过的动作。蓝图自身也不要写「温珩推过来的油纸包」这种原文里并不存在的既成事实。
characters 必须只写具名角色（角色名单里已建档的，或本章 newCharacterCandidates 声明的），至少含一个唯一非空姓名。「检测教员」「门卫」「店员」这类只有身份没有姓名的角色不得写进 characters，只能写进 keyEvents 的场景描述。
newCharacterCandidates 可选；提供时只声明由本章首次引入且预计后续复用的重要具名角色，每项必须包含 name、role，name 必须逐字复制 characters 中的一个完整姓名，role 只能是 protagonist、antagonist、supporting、minor。无候选时可省略或传 []，一次性路人不得声明为候选。
relationships 必须是数组，无关系时传 []；每项必须含非空 from、to、relation，from/to 必须精确出现在同项 characters 中且不能自指。
costsAndTurns 必填：写明本章当场付出的具体代价或不可逆后果（有限、可追溯）。确实没有付出时，用一句短话说明。代价必须轮换：不得与相邻章（上一章的代价见 recentBlueprints 的 costs 字段）使用同一种代价类型或同一个桥段模板；上一章刚付过同类代价时，本章必须换一种付法。代价必须留账（issue #36）：写进 costsAndTurns 的必须是「付出去、且在本章没有被抹平」的代价——遗忘的信息不得在本章内被无偿想起，丢失的东西不得隔一句就捡回，伤势、时限、暴露风险不得下一段就消失。角色要找回或解除损失，必须付出另一笔代价（再溯读一次、求人提醒、暴露行踪、放弃别的东西），并把这一笔也写清；严禁把「怎么找回来」写进代价字段（「忘了存根藏在哪一侧，摸了半条水隔才找着」这种写法等于没有代价）。
foreshadowing 必填：写明本章埋下或回收的伏笔；本章没有时写 none。
收束方式必须轮换（issue #28）：在 keyEvents 末尾用「【收束：类型】」标注本章的落幅方式，类型只能是：人物动作收束、对话收束、物件落幅、时空切换、悬念直陈、内心独白。相邻若干章不得连续使用同一种落幅，尤其不得连续让同一个角色以同一个姿态（站在舱门/梯口、一言不发）收尾——即使每章钩子各不相同，落幅同构仍会让读者分辨不出读到第几章。references 里给了最近几章的落幅沿用情况，先看清再选本章的收束方式。
场景装置必须轮换（issue #32）：在 keyEvents 末尾另用「【装置：地点＋起手动作】」标注本章核心戏的搭建方式（如「舱底＋拧水隔」「码头售票口＋翻票根」）。同一套「地点＋起手动作」不得与相邻章重复——尤其是能力使用场景（金手指、验尸、查账这类每章都要来一次的动作），必须换场合、换起手，不得连续多章都是「回船上→进舱底→拧水隔→蘸水」。references 里给了最近几章的装置，先看清再选。
人物反应必须换写法（issue #33）：同一人物面对追问、受挫、被威胁时的反应，不得连续多章都用同一批否定式短句（没动／没答／没应／没说话／一言不发）表达。该沉默时换一种呈现——身体动作、视线、呼吸、手上的活、换一个时间点切走——也不要把「提问→对方不回答」当成每章的固定收场动作。
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
  const titles = new Set(existingTitles.map(title => title.trim()))
  for (const blueprint of decoded) {
    if (seen.has(blueprint.chapterNumber)) {
      throw new StructuredContractDiagnostic('duplicate_item', 'blueprints')
    }
    seen.add(blueprint.chapterNumber)
    const title = blueprint.title.trim()
    if (titles.has(title)) {
      throw new StructuredContractDiagnostic('duplicate_title', 'blueprints.title')
    }
    titles.add(title)
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
