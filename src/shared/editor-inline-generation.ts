import type { MainGenerationRunHandle, MainGenerationRunView, MainGenerationExecuteReceipt } from '../services/generation/generation-runtime'
import type { PromptTemplate } from '../services/builtin-prompt-templates'
import type { WritingLanguage } from './writing-language'

export type EditorInlineAction = 'refine' | 'expand' | 'continue' | 'dialogue' | 'custom'

/**
 * 作者正在改的是哪一块文本。模型需要知道自己改的是世界观还是核心大纲：
 * 「保持与前文一致」这句话在不同位置的约束完全不同。
 * 章节草稿是默认值（旧运行没有 scope 时也按它读）。
 */
export type EditorInlineScope =
  | 'chapter-draft'
  | 'core-outline'
  | 'world-setting'
  | 'golden-finger'
  | 'protagonist-profile'
  | 'global-guidance'
  | 'writing-style'
  | 'reference-works'
  | 'premise'
  | 'worldbuilding'
  | 'characters'
  | 'arc-outline'
  | 'synopsis'

export interface EditorInlineInput {
  action: EditorInlineAction
  /** Only custom rewrites carry an author-written instruction. */
  instruction?: string
  /** Which project field or document the selection lives in. */
  scope?: EditorInlineScope
  /** Selected text plus a bounded amount of surrounding text for local continuity. */
  contextBefore?: string
  contextAfter?: string
  documentText: string
  from: number
  to: number
  selectedText: string
}
export interface EditorInlineContext extends EditorInlineInput {
  kind: 'author-draft'
  documentHash: string
  writingLanguage: WritingLanguage
  template: PromptTemplate
}
export interface EditorInlineRecovery {
  view: MainGenerationRunView
  modelId: string
  context: EditorInlineContext
  sourceStatus: 'current' | 'conflict'
}
export interface EditorInlineGenerationChannels {
  'editor-inline:begin': { args: [{ input: EditorInlineInput; modelId: string; uiActionNonce: string }]; return: EditorInlineRecovery }
  'editor-inline:read-recovery': { args: [{ handle: MainGenerationRunHandle }]; return: EditorInlineRecovery }
  'editor-inline:execute': { args: [{ handle: MainGenerationRunHandle }]; return: MainGenerationExecuteReceipt }
  'editor-inline:cancel': { args: [{ handle: MainGenerationRunHandle }]; return: MainGenerationRunView }
}