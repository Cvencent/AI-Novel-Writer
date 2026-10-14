import { afterEach, describe, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../index.css'
import '../../../styles/paper-ink/index.css'
import type { ProjectData } from '../../../shared/ipc-channels'
import { useEditorStore, type EditorTab } from '../../../stores/editor-store'
import { useProjectStore } from '../../../stores/project-store'
import { Button } from '../../ui/Button'
import { ProgressRing } from '../ProgressRing'
import StageTabs from '../StageTabs'
import StageTopBar from '../StageTopBar'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement | undefined

async function mount(element: ReactElement) {
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(element))
  return host
}

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

const tab = (fields: Partial<EditorTab> & Pick<EditorTab, 'id' | 'type' | 'name'>): EditorTab => ({ projectKey: 'C:\\novels\\visual', ...fields })

describe('新外壳的外观细节', () => {
  it('外壳里的纸墨按钮保留自己的字号与字重，不被外壳按钮的字体重置压掉', async () => {
    const container = await mount(<Button variant="secondary" size="sm">继续编辑</Button>)
    const style = getComputedStyle(container.querySelector('button')!)
    expect([style.fontSize, style.fontWeight]).toEqual(['12px', '500'])
  })

  it('阶段与资料页的标签用流程脊上的名字；正文与恢复草稿沿用自己的名字', async () => {
    const tabs = [
      tab({ id: 'config', type: 'config', name: '小说配置' }),
      tab({ id: 'world', type: 'world-building', name: '故事架构' }),
      tab({ id: 'cards', type: 'chapter-card', name: '章节蓝图' }),
      tab({ id: 'plot', type: 'narrative-thread', name: '剧情树与叙事线索' }),
      tab({ id: 'draft', type: 'chapter', name: '第 3 章 · 雾钟' }),
      tab({ id: 'recovery', type: 'chapter-card', name: '蓝图恢复草稿', planningRecovery: {} as EditorTab['planningRecovery'] }),
    ]
    const container = await mount(<StageTabs tabs={tabs} activeTabId="draft" onSelect={() => undefined} onClose={() => undefined}
      tabDomId={id => `tab-${id}`} panelId="panel" />)
    expect([...container.querySelectorAll('[role="tab"]')].map(node => node.textContent))
      .toEqual(['设定', '架构', '蓝图', '剧情与伏笔', '第 3 章 · 雾钟', '蓝图恢复草稿'])
    expect(container.querySelector('[aria-label^="关闭「设定」"]')).not.toBeNull()
  })

  it('顶栏的沉浸写作开关与退出按钮用按钮原语', async () => {
    const container = await mount(<StageTopBar crumbs={['正文']} library={false} focus={false} focusTitle={{ title: '' }} workMenu={[]} onToggleFocus={() => undefined} />)
    expect(container.querySelector('[aria-label="进入沉浸写作"]')?.className).toContain('pi-btn--icon')
    await act(async () => root!.render(<StageTopBar crumbs={[]} library={false} focus focusTitle={{ chapter: 3, title: '雾钟' }} workMenu={[]} onToggleFocus={() => undefined} />))
    expect(container.querySelector('[aria-label="退出沉浸写作"]')?.className).toContain('pi-btn--secondary')
  })

  it('顶栏的保存状态只看这部作品：别的作品留着的未保存草稿不算', async () => {
    const restore = [useEditorStore.getState(), useProjectStore.getState()] as const
    const here = 'C:\\novels\\here'
    useProjectStore.setState({ currentProject: { id: 'here', sessionLease: 'l', name: '这里', path: here, novelConfig: {} } as unknown as ProjectData })
    useEditorStore.setState({ draftLedgers: {}, activeTabId: null, tabs: [tab({ id: 'other', type: 'chapter', name: '别处', projectKey: 'C:\\novels\\elsewhere', dirty: true })] })
    const container = await mount(<StageTopBar crumbs={[]} library={false} focus={false} focusTitle={{ title: '' }} workMenu={[]} onToggleFocus={() => undefined} />)
    expect(container.querySelector('[role="status"]')?.textContent).toBe('已保存')
    await act(async () => useEditorStore.setState(state => ({ tabs: [...state.tabs, tab({ id: 'mine', type: 'chapter', name: '这里', projectKey: here, dirty: true })] })))
    expect(container.querySelector('[role="status"]')?.textContent).toBe('未保存')
    useEditorStore.setState(restore[0], true)
    useProjectStore.setState(restore[1], true)
  })

  it('Tab 到激活标签时焦点环套住整个标签（含关闭按钮），画在标签内侧，离开底边接缝；鼠标点标签不出环', async () => {
    const tabs = [tab({ id: 'a', type: 'chapter', name: '第 1 章' }), tab({ id: 'b', type: 'chapter', name: '第 2 章' })]
    const container = await mount(<StageTabs tabs={tabs} activeTabId="b" onSelect={() => undefined} onClose={() => undefined} tabDomId={id => `tab-${id}`} panelId="panel" />)
    await userEvent.tab()
    const label = container.querySelector<HTMLElement>('#tab-b')!
    const whole = label.parentElement!
    expect(document.activeElement).toBe(label)
    expect([getComputedStyle(label).boxShadow, getComputedStyle(label).outlineStyle]).toEqual(['none', 'none'])
    const ring = getComputedStyle(whole, '::after')
    expect([ring.borderTopColor, ring.borderTopWidth, ring.borderBottomWidth]).toEqual(['rgb(44, 74, 140)', '2px', '2px'])
    const box = whole.getBoundingClientRect()
    const inset = [ring.top, ring.right, ring.bottom, ring.left].map(parseFloat)
    const close = whole.querySelector('.stage-tab-close')!.getBoundingClientRect()
    expect(inset).toEqual([2, 2, 3, 2])
    expect(close.right).toBeLessThanOrEqual(box.right - inset[1] - 2)
    expect(label.getBoundingClientRect().left).toBe(box.left)

    const other = container.querySelector<HTMLElement>('#tab-a')!
    await userEvent.click(other)
    expect(document.activeElement).toBe(other)
    expect(getComputedStyle(other.parentElement!, '::after').content).toBe('none')
  })

  it('激活标签在标签条可视区外时滚进来', async () => {
    const tabs = Array.from({ length: 24 }, (_, index) => tab({ id: `t${index}`, type: 'chapter', name: `第 ${index + 1} 章 · 很长很长的章节名` }))
    const props = { tabs, onSelect: () => undefined, onClose: () => undefined, tabDomId: (id: string) => `tab-${id}`, panelId: 'panel' }
    const container = await mount(<div style={{ width: 640 }}><StageTabs {...props} activeTabId="t0" /></div>)
    const strip = container.querySelector<HTMLElement>('.stage-tabs')!
    const visible = (id: string) => {
      const box = strip.getBoundingClientRect()
      const rect = container.querySelector(`#tab-${id}`)!.parentElement!.getBoundingClientRect()
      return rect.left >= box.left - 1 && rect.right <= box.right + 1
    }
    expect(visible('t23')).toBe(false)
    await act(async () => root!.render(<div style={{ width: 640 }}><StageTabs {...props} activeTabId="t23" /></div>))
    expect(visible('t23')).toBe(true)
    await act(async () => root!.render(<div style={{ width: 640 }}><StageTabs {...props} activeTabId="t0" /></div>))
    expect(visible('t0')).toBe(true)
  })

  it('作品名很长时顶栏标题以省略号收尾，窗口按钮仍在视口内', async () => {
    await page.viewport(1024, 640)
    const restore = useProjectStore.getState()
    const name = '雾钟'.repeat(40)
    useProjectStore.setState({ currentProject: { id: 'long', sessionLease: 'l', name, path: 'C:\\novels\\long', novelConfig: {} } as unknown as ProjectData })
    try {
      const container = await mount(<div style={{ width: 1024 }}><StageTopBar crumbs={['正文', '第 3 章']} library={false} focus={false} focusTitle={{ title: '' }} workMenu={[]} onToggleFocus={() => undefined} /></div>)
      const close = page.getByRole('button', { name: '关闭', exact: true }).element().getBoundingClientRect()
      expect(close.right).toBeLessThanOrEqual(1024)
      const title = container.querySelector<HTMLElement>('.stage-work-name')!
      expect(title.textContent).toBe(name)
      expect(getComputedStyle(title).textOverflow).toBe('ellipsis')
      expect(title.scrollWidth).toBeGreaterThan(title.clientWidth)
    } finally {
      useProjectStore.setState(restore, true)
    }
  })

  it('进度环半径按画板取 size / 2 - stroke：流程脊 22 / 2.5 为 8.5，运行胶囊 18 / 2 为 7', async () => {
    const container = await mount(<><ProgressRing size={22} stroke={2.5} ratio={0.5} /><ProgressRing size={18} stroke={2} ratio={0.5} /></>)
    expect([...container.querySelectorAll('svg')].map(svg => svg.querySelector('circle')?.getAttribute('r'))).toEqual(['8.5', '7'])
  })
})
