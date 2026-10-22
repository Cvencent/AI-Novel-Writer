import type { GenerationReasoningStage } from '../../shared/reasoning-types'

/**
 * 选中一段文字后可以请 AI 做的几件事。
 *
 * 架构编辑器（CodeMirrorEditor）和设定页的文本框（SelectionAITextarea）共用这一份：
 * 两个地方的入口按钮、提示词和推理阶段必须完全一致，作者在哪儿框选都得到同一套选项。
 */
export type InlineAIAction = {
  key: 'refine' | 'expand' | 'continue'
  label: readonly [string, string]
  prompt: readonly [string, string]
  reasoningStage: GenerationReasoningStage
}

export const INLINE_AI_ACTIONS = [
  { key: 'refine', label: ['润色', 'Refine'], prompt: ['润色这部分，使语言自然、具体并增强场景表现力。', 'Refine this passage for natural, specific language and stronger scene craft.'], reasoningStage: 'review' },
  { key: 'expand', label: ['扩写', 'Expand'], prompt: ['扩写这部分，补充与情节有关的动作、感官和环境细节。', 'Expand this passage with plot-relevant action, sensory detail, and setting.'], reasoningStage: 'drafting' },
  { key: 'continue', label: ['续写', 'Continue'], prompt: ['根据现有因果和人物动机，自然续写接下来的情节。', 'Continue naturally from the established causality and character motivation.'], reasoningStage: 'drafting' },
] satisfies readonly InlineAIAction[]

/** 作者自己输入修改要求时使用的入口与文案。 */
export const INLINE_AI_CUSTOM = {
  key: 'custom',
  label: ['改写', 'Rewrite'],
  ariaLabel: ['告诉 AI 怎么改', 'Tell AI how to revise'],
  placeholder: ['例如：更紧张，删掉解释性旁白', 'e.g. make it tenser and remove exposition'],
} as const