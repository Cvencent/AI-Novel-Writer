/* eslint-disable react-refresh/only-export-components */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { useProjectStore } from '../../../stores/project-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import SelectionAITextarea from '../SelectionAITextarea'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
let invoke: ReturnType<typeof vi.fn>
let recoveries: Map<string, { view: unknown; sourceStatus: string; context: unknown; modelId: string }>

function TallHarness() {
  const [value, setValue] = useState(`${'这是一段很长的核心大纲。'.repeat(120)}`)
  return (
    <div style={{ paddingTop: 520 }}>
      <SelectionAITextarea
        aria-label="长文本测试设定"
        style={{ width: 520, height: 900 }}
        value={value}
        onValueChange={setValue}
      />
    </div>
  )
}

function Harness() {
  const [value, setValue] = useState('原文段落')
  return (
    <SelectionAITextarea
      aria-label="测试设定"
      className="stage-setup-textarea"
      value={value}
      onValueChange={setValue}
    />
  )
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  recoveries = new Map()
  useProjectStore.setState({ currentProject: { id: 'setup-project', sessionLease: 'setup-epoch', path: 'C:/合成设定', novelConfig: {} } as never })
  useLLMStore.setState({ defaultModelId: 'setup-model', models: [{ id: 'setup-model', purposes: ['generation'] }] as never, loaded: true, activeRequests: new Map() })
  useLocaleStore.setState({ locale: 'zh-CN' })
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'editor-inline:begin') {
      const input = (args[0] as { input: { documentText: string } }).input
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.documentText))), byte => byte.toString(16).padStart(2, '0')).join('')
      const recovery = {
        view: { handle: { projectId: 'setup-project', epoch: 'setup-epoch', rootActionId: 'root', runId: 'run-1' }, status: 'running', artifacts: [] },
        modelId: 'setup-model',
        sourceStatus: 'current',
        context: { ...input, kind: 'author-draft', documentHash: hash },
      }
      recoveries.set('run-1', recovery)
      return recovery
    }
    if (channel === 'editor-inline:read-recovery') return recoveries.get((args[0] as { handle: { runId: string } }).handle.runId)
    if (channel === 'editor-inline:execute') {
      const handle = (args[0] as { handle: object }).handle
      const candidate = { ...handle, artifactId: 'proof', textHash: 'proof-hash', text: '改写后的段落', status: 'completed', compositionEligible: true }
      const run = { handle, status: 'completed', artifacts: [candidate], candidates: [candidate] }
      const stored = recoveries.get('run-1')!
      stored.view = run
      return { run, outcome: { status: 'completed', finishReason: 'stop', content: '改写后的段落' } }
    }
    if (channel === 'editor-inline:cancel') return { handle: (args[0] as { handle: object }).handle, status: 'cancelled', artifacts: [] }
    throw new Error(`Unexpected IPC channel: ${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', {
    configurable: true,
    value: {
      invoke,
      on: vi.fn(() => () => {}),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(() => 0),
    },
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useProjectStore.setState({ currentProject: null })
  useLLMStore.setState({ defaultModelId: null, functionModels: {}, activeRequests: new Map() })
  Reflect.deleteProperty(window, 'aiNovelAPI')
})

describe('SelectionAITextarea', () => {
  it('shows the same AI actions and replaces the frozen selection after preview', async () => {
    await act(async () => root.render(<Harness />))
    const area = container.querySelector('textarea')!
    await act(async () => {
      area.focus()
      area.setSelectionRange(0, 4)
      area.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })

    const toolbarRect = document.querySelector<HTMLElement>('[role="toolbar"]')!.getBoundingClientRect()
    expect(toolbarRect.top).toBeGreaterThanOrEqual(8)
    expect(toolbarRect.bottom).toBeLessThanOrEqual(window.innerHeight - 8)
    await expect.element(page.getByRole('button', { name: '润色' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: '扩写' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: '续写' })).toBeVisible()
    await expect.element(page.getByRole('textbox', { name: '告诉 AI 怎么改' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: '改成对话' })).not.toBeInTheDocument()

    await act(async () => page.getByRole('button', { name: '润色' }).click())
    await expect.element(page.getByText('改写后的段落')).toBeVisible()
    await expect.element(page.getByRole('button', { name: '替换' })).toBeEnabled()

    await act(async () => page.getByRole('button', { name: '替换' }).click())
    expect(area.value).toBe('改写后的段落')
    expect(invoke).toHaveBeenCalledWith('editor-inline:begin', expect.objectContaining({
      input: expect.objectContaining({ action: 'refine', from: 0, to: 4, selectedText: '原文段落', documentText: '原文段落' }),
    }), expect.any(Object))
  })

  it('uses the editor_ai function model for inline generation', async () => {
    useLLMStore.setState({ defaultModelId: 'setup-model', models: [{ id: 'setup-model', purposes: ['generation'] }, { id: 'editor-fn-model', purposes: ['generation'] }] as never, functionModels: { editor_ai: 'editor-fn-model' }, loaded: true, activeRequests: new Map() })
    await act(async () => root.render(<Harness />))
    const area = container.querySelector('textarea')!
    await act(async () => {
      area.focus()
      area.setSelectionRange(0, 4)
      area.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })

    await act(async () => page.getByRole('button', { name: '润色' }).click())
    await expect.element(page.getByText('改写后的段落')).toBeVisible()

    const beginCall = invoke.mock.calls.find(([channel]) => channel === 'editor-inline:begin')
    expect(beginCall).toBeTruthy()
    expect((beginCall![1] as { modelId?: string }).modelId).toBe('editor-fn-model')
  })

  it('rewrites the frozen selection from a free-form author instruction', async () => {
    await act(async () => root.render(<Harness />))
    const area = container.querySelector('textarea')!
    await act(async () => {
      area.focus()
      area.setSelectionRange(0, 4)
      area.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })

    const instruction = page.getByRole('textbox', { name: '告诉 AI 怎么改' })
    await expect.element(instruction).toBeVisible()
    await act(async () => instruction.fill('写得更紧张，删掉解释性旁白'))
    await act(async () => page.getByRole('button', { name: '改写', exact: true }).click())
    await expect.element(page.getByText('改写后的段落')).toBeVisible()
    await act(async () => page.getByRole('button', { name: '替换' }).click())

    expect(area.value).toBe('改写后的段落')
    expect(invoke).toHaveBeenCalledWith('editor-inline:begin', expect.objectContaining({
      input: expect.objectContaining({
        action: 'custom',
        instruction: '写得更紧张，删掉解释性旁白',
        selectedText: '原文段落',
      }),
    }), expect.any(Object))
  })

  it('keeps a tall scrolled textarea preview and its replace action inside the viewport', async () => {
    await page.viewport(900, 600)
    await act(async () => root.render(<TallHarness />))
    window.scrollTo(0, 480)
    const area = container.querySelector('textarea')!
    await act(async () => {
      area.focus()
      area.setSelectionRange(0, 4)
      area.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 420, clientY: 500 }))
    })

    await act(async () => page.getByRole('button', { name: '润色' }).click())
    await expect.element(page.getByText('改写后的段落')).toBeVisible()
    const toolbar = document.querySelector<HTMLElement>('[role="toolbar"]')!
    const rect = toolbar.getBoundingClientRect()
    expect(rect.top).toBeGreaterThanOrEqual(8)
    expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight - 8)
    expect(document.elementFromPoint(rect.right - 12, rect.bottom - 12)).toBeTruthy()
  })

  it('does not replace when the textarea changed after generation started', async () => {
    await act(async () => root.render(<Harness />))
    const area = container.querySelector('textarea')!
    await act(async () => {
      area.focus()
      area.setSelectionRange(0, 4)
      area.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await act(async () => page.getByRole('button', { name: '润色' }).click())
    await expect.element(page.getByText('改写后的段落')).toBeVisible()

    await act(async () => {
      area.value = '用户后来改过的内容'
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => page.getByRole('button', { name: '替换' }).click())
    await expect.element(page.getByText('正文或原目标已变化，结果未应用；你仍可复制预览内容。')).toBeVisible()
  })
})


