import { useCallback, useEffect, useRef, useState, type TextareaHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import { Check, Sparkles } from 'lucide-react'

import { Button } from '../ui/Button'
import { useLocaleStore } from '../../stores/locale-store'
import { useLLMStore } from '../../stores/llm-store'
import { useThemeStore } from '../../stores/theme-store'
import { getActiveProjectSessionContext } from '../../shared/project-session-context'
import { createEditorInlineGeneration } from '../../services/editor-inline-generation'
import { INLINE_AI_ACTIONS, INLINE_AI_CUSTOM, type InlineAIAction } from './inline-ai-actions'

type SelectionAITextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
  value: string
  onValueChange: (next: string) => void
}

type Target = {
  requestSequence: number
  from: number
  to: number
  selectedText: string
  documentText: string
}

type BubblePosition = { top: number; right: number; above: boolean }

type ActionRequest = {
  key: InlineAIAction['key'] | 'custom'
  label: readonly [string, string]
  instruction?: string
}

/**
 * 带「框选后请 AI 改写」的文本框。
 *
 * 外观与普通的文本域完全一致（沿用调用方给的 className），只是多一层浮层：
 * 选中一段文字后可以点润色 / 扩写 / 续写，也可以直接输入修改要求让 AI 改写。
 * 结果先进入预览，确认后才替换回原文。
 *
 * 为什么单独做一个组件而不是直接上 CodeMirror：设定页的这些字段本来就是普通文本域，
 * 换成富文本编辑器会改变字号、行高、自动增高与焦点样式。这里只加能力，不动样式。
 */
