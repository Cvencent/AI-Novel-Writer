import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { pluralEn } from '../../shared/plural-en'
import type { EditorTab } from '../../stores/editor-store'
import { useLocaleStore } from '../../stores/locale-store'
import { DangerConfirm } from '../ui/DangerConfirm'
import { Menu } from '../ui/Menu'
import { commandLabel } from './shortcut-keys'
import { stageTabName } from './stage-text'
import { closeCleanTabs, discardAndCloseTabs, requestCloseTab } from './tab-close'

/**
 * 标签条右端的菜单：列出已打开的页面供跳转（F-184），并能关闭当前、其他、右侧或全部标签（F-183）。
 * 一次关几个时，没有未保存修改的直接关；有修改的合在一个危险确认里问一次。
 */
export default function StageTabMenu({ tabs, activeTabId, onSelect }: {
  tabs: readonly EditorTab[]
  activeTabId: string | null
  onSelect: (tabId: string) => void
}) {
  const text = useLocaleStore(s => s.text)
  const [pending, setPending] = useState<readonly string[] | null>(null)
  const index = tabs.findIndex(tab => tab.id === activeTabId)
  const ids = (list: readonly EditorTab[]) => list.map(tab => tab.id)
  const closeMany = (tabIds: readonly string[]) => {
    const dirty = closeCleanTabs(tabIds)
    if (dirty.length > 0) setPending(dirty)
  }
  const count = pending?.length ?? 0

  return (
    <div className="stage-tab-menu">
      <Menu
        label={text('标签操作', 'Tab actions')}
        icon={<ChevronDown size={14} aria-hidden />}
        align="end"
        groups={[
          { id: 'open', label: text('已打开的页面', 'Open pages'), items: tabs.map(tab => ({
            id: tab.id,
            label: tab.id === activeTabId ? text(`${stageTabName(tab, text)}（当前）`, `${stageTabName(tab, text)} (current)`) : stageTabName(tab, text),
            onSelect: () => onSelect(tab.id),
          })) },
          { id: 'close', items: [
            { id: 'close-active', label: text('关闭当前标签', 'Close this tab'), disabled: index < 0, onSelect: () => { if (activeTabId) requestCloseTab(activeTabId) } },
            { id: 'close-others', label: text('关闭其他标签', 'Close other tabs'), disabled: tabs.length < 2, onSelect: () => closeMany(ids(tabs.filter(tab => tab.id !== activeTabId))) },
            { id: 'close-right', label: text('关闭右侧标签', 'Close tabs to the right'), disabled: index < 0 || index === tabs.length - 1, onSelect: () => closeMany(ids(tabs.slice(index + 1))) },
            { id: 'close-all', label: text('关闭全部标签', 'Close all tabs'), onSelect: () => closeMany(ids(tabs)) },
          ] },
        ]}
      />
      <DangerConfirm
        open={pending !== null}
        onOpenChange={open => { if (!open) setPending(null) }}
        title={text('放弃未保存的修改？', 'Discard unsaved changes?')}
        consequence={text(`有 ${count} 个标签有未保存的修改，关闭后这些修改会丢失。没有修改的标签已经关上。`,
          `${count} ${pluralEn(count, 'tab')} ${pluralEn(count, 'has', 'have')} unsaved changes. Closing discards them. Tabs without changes are already closed.`)}
        recoverability={text(`丢弃后无法恢复。想保留就选「继续编辑」，再按 ${commandLabel('s')} 保存。`, `This cannot be undone. Choose “Keep editing” and press ${commandLabel('s')} to keep them.`)}
        confirmLabel={text('放弃并关闭', 'Discard and close')}
        cancelLabel={text('继续编辑', 'Keep editing')}
        onConfirm={() => {
          if (pending) discardAndCloseTabs(pending)
          setPending(null)
        }}
      />
    </div>
  )
}
