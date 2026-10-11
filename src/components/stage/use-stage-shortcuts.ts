import { useEffect } from 'react'
import { editorSaveHandler, useEditorStore } from '../../stores/editor-store'
import { useStageStore } from '../../stores/navigation/stage-store'
import { requestCloseTab } from './tab-close'

/** 焦点在对话框里时（设置、确认等）快捷键交给对话框自己处理。 */
const insideDialog = (target: EventTarget | null) =>
  target instanceof Element && target.closest('[role="dialog"], [role="alertdialog"]') !== null

function saveActiveTab(): void {
  const { tabs, activeTabId } = useEditorStore.getState()
  const tab = tabs.find(candidate => candidate.id === activeTabId)
  if (!tab?.dirty) return
  void editorSaveHandler(tab)?.().catch(() => undefined)
}

/**
 * 新外壳的全局快捷键：Ctrl K 搜索与跳转，Ctrl P 查找章节，Ctrl W 关闭当前标签，Ctrl S 保存当前页，Esc 退出沉浸写作。
 * Ctrl S 在 CodeMirror 里已由编辑器自己保存（事件已 preventDefault），这里只补上表单页。
 * 捕获阶段监听，这样 Esc 先于 Radix 对话框的关闭处理读到「搜索是否开着」。
 */
export function useStageShortcuts({ library, focus }: { library: boolean; focus: boolean }): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (focus && !useStageStore.getState().palette && !insideDialog(event.target)) {
          event.preventDefault()
          useStageStore.setState({ focus: false })
        }
        return
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      const key = event.key.toLowerCase()
      const { palette } = useStageStore.getState()
      if (insideDialog(event.target) && !(key === 'k' && palette)) return
      if (key === 'k') {
        event.preventDefault()
        useStageStore.setState({ palette: palette === 'commands' ? null : 'commands' })
      } else if (key === 'p' && !library) {
        event.preventDefault()
        useStageStore.setState({ palette: 'chapters' })
      } else if (key === 'w' && !library) {
        event.preventDefault()
        const { activeTabId } = useEditorStore.getState()
        if (activeTabId) requestCloseTab(activeTabId)
      }
    }
    const onSave = (event: KeyboardEvent) => {
      if (library || event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's' || event.altKey || event.shiftKey) return
      event.preventDefault()
      saveActiveTab()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keydown', onSave)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keydown', onSave)
    }
  }, [library, focus])
}
