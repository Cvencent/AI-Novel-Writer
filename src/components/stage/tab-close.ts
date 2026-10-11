import { discardAndCloseEditorTab } from '../../stores/editor-discard'
import { useEditorStore } from '../../stores/editor-store'
import { useStageStore } from '../../stores/navigation/stage-store'
import { useProjectStore } from '../../stores/project-store'
import { captureProjectSession, isProjectSessionCurrent } from '../project-session-gate'

/** 关闭标签：没有未保存修改就直接关；有修改时先请作者确认放弃。标签条与 Ctrl W 都走这里。 */
export function requestCloseTab(tabId: string): void {
  const tab = useEditorStore.getState().tabs.find(candidate => candidate.id === tabId)
  if (!tab || tab.pinned) return
  if (tab.dirty) useStageStore.setState({ closingTabId: tabId })
  else useEditorStore.getState().closeTab(tabId)
}

export function confirmCloseTab(): void {
  const { closingTabId } = useStageStore.getState()
  const session = captureProjectSession(useProjectStore.getState().currentProject)
  if (closingTabId && session && isProjectSessionCurrent(session)) discardAndCloseEditorTab(closingTabId, session)
  useStageStore.setState({ closingTabId: null })
}

export function cancelCloseTab(): void {
  useStageStore.setState({ closingTabId: null })
}
