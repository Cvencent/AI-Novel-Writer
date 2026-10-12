import { afterEach, beforeEach, expect, it } from 'vitest'
import type { StoreApi } from 'zustand'

import type { ProjectData } from '../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useAppearanceStore } from '../../../stores/appearance-bootstrap'
import { useEditorStore } from '../../../stores/editor-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { navigate } from '../../../stores/navigation/navigation-intents'
import { useStageStore } from '../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../stores/project-store'

const PATH = 'C:/novels/night-train'
const SESSION = { projectId: 'night-train', leaseId: 'lease', projectPath: PATH }

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [useAppearanceStore, useEditorStore, useStageStore, useProjectStore, useLayoutStore].map(store => snapshot(store as StoreApi<unknown>))

beforeEach(() => {
  useAppearanceStore.setState({ resolvedShell: 'stage' })
  useProjectStore.setState({ currentProject: { id: SESSION.projectId, path: PATH, sessionLease: SESSION.leaseId, name: '雨夜列车', novelConfig: {} } as unknown as ProjectData })
  setActiveProjectSessionContext(SESSION)
  useEditorStore.setState({
    tabs: [{ id: 'chapter-3', name: '第 3 章', type: 'chapter', filePath: 'ai-novel://draft/3', projectKey: PATH, content: '雨从傍晚开始就没有停过。', dirty: true }],
    activeTabId: 'chapter-3',
  })
})

afterEach(() => {
  setActiveProjectSessionContext(null)
  for (const restore of restores) restore()
})

it('在剧情、知识库、版本历史之间来回切换，正文标签与它未保存的修改都还在，资料页各只有一个标签', () => {
  for (const page of ['plot', 'knowledge', 'history', 'plot', 'history', 'knowledge'] as const) navigate({ kind: 'resource', page })

  const { tabs, activeTabId } = useEditorStore.getState()
  expect(tabs.find(tab => tab.id === 'chapter-3')).toMatchObject({ type: 'chapter', dirty: true, content: '雨从傍晚开始就没有停过。' })
  expect(tabs.map(tab => tab.type).sort()).toEqual(['chapter', 'knowledge', 'narrative-thread', 'version-history'])
  expect(tabs.find(tab => tab.id === activeTabId)?.type).toBe('knowledge')

  navigate({ kind: 'resource', page: 'plot' })
  expect(useEditorStore.getState().tabs).toHaveLength(4)
})
