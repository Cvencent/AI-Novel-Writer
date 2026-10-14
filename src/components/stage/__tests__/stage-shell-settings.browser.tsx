import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../index.css'
import '../../../styles/paper-ink/index.css'
import '../stage.css'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useAppearanceStore } from '../../../stores/appearance-bootstrap'
import { useEditorStore } from '../../../stores/editor-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useStageStore } from '../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../stores/project-store'
import StageShell from '../StageShell'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [useAppearanceStore, useEditorStore, useLayoutStore, useLLMStore, useLocaleStore, useStageStore, useProjectStore]
  .map(store => snapshot(store as StoreApi<unknown>))

const TARGET = 'C:\\novels\\harbor-copy'

let root: Root | undefined
let host: HTMLDivElement | undefined
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>

const discardDialog = () => [...document.querySelectorAll('[role="dialog"]')].find(dialog => dialog.querySelector('h2')?.textContent === '放弃未保存的修改？')
const dialogButton = (name: string) => [...discardDialog()!.querySelectorAll('button')].find(button => button.textContent === name)
const skillUrl = () => host!.querySelector<HTMLInputElement>('input[aria-label="GitHub Skill 地址"]')!
const opens = () => invoke.mock.calls.filter(([channel]) => channel === 'project:open')

beforeEach(async () => {
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'config:get') return {}
    if (channel === 'dialog:select-legacy-project') return { grantId: 'legacy-grant', displayName: '旧港' }
    if (channel === 'dialog:select-project-restore-target') return { grantId: 'target-grant' }
    if (channel === 'project:import-legacy-copy') return { state: 'ready', projectId: 'harbor', targetRoot: TARGET }
    if (channel === 'project:open') return { success: false, error: '测试里不真的打开' }
    return channel.endsWith('-list') || channel.endsWith('get-all') ? [] : undefined
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => undefined } })
  useAppearanceStore.setState({ resolvedShell: 'stage' })
  useLocaleStore.setState({ locale: 'zh-CN' })
  useLLMStore.setState({ loaded: true, models: [], defaultModelId: null })
  useEditorStore.setState({ tabs: [], activeTabId: null })
  useStageStore.setState({ sheet: null, focus: false, palette: null, work: null })
  useProjectStore.setState({ currentProject: null, recentProjects: [], legacyImportNotice: '' })
  useLayoutStore.setState({ sidebarView: 'project', settingsOpen: true, settingsSection: 'skills' })
  host = document.createElement('div')
  host.style.cssText = 'width: 1280px; height: 800px; display: flex;'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<StageShell theme="paper" />))
  await vi.waitFor(() => expect(skillUrl()).toBeTruthy())
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(skillUrl(), 'https://github.com/owner/skill')
    skillUrl().dispatchEvent(new Event('input', { bubbles: true }))
  })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  for (const restore of restores) restore()
})

describe('书房里的设置页有没保存的输入时，导入旧项目副本完成后要自动打开作品', () => {
  it('先确认放弃；继续编辑时不打开，设置页与输入都留着，提示副本已建立', async () => {
    let importing!: Promise<boolean>
    await act(async () => { importing = useProjectStore.getState().importLegacyProject() })
    await vi.waitFor(() => expect(discardDialog()?.textContent).toContain('这一页有还没保存的修改，离开后会丢失。'))
    expect(opens()).toEqual([])
    await act(async () => dialogButton('继续编辑')!.click())
    await expect(importing).resolves.toBe(false)
    expect(opens()).toEqual([])
    expect(useLayoutStore.getState().settingsOpen).toBe(true)
    expect(skillUrl().value).toBe('https://github.com/owner/skill')
    expect(useProjectStore.getState().legacyImportNotice).toContain(TARGET)
  })

  it('选放弃修改才收起设置页并打开作品', async () => {
    await act(async () => { void useProjectStore.getState().importLegacyProject() })
    await vi.waitFor(() => expect(discardDialog()).toBeTruthy())
    await act(async () => dialogButton('放弃修改')!.click())
    await vi.waitFor(() => expect(opens().map(([, path]) => path)).toEqual([TARGET]))
    expect(useLayoutStore.getState().settingsOpen).toBe(false)
  })
})
