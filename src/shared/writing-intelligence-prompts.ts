import type { WritingLanguage } from './writing-language'
import type { BlueprintForPreflight } from './consistency-preflight'

export interface ScenePlanPromptInput {
  chapterNumber: number
  blueprint: BlueprintForPreflight
  characters: readonly { name: string; role: string; profile: string }[]
  architecture: string
  targetWords: number
  language: WritingLanguage
}

export function buildScenePlanPrompt(input: ScenePlanPromptInput): string {
  const facts = {
    chapterNumber: input.chapterNumber,
    title: input.blueprint.title,
    role: input.blueprint.role,
    purpose: input.blueprint.purpose,
    keyEvents: input.blueprint.keyEvents,
    characters: input.characters,
    suspenseHook: input.blueprint.suspenseHook,
    costsAndTurns: input.blueprint.costsAndTurns ?? '',
    foreshadowing: input.blueprint.foreshadowing ?? '',
    authorGuidance: input.blueprint.userGuidance,
    notes: input.blueprint.notes,
    architecture: input.architecture,
    targetWords: input.targetWords,
  }
  if (input.language === 'en-US') return `Design the scene cards for one chapter.\n\n[Authoritative chapter facts]\n${JSON.stringify(facts, null, 2)}\n\n[Rules]\n- Return 2-8 scenes in chronological order.\n- Every scene must have a goal, concrete resistance, a turn, and an outcome that changes the situation.\n- Do not add events, characters, locations, or facts absent from the chapter facts.\n- The scenes together must realize purpose, keyEvents, costsAndTurns, foreshadowing and suspenseHook.\n- Total targetWords should stay close to the chapter target.\n- Output JSON only: {"scenes":[{"id":"scene-1","title":"","goal":"","conflict":"","turn":"","outcome":"","characters":[""],"targetWords":0,"notes":""}]}.\n`
  return `请为单章设计可执行场景卡。\n\n【本章权威事实】\n${JSON.stringify(facts, null, 2)}\n\n【硬性要求】\n- 按时间顺序输出 2–8 个场景。\n- 每个场景必须有目标、具体阻力、转折、结果，并且结果要改变局面。\n- 不得新增本章事实中没有的事件、角色、地点或设定。\n- 所有场景合起来必须落实本章 purpose、keyEvents、costsAndTurns、foreshadowing 与 suspenseHook。\n- 各场景 targetWords 之和应接近本章目标字数。\n- 只输出 JSON：{"scenes":[{"id":"scene-1","title":"","goal":"","conflict":"","turn":"","outcome":"","characters":[""],"targetWords":0,"notes":""}]}。\n`
}

export interface EditorialPanelPromptInput {
  chapterNumber: number
  draftVersion: number
  content: string
  blueprint: BlueprintForPreflight
  roster: readonly { characterId: string; name: string; role: string; profile: string }[]
  narrativeConstraints: string
  language: WritingLanguage
}

export function buildEditorialPanelPrompt(input: EditorialPanelPromptInput): string {
  const facts = {
    chapterNumber: input.chapterNumber,
    draftVersion: input.draftVersion,
    blueprint: input.blueprint,
    roster: input.roster,
    narrativeConstraints: input.narrativeConstraints,
    content: input.content,
  }
  if (input.language === 'en-US') return `You are a five-role editorial panel reviewing one chapter draft.\n\n[Frozen facts]\n${JSON.stringify(facts, null, 2)}\n\n[Roles]\n- plot: causal progress, conflict, payoff, hook.\n- continuity: timeline, facts, items, knowledge, outline fidelity.\n- character: motivation, agency, relationships, OOC.\n- style: repetition, AI-like prose, viewpoint drift, voice.\n- pacing: scene movement, exposition, scene count, chapter rhythm.\n\n[Output contract]\n- Score every role from 0 to 100.\n- Every finding needs concrete evidence from the supplied content when possible.\n- blocking is only for objective contradictions or missing mandatory events; style preferences cannot block.\n- Output JSON only: {"summary":"","roles":[{"role":"plot","score":0,"summary":"","findings":[{"severity":"blocking|warning|note","description":"","evidence":""}]}]}.\n- Return all five roles exactly once.\n`
  return `你是由五个独立角色组成的编辑部，请评审同一章草稿。\n\n【冻结事实】\n${JSON.stringify(facts, null, 2)}\n\n【审稿角色】\n- plot（情节）：因果推进、冲突、兑现、钩子。\n- continuity（连续性）：时间线、事实、道具、知情边界、大纲忠实度。\n- character（角色）：动机、主动性、关系、OOC。\n- style（文风）：重复、AI 味、视角漂移、角色声音。\n- pacing（节奏）：场景推进、说明文占比、场景数、章节节奏。\n\n【输出合同】\n- 每个角色给 0–100 分。\n- 每条问题尽量引用所给正文中的具体证据。\n- 只有客观矛盾或明确必需事件缺失才能标 blocking；风格偏好不能 blocking。\n- 只输出 JSON：{"summary":"","roles":[{"role":"plot","score":0,"summary":"","findings":[{"severity":"blocking|warning|note","description":"","evidence":""}]}]}。\n- 五个角色必须各出现一次。\n`
}

export interface VoiceProfilePromptInput {
  chapterNumber: number
  content: string
  roster: readonly { characterId: string; name: string; role: string; profile: string }[]
  language: WritingLanguage
}

export function buildVoiceProfilePrompt(input: VoiceProfilePromptInput): string {
  const facts = { chapterNumber: input.chapterNumber, roster: input.roster, content: input.content }
  if (input.language === 'en-US') return `Extract character voice profiles from one finalized chapter.\n\n[Frozen facts]\n${JSON.stringify(facts, null, 2)}\n\n[Rules]\n- Only profile named characters in the roster who actually speak or act in this chapter.\n- Use only the supplied chapter prose as evidence.\n- Every evidence string must be one exact, unique quote from the chapter.\n- Describe how the character speaks, not what the plot says about them.\n- Output JSON only: {"profiles":[{"characterId":"","characterName":"","summary":"","sentenceStyle":"","vocabulary":"","dialogueHabits":[],"emotionalTells":"","avoid":[],"evidence":["exact quote"]}]}.\n`
  return `请从本章定稿正文提取角色声音档案。\n\n【冻结事实】\n${JSON.stringify(facts, null, 2)}\n\n【硬性要求】\n- 只提取角色名单中、且在本章确实说话或行动过的具名角色。\n- 只能把所给正文作为证据。\n- 每条 evidence 必须是正文中逐字出现且唯一的一句话。\n- 重点描述“他怎么说话”，不要总结剧情。\n- 只输出 JSON：{"profiles":[{"characterId":"","characterName":"","summary":"","sentenceStyle":"","vocabulary":"","dialogueHabits":[],"emotionalTells":"","avoid":[],"evidence":["逐字引文"]}]}。\n`
}