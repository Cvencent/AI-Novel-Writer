import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../index.css'
import '../../../styles/paper-ink/index.css'
import '../stage.css'
import type { ProjectData } from '../../../shared/ipc-channels'
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

const SESSION = { projectId: 'harbor', leaseId: 'harbor-lease', projectPath: 'C:\\novels\\harbor' }
const HARBOR = { id: SESSION.projectId, sessionLease: SESSION.leaseId, name: '港口', path: SESSION.projectPath, novelConfig: {
  coreOutline: '', genre: '', subGenre: '', targetAudience: '', totalChapters: 24, wordsPerChapter: 3000, worldSetting: '', goldenFinger: '',
  protagonistProfile: '', globalGuidance: '', writingStyle: '', referenceWorks: '', narrativePOV: 'third_limited', plotStructure: 'three_act', writingLanguage: 'zh-CN',
} } as unknown as ProjectData

let root: Root | undefined
let host: HTMLDivElement | undefined

const discardDialog = () => [...document.querySelectorAll('[role="dialog"]')].find(dialog => dialog.querySelector('h2')?.textContent === '放弃未保存的修改？')
const dialogButton = (name: string) => [...discardDialog()!.querySelectorAll('button')].find(button => button.textContent === name)

beforeEach(async () => {
  Object.defineProperty(window, 'aiNovelAPI', {
    configurable: true,
    value: {
      invoke: async (channel: string) => channel === 'config:get' ? {} : channel.endsWith('-list') || channel.endsWith('get-all') ? [] : undefined,
      on: () => () => undefined,
    },
  })
  useAppearanceStore.setState({ resolvedShell: 'stage' })
  useLocaleStore.setState({ locale: 'zh-CN' })
  useLLMStore.setState({ loaded: true, models: [], defaultModelId: null })
  useEditorStore.setState({ tabs: [], activeTabId: null })
  useStageStore.setState({ sheet: null, focus: false, palette: null, work: null })
  useProjectStore.setState({ currentProject: null, recentProjects: [] })
  useLayoutStore.setState({ sidebarView: 'project', settingsOpen: true, settingsSection: 'skills' })
  host = document.createElement('div')
  host.style.cssText = 'width: 1280px; height: 800px; display: flex;'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<StageShell theme="paper" />))
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  for (const restore of restores) restore()
})

describe('书房里的设置页有没保存的输入时，作品被自动打开（导入后、外部打开）', () => {
  it('先确认放弃；继续编辑时设置页与输入都留着', async () => {
    const skillUrl = () => host!.querySelector<HTMLInputElement>('input[aria-label="GitHub Skill 地址"]')!
    await vi.waitFor(() => expect(skillUrl()).toBeTruthy())
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(skillUrl(), 'https://github.com/owner/skill')
      skillUrl().dispatchEvent(new Event('input', { bubbles: true }))
    })

    setActiveProjectSessionContext(SESSION)
    await act(async () => useProjectStore.setState({ currentProject: HARBOR }))

    expect(discardDialog()?.textContent).toContain('这一页有还没保存的修改，离开后会丢失。')
    expect(useLayoutStore.getState().settingsOpen).toBe(true)
    await act(async () => dialogButton('继续编辑')!.click())
    expect(useLayoutStore.getState().settingsOpen).toBe(true)
    expect(skillUrl().value).toBe('https://github.com/owner/skill')
  })

  it('选放弃修改才收起设置页', async () => {
    const skillUrl = () => host!.querySelector<HTMLInputElement>('input[aria-label="GitHub Skill 地址"]')!
    await vi.waitFor(() => expect(skillUrl()).toBeTruthy())
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(skillUrl(), 'https://github.com/owner/skill')
      skillUrl().dispatchEvent(new Event('input', { bubbles: true }))
    })
    setActiveProjectSessionContext(SESSION)
    await act(async () => useProjectStore.setState({ currentProject: HARBOR }))
    await act(async () => dialogButton('放弃修改')!.click())
    expect(useLayoutStore.getState().settingsOpen).toBe(false)
  })
})
