import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { userEvent } from 'vitest/browser'

import '../../../index.css'
import '../../../styles/paper-ink/index.css'
import '../stage.css'
import { Button } from '../../ui/Button'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement | undefined

async function mount(theme: 'light' | 'dark') {
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.dataset.theme = theme
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(
    <>
      <div className="stage-library">
        <div className="stage-starts">
          <button type="button" className="stage-start"><span className="stage-start-text"><b>新建作品</b></span></button>
          <div className="pi-anchor"><Button variant="text" className="stage-start" aria-expanded={false}><span className="stage-start-text"><b>导入</b></span></Button></div>
        </div>
        <div className="stage-book" data-tone="paper"><button type="button" className="stage-book-cover">灯塔</button></div>
      </div>
      <button type="button" className="stage-chip">题材</button>
      <button type="button" className="stage-set-theme" role="radio" aria-checked={false}>纸墨</button>
      <button type="button" className="stage-set-link">外观</button>
    </>,
  ))
  return host
}

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
})

const look = (element: Element) => {
  element.getAnimations().forEach(animation => animation.finish())
  const style = getComputedStyle(element)
  return { bg: style.backgroundColor, shadow: style.boxShadow, transform: style.transform }
}

/** 键盘按住空格就是按下态（:active），不受指针悬停干扰。 */
async function pressed(element: HTMLElement) {
  element.focus()
  await userEvent.keyboard('[Space>]')
  const state = look(element)
  await userEvent.keyboard('[/Space]')
  return state
}

describe('新外壳自写的卡片、标签与导航有按压反馈', () => {
  it.each(['light', 'dark'] as const)('%s 主题开始卡、封面、设定标签、主题单选、设置导航按下时与聚焦未按下时不同', async (theme) => {
    const container = await mount(theme)
    for (const selector of ['.stage-start', '.stage-book-cover', '.stage-chip', '.stage-set-theme', '.stage-set-link']) {
      const element = container.querySelector<HTMLElement>(selector)!
      await userEvent.hover(document.body, { position: { x: 1, y: 1 } })
      element.focus()
      const focused = look(element)
      const press = await pressed(element)
      expect(press, selector).not.toEqual(focused)
    }
  })

  it('导入卡是菜单触发的纸墨文字按钮，静止、按下与展开时与另两张开始卡同一个样子', async () => {
    const container = await mount('light')
    const [native, menu] = [...container.querySelectorAll<HTMLElement>('.stage-start')]
    const card = (element: HTMLElement) => {
      const style = getComputedStyle(element)
      return { bg: style.backgroundColor, border: style.borderTopColor, radius: style.borderTopLeftRadius, padding: style.padding,
        spacing: style.letterSpacing, weight: style.fontWeight, shadow: style.boxShadow }
    }
    await userEvent.hover(document.body, { position: { x: 1, y: 1 } })
    expect(card(menu)).toEqual(card(native))
    expect(await pressed(menu)).toEqual(await pressed(native))
    menu.setAttribute('aria-expanded', 'true')
    expect(look(menu).bg).toEqual((await pressed(native)).bg)
  })
})