export default function SelectionAITextarea({ value, onValueChange, ...rest }: SelectionAITextareaProps) {
  const text = useLocaleStore(s => s.text)
  const theme = useThemeStore(s => s.resolvedTheme)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const inlineRef = useRef<ReturnType<typeof createEditorInlineGeneration> | null>(null)
  const targetRef = useRef<Target | null>(null)
  const sequenceRef = useRef(0)

  const [selection, setSelection] = useState<{ from: number; to: number; text: string } | null>(null)
  const [bubble, setBubble] = useState<BubblePosition | null>(null)
  const [aiResult, setAiResult] = useState<string | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [activeAction, setActiveAction] = useState<string | null>(null)
  const [customInstruction, setCustomInstruction] = useState('')

  const resetResult = useCallback(() => {
    targetRef.current = null
    setAiResult(null)
    setAiError(null)
    setActiveAction(null)
    setSelection(null)
    setBubble(null)
  }, [])

  useEffect(() => () => { inlineRef.current?.detach() }, [])

  const syncSelection = useCallback(() => {
    const node = textareaRef.current
    if (!node) return
    // 预览还开着时不跟着新选区跑：AI 结果对应的是发起时的那一段。
    if (aiResult !== null) return
    const from = node.selectionStart ?? 0
    const to = node.selectionEnd ?? 0
    if (to <= from) { setSelection(null); setBubble(null); setCustomInstruction(''); return }
    if (selection?.from !== from || selection?.to !== to) setCustomInstruction('')
    setSelection({ from, to, text: node.value.slice(from, to) })
    const rect = node.getBoundingClientRect()
    const above = rect.top > 80
    setBubble({ top: above ? rect.top - 8 : rect.bottom + 8, right: Math.max(8, window.innerWidth - rect.right), above })
  }, [aiResult, selection])

  const runAction = async (action: ActionRequest) => {
    const node = textareaRef.current
    if (!node || !selection) return
    const session = getActiveProjectSessionContext()
    setActiveAction(text(...action.label))
    setAiResult('')
    setAiError(null)
    if (!session) {
      setAiError(text('请先打开作品并选择模型。', 'Open a book and choose a model first.'))
      return
    }
    const requestSequence = ++sequenceRef.current
    const frozen = { requestSequence, from: selection.from, to: selection.to, selectedText: selection.text, documentText: node.value }
    targetRef.current = frozen
    inlineRef.current?.detach()
    const client = createEditorInlineGeneration(session)
    inlineRef.current = client
    try {
      await client.open({
        input: {
          action: action.key,
          ...(action.instruction ? { instruction: action.instruction } : {}),
          from: frozen.from,
          to: frozen.to,
          selectedText: frozen.selectedText,
          documentText: frozen.documentText,
        },
        modelId: useLLMStore.getState().defaultModelId ?? '',
        uiActionNonce: crypto.randomUUID(),
      })
      if (requestSequence !== sequenceRef.current) return
      const receipt = await client.execute()
      if (requestSequence !== sequenceRef.current) return
      if (receipt.outcome.status !== 'completed' || receipt.outcome.finishReason !== 'stop') {
        setAiResult('')
        setAiError(text('生成未完整完成，结果不可应用。', 'Generation did not complete; the result cannot be applied.'))
        return
      }
      setAiResult(receipt.outcome.content)
      if (receipt.sourceStatus !== 'current') setAiError(text('来源已变化，结果仅可复制。', 'Sources changed; the result can only be copied.'))
    } catch {
      if (requestSequence !== sequenceRef.current) return
      setAiResult('')
      setAiError(text('生成失败，结果不可应用。', 'Generation failed; the result cannot be applied.'))
    }
  }

  const accept = () => {
    const node = textareaRef.current
    const target = targetRef.current
    if (!node || !target || !aiResult) return
    if (node.value !== target.documentText || node.value.slice(target.from, target.to) !== target.selectedText) {
      setAiError(text('正文或原目标已变化，结果未应用；你仍可复制预览内容。', 'The text or the original target changed. The result was not applied; you can still copy the preview.'))
      return
    }
    const caret = target.from + aiResult.length
    onValueChange(node.value.slice(0, target.from) + aiResult + node.value.slice(target.to))
    resetResult()
    requestAnimationFrame(() => {
      const next = textareaRef.current
      if (!next) return
      next.focus()
      next.setSelectionRange(caret, caret)
    })
  }

  const reject = () => {
    void inlineRef.current?.cancel().catch(() => {})
    sequenceRef.current += 1
    resetResult()
  }

  return (
    <>
      <textarea
        {...rest}
        ref={textareaRef}
        value={value}
        onChange={event => onValueChange(event.target.value)}
        onSelect={syncSelection}
        onMouseUp={syncSelection}
        onKeyUp={syncSelection}
      />
      {bubble && createPortal(
        <div
          role="toolbar"
          aria-label={text('选中文字的操作', 'Actions for the selected text')}
          className="paper-ink cm-selbar"
          data-theme={theme}
          data-preview={aiResult !== null || undefined}
          style={{ position: 'fixed', top: bubble.top, right: bubble.right, transform: bubble.above ? 'translateY(-100%)' : 'none', zIndex: 80 }}
          onMouseDown={event => {
            if (!(event.target instanceof HTMLInputElement)) event.preventDefault()
          }}
        >
          {aiResult !== null ? (
            <div className="cm-selbar-preview">
              <div className="cm-selbar-title">
                <Sparkles size={13} aria-hidden="true" />
                {activeAction ? text(`${activeAction}预览`, `${activeAction} preview`) : text('AI 预览', 'AI preview')}
              </div>
              {aiError ? (
                <>
                  <p className="cm-selbar-error" role="alert">{aiError}</p>
                  {aiResult && <p className="cm-selbar-text">{aiResult}</p>}
                </>
              ) : aiResult === '' ? (
                <p className="cm-selbar-status" role="status">{text('正在生成…', 'Generating…')}</p>
              ) : (
                <p className="cm-selbar-text">{aiResult}</p>
              )}
              <div className="cm-selbar-actions">
                <Button variant="secondary" size="sm" onClick={reject}>{text('取消', 'Cancel')}</Button>
                <Button variant="primary" size="sm" disabled={aiResult === '' || aiError !== null} onClick={accept}>
                  <Check size={13} aria-hidden="true" />{text('替换', 'Replace')}
                </Button>
              </div>
            </div>
          ) : (
            <>
              {INLINE_AI_ACTIONS.map((action, index) => (
                <Button key={action.key} variant="text" size="sm" className="cm-selbar-tool" onClick={() => { void runAction(action) }}>
                  {index === 0 && <Sparkles size={13} aria-hidden="true" />}
                  {text(...action.label)}
                </Button>
              ))}
              <div className="cm-selbar-custom">
                <input
                  className="cm-selbar-instruction"
                  aria-label={text(...INLINE_AI_CUSTOM.ariaLabel)}
                  placeholder={text(...INLINE_AI_CUSTOM.placeholder)}
                  maxLength={4000}
                  enterKeyHint="send"
                  value={customInstruction}
                  onChange={event => setCustomInstruction(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && customInstruction.trim()) {
                      event.preventDefault()
                      void runAction({ ...INLINE_AI_CUSTOM, instruction: customInstruction.trim() })
                    }
                    if (event.key === 'Escape') setCustomInstruction('')
                  }}
                />
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!customInstruction.trim()}
                  onClick={() => { void runAction({ ...INLINE_AI_CUSTOM, instruction: customInstruction.trim() }) }}
                >{text(...INLINE_AI_CUSTOM.label)}</Button>
              </div>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
