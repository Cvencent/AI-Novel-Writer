/* eslint-disable react-refresh/only-export-components */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { FUNCTION_MODEL_KEYS } from '../../../../shared/function-models'
import FunctionModelSection from '../FunctionModelSection'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
let invoke: ReturnType<typeof vi.fn>

function Harness() {
  return <FunctionModelSection />
}

const model = (id: string) => ({
  id, name: id, provider: 'custom', protocol: 'openai', modelName: id, apiKey: '', baseUrl: '',
  temperature: 0.7, maxTokens: 1024, purposes: ['generation'],
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  useLLMStore.setState({
    defaultModelId: 'gen-a',
    models: [model('gen-a'), model('gen-b')],
    functionModels: {},
    loaded: true,
    activeRequests: new Map(),
  })
  useLocaleStore.setState({ locale: 'zh-CN' })
  invoke = vi.fn(async () => ({ success: true }))
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
  useLLMStore.setState({ defaultModelId: null, models: [], functionModels: {}, activeRequests: new Map() })
  Reflect.deleteProperty(window, 'aiNovelAPI')
})

describe('FunctionModelSection', () => {
  it('renders one row per designed function and follows the default when unassigned', async () => {
    await act(async () => root.render(<Harness />))
    const selects = [...container.querySelectorAll('select')]
    expect(selects).toHaveLength(FUNCTION_MODEL_KEYS.length)
    for (const select of selects) expect((select as HTMLSelectElement).value).toBe('')
    expect(container.textContent).toContain('粗纲生成')
    expect(container.textContent).toContain('AI 助手对话')
    // 未分配时显示生效模型（默认 gen-a）
    expect(container.textContent).toContain('gen-a')
  })

  it('persists an assignment immediately and shows it as selected', async () => {
    await act(async () => root.render(<Harness />))
    const selects = [...container.querySelectorAll('select')] as HTMLSelectElement[]
    await act(async () => {
      selects[3]!.value = 'gen-b'
      selects[3]!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(invoke).toHaveBeenCalledWith('llm:set-function-model', 'draft_generation', 'gen-b')
    expect(useLLMStore.getState().functionModels.draft_generation).toBe('gen-b')
    expect(container.querySelectorAll('select')[3]!.value).toBe('gen-b')
  })

  it('persists 跟随默认 as null', async () => {
    useLLMStore.setState({ functionModels: { editor_ai: 'gen-b' } })
    await act(async () => root.render(<Harness />))
    const selects = [...container.querySelectorAll('select')] as HTMLSelectElement[]
    const editorSelect = selects[FUNCTION_MODEL_KEYS.indexOf('editor_ai')]!
    expect(editorSelect.value).toBe('gen-b')
    await act(async () => {
      editorSelect.value = ''
      editorSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(invoke).toHaveBeenCalledWith('llm:set-function-model', 'editor_ai', null)
    expect(useLLMStore.getState().functionModels.editor_ai).toBeNull()
  })
})
