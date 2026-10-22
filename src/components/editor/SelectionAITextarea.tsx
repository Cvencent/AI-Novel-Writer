import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type TextareaHTMLAttributes } from 'react'
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

type ActionRequest = {
  key: InlineAIAction['key'] | 'custom'
  label: readonly [string, string]
  instruction?: string
}

type Anchor = { top: number; bottom: number; left: number }
type BubblePosition = Anchor & { placement: 'above' | 'below' }

/** 浮层与视口边缘至少留出的距离。 */
const BUBBLE_INSET = 8
/** 底部对齐的浮层向上展开，估算自身高度来决定放在选区上方还是下方。 */
const estimateBubbleHeight = (preview: boolean) => preview ? 320 : 100
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

function positionBubble(anchor: Anchor, preview: boolean): BubblePosition {
  const height = estimateBubbleHeight(preview)
  const placement = anchor.top - height >= BUBBLE_INSET ? 'above' : 'below'
  const halfWidth = Math.min(180, Math.max(96, window.innerWidth / 2 - BUBBLE_INSET))
  return {
    top: placement === 'above' ? anchor.top - 4 : anchor.bottom + 4,
    left: clamp(anchor.left, halfWidth, Math.max(halfWidth, window.innerWidth - halfWidth)),
    bottom: anchor.bottom,
    placement,
  }
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
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  const inlineRef = useRef<ReturnType<typeof createEditorInlineGeneration> | null>(null)
  const targetRef = useRef<Target | null>(null)
  const anchorRef = useRef<Anchor | null>(null)
  const sequenceRef = useRef(0)

  const [selection, setSelection] = useState<{ from: number; to: number; text: string } | null>(null)
  const [bubble, setBubble] = useState<BubblePosition | null>(null)
  const [bubbleShift, setBubbleShift] = useState({ x: 0, y: 0 })
  const [aiResult, setAiResult] = useState<string | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [activeAction, setActiveAction] = useState<string | null>(null)
  const [customInstruction, setCustomInstruction] = useState('')

  const resetResult = useCallback(() => {
    targetRef.current = null
    anchorRef.current = null
    setAiResult(null)
    setAiError(null)
    setActiveAction(null)
    setCustomInstruction('')
    setSelection(null)
    setBubble(null)
    setBubbleShift({ x: 0, y: 0 })
  }, [])

  useEffect(() => () => { inlineRef.current?.detach() }, [])

  /**
   * 预览比快捷操作高得多，出现后可能超出视口。
   * 每次浮层尺寸变化都量一次实际矩形，把它挪回可视范围内；
   * 偏差是累加式的，所以收敛后不会再触发更新。
   */
  useLayoutEffect(() => {
    const node = bubbleRef.current
    if (!node || !bubble) return
    const rect = node.getBoundingClientRect()
    let dx = 0
    let dy = 0
    if (rect.left < BUBBLE_INSET) dx = BUBBLE_INSET - rect.left
    else if (rect.right > window.innerWidth - BUBBLE_INSET) dx = window.innerWidth - BUBBLE_INSET - rect.right
    if (rect.top < BUBBLE_INSET) dy = BUBBLE_INSET - rect.top
    else if (rect.bottom > window.innerHeight - BUBBLE_INSET) dy = window.innerHeight - BUBBLE_INSET - rect.bottom
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) setBubbleShift(prev => ({ x: prev.x + dx, y: prev.y + dy }))
  }, [bubble, aiResult, aiError])

  const syncSelection = useCallback((event?: ReactMouseEvent<HTMLTextAreaElement>) => {
    const node = textareaRef.current
    if (!node) return
    // 预览还开着时不跟着新选区跑：AI 结果对应的是发起时的那一段。
    if (aiResult !== null) return
    const from = node.selectionStart ?? 0
    const to = node.selectionEnd ?? 0
    if (to <= from) {
      setSelection(null)
      setBubble(null)
      anchorRef.current = null
      setBubbleShift({ x: 0, y: 0 })
      setCustomInstruction('')
      return
    }
    if (selection?.from !== from || selection?.to !== to) setCustomInstruction('')
    setSelection({ from, to, text: node.value.slice(from, to) })

    let anchor: Anchor | null = event && event.clientY > 0 && event.clientX > 0
      ? { top: event.clientY, bottom: event.clientY + 18, left: event.clientX }
      : null
    if (!anchor) {
      const domSelection = window.getSelection()
      const range = domSelection && domSelection.rangeCount > 0 && !domSelection.isCollapsed
        ? domSelection.getRangeAt(0).getBoundingClientRect()
        : null
      if (range && range.height > 0 && range.width > 0) {
        anchor = { top: range.top, bottom: range.bottom, left: range.left + range.width / 2 }
      }
    }
    if (!anchor) {
      // 键盘选区没有指针坐标：用文本框落在视口内的那一段做锚点，
      // 否则很长的文本框会把浮层顶到页面外面去。
      const rect = node.getBoundingClientRect()
      const visibleTop = Math.max(rect.top, BUBBLE_INSET)
      const visibleBottom = Math.min(rect.bottom, window.innerHeight - BUBBLE_INSET)
      const center = visibleBottom > visibleTop
        ? (visibleTop + visibleBottom) / 2
        : window.innerHeight / 2
      const top = clamp(center, BUBBLE_INSET, window.innerHeight - BUBBLE_INSET)
      anchor = {
        top,
        bottom: top + 18,
        left: clamp(rect.left + rect.width / 2, BUBBLE_INSET, window.innerWidth - BUBBLE_INSET),
      }
    }

    anchorRef.current = anchor
    setBubbleShift({ x: 0, y: 0 })
    setBubble(positionBubble(anchor, false))
  }, [aiResult, selection])

  const runAction = async (action: ActionRequest) => {
    const node = textareaRef.current
    if (!node || !selection) return
    const session = getActiveProjectSessionContext()
    setActiveAction(text(...action.label))
    setAiResult('')
    setAiError(null)
    setBubbleShift({ x: 0, y: 0 })
    if (anchorRef.current) setBubble(positionBubble(anchorRef.current, true))
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

  const bubbleTransform = bubble
    ? `translate(${bubbleShift.x}px, ${bubbleShift.y}px) translate(-50%, ${bubble.placement === 'above' ? '-100%' : '0'})`
    : undefined

  return (
    <>
      <textarea
        {...rest}
        ref={textareaRef}
        value={value}
        onChange={event => onValueChange(event.target.value)}
        onSelect={() => syncSelection()}
        onMouseUp={event => syncSelection(event)}
        onKeyUp={() => syncSelection()}
        onScroll={() => syncSelection()}
      />
      {bubble && createPortal(
        <div
          ref={bubbleRef}
          role="toolbar"
          aria-label={text('选中文字的操作', 'Actions for the selected text')}
          className="paper-ink cm-selbar"
          data-theme={theme}
          data-preview={aiResult !== null || undefined}
          data-placement={bubble.placement}
          style={{ position: 'fixed', top: bubble.top, left: bubble.left, transform: bubbleTransform, zIndex: 80 }}
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