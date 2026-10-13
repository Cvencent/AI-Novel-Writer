import { afterEach, expect, it, vi } from 'vitest'
import { act, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { lazyPage } from '../lazy-page'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

it('页面代码载入失败时写明没有载入并给出重试；重试成功后显示页面', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const load = vi.fn<() => Promise<{ default: ComponentType<{ title: string }> }>>()
    .mockRejectedValueOnce(new Error('chunk 404'))
    .mockResolvedValueOnce({ default: ({ title }: { title: string }) => <h1>{title}</h1> })
  const { Page } = lazyPage(load)

  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<Page title="设置" />))
  await expect.poll(() => host!.querySelector('h3')?.textContent).toBe('页面没有载入')
  expect(warn).toHaveBeenCalledWith('[lazyPage] 页面代码载入失败', expect.any(Error))

  const retry = [...host!.querySelectorAll('button')].find(button => button.textContent === '重试')
  await act(async () => retry!.click())
  await expect.poll(() => host!.querySelector('h1')?.textContent).toBe('设置')
  expect(load).toHaveBeenCalledTimes(2)
  warn.mockRestore()
})
