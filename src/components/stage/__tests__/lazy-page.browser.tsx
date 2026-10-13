import { afterEach, expect, it, vi } from 'vitest'
import { act, type ComponentType, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { lazyPage } from '../lazy-page'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement | undefined

async function mount(node: ReactNode) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(node))
}

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

it('页面代码第一次载入失败不留未处理的拒绝；再打开时重新载入并显示页面', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const load = vi.fn<() => Promise<{ default: ComponentType<{ title: string }> }>>()
    .mockRejectedValueOnce(new Error('chunk 404'))
    .mockResolvedValueOnce({ default: ({ title }: { title: string }) => <h1>{title}</h1> })
  const { Page, preload } = lazyPage(load)

  await expect(preload()).resolves.toBeUndefined()
  await mount(<Page title="设置" />)
  expect(load).toHaveBeenCalledTimes(2)
  expect(host!.querySelector('h1')?.textContent).toBe('设置')
  expect(warn).toHaveBeenCalledWith('[lazyPage] 页面代码载入失败', expect.any(Error))
  warn.mockRestore()
})
