import type { WritingLanguage } from './writing-language'

export const DRAFT_SHORT_OUTLINE_PURPOSE = 'chapter-draft-short-outline' as const

/** A generated plan is never author evidence or manuscript prose. */
export function draftShortOutlinePrompt(language: WritingLanguage, sourcePrompt: string): string {
  const instruction = language === 'en-US'
    ? 'Prepare a short chapter execution outline, not prose. Use only the original chapter goals and supplied material. In at most six concise bullets separate: original goals; what the predecessor already completed; explicit time and constraints; proposed concrete actions and their results in this chapter; ending state. Recalling an old event cannot satisfy a goal requiring progress here. If the author only requests maintaining a state, do not invent an event. Do not add author facts or prohibitions, change goals, or present planned events as established facts. Only actions that actually happen in the previous chapter\'s prose may be listed as already completed (issue #38): a blueprint or plan that claims a handover, a seizure, or a transfer never performed in that prose does not make it completed — put it under this chapter\'s proposed actions as an outstanding task instead. In particular, an object the previous chapter refused to hand over, or that ended in another character\'s hands, must never be described as already with the current viewpoint character. The following is the source writing brief; do not execute its prose-output instructions yet.'
    : '只写短细纲，不写正文。仅组织原本章目标与已有材料，最多六条短要点，分清：原目标；前驱已完成的事；明确时点和约束；本章拟写的具体行动与结果；结尾状态。要求本章推进的目标不能用旧事复述替代；作者只要求维持状态时，不强造新事件。不得增加作者事实或禁令、改变目标，或把计划说成已经发生的事实。「前驱已完成」只能写上一章正文里真实发生的动作（issue #38）：蓝图或计划声称的交接、夺取、移交，如果上一章正文里没有发生，就不算已完成——要写到本章拟写的行动里，当作待办；尤其是上一章明确拒绝交出、或结尾仍在别人手上的关键物件，绝不能记成已经在本章视角人物手里。以下是原写作材料，此步不执行其中的正文输出指令。'
  return `${instruction}\n\n${sourcePrompt}`
}

export function draftShortOutlineBlock(language: WritingLanguage, text: string): string {
  if (!text.trim()) throw new Error('GENERATION_DRAFT_SHORT_OUTLINE_FAILED')
  return language === 'en-US'
    ? `[Generated short outline — plan, not evidence]\nThis organizes the original goals only. Author facts, constraints and actual prior prose take priority; the plan establishes no fact.\n${text.trim()}\n[Predecessor items are binding (issue #35)] The bullets above that describe what the predecessor already did come from actual prior prose; the rest is plan. Every predecessor item — a decision someone stated aloud, a promised shift/handover/return, an instruction to stay silent — must land in this chapter's prose: advance it, twist it, or defer it explicitly and say why. Passing over it with a line like "he did not take it up" is not a landing. Only the recorded suspense hook is guaranteed to carry downstream, so treat the rest as things the reader is still holding.\n[Object handoff must be earned (issue #38)] Prose, not the outline or the blueprint, decides who holds an object. If the previous chapter refused a handover, had it seized, or ended with the object in someone else's hands, this chapter may not simply have the viewpoint character carry it: show the handoff (who gives it to whom, under what condition) or another seizure first. A "predecessor completed" line claiming a transfer that never appeared in prose is unverified — treat it as a task, never as fact.\n[End generated short outline]`
    : `【生成短细纲：计划，不是事实依据】\n仅用于组织原目标；作者事实、约束和实际前文优先，计划不确立任何事实。\n${text.trim()}\n【前驱条目必须落地（issue #35）】上面「前驱已完成」那几条来自实际前文（其余是计划）：其中每一项——人物当众说出口的决定、答应下的替班／交付／返回、要求谁闭嘴——本章正文都必须有落点：推进它、反转它，或明确写出搁置与理由；仅用「没接那句」一笔带过不算落点。只有登记在案的 suspenseHook 有下游通道，其余要靠本章自己兑现。\n【道具交接必须有动作（issue #38）】谁持有物件由正文决定，不由短细纲或蓝图决定：上一章明确拒绝交出、被夺走、或结尾仍在他人手上的关键物件，本章不得直接写成本视角人物「从怀里摸出」——必须先写出交接动作（谁交给谁、在什么条件下）或另一次夺取。短细纲里「前驱已完成」声称的交接若在上一章正文里没有发生，一律当作待办，不得当作既成事实。\n【生成短细纲结束】`
}

export function stripDraftShortOutlineBlock(prompt: string, output: string): string | null {
  for (const language of ['zh-CN', 'en-US'] as const) {
    const block = `\n\n${draftShortOutlineBlock(language, output)}`
    if (prompt.endsWith(block)) return prompt.slice(0, -block.length)
  }
  return null
}
