import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../../index.css'
import '../../../../styles/paper-ink/index.css'
import '../../stage.css'
import { useLocaleStore } from '../../../../stores/locale-store'
import ArcReviseDialog from '../ArcReviseDialog'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const arcs = [
  { id: 1, arcIndex: 1, fromChapter: 1, toChapter: 40, title: '学院觉醒', summary: '主角觉醒。', beat: 'setup', status: 'confirmed', revision: 1, createdAt: '', updatedAt: '' },
  { id: 2, arcIndex: 2, fromChapter: 41, toChapter: 100, title: '源核争夺', summary: '多方争夺。', beat: 'escalation', status: 'draft', revision: 0, createdAt: '', updatedAt: '' },
] as never

let root: Root | undefined
let host: HTMLDivElement | undefined
const onConfirm = vi.fn()
const onClose = vi.fn()

const button = (name: string) => [...document.querySelectorAll('button')]
  .find(candidate => candidate.textContent?.includes(name))

beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh-CN' })
  onConfirm.mockClear()
  onClose.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
})

async function render(props: Partial<Parameters<typeof ArcReviseDialog>[0]> = {}) {
  await act(async () => {
    root!.render(
      <ArcReviseDialog
        scope={{ kind: 'arc', arcIndex: 1 }}
        arcs={arcs}
        staleChapters={[]}
        totalChapters={300}
        onConfirm={onConfirm}
        onClose={onClose}
        {...props}
      />,
    )
  })
  await act(async () => { await Promise.resolve() })
}

describe('ArcReviseDialog', () => {
  it('展示受影响章号清单（整段重生成时覆盖该段全部章节）', async () => {
    await render()
    const textContent = document.body.textContent ?? ''
    expect(textContent).toContain('将重新生成 40 章')
    expect(textContent).toContain('受影响章号：1、2、3')
  })

  it('存在过期章节时提示已有细纲过期，但仍展示整段影响范围', async () => {
    await render({ staleChapters: [3, 4, 5] })
    const textContent = document.body.textContent ?? ''
    expect(textContent).toContain('其中 3 章细纲已因上次粗纲改动标记为过期')
    expect(textContent).toContain('将重新生成 40 章')
    expect(textContent).toContain('受影响章号：1、2、3')
  })

  it('未填方向时确认按钮禁用', async () => {
    await render()
    const confirm = button('按此方向重新生成') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
  })

  it('填方向后确认触发 onConfirm 并带上影响范围', async () => {
    await render()
    const textarea = document.querySelector('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, '拉回学院线')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const confirm = button('按此方向重新生成') as HTMLButtonElement
    await act(async () => { confirm.click() })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm.mock.calls[0]![0]).toBe('拉回学院线')
    expect((onConfirm.mock.calls[0]![1] as number[]).length).toBe(40)
  })

  it('取消不发起生成并调用 onClose', async () => {
    await render()
    await act(async () => { (button('取消') as HTMLButtonElement).click() })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('从某章之后重来时覆盖到全书末尾', async () => {
    await render({ scope: { kind: 'from-chapter', chapterNumber: 100 } })
    const textContent = document.body.textContent ?? ''
    expect(textContent).toContain('将重新生成 201 章')
  })
})
