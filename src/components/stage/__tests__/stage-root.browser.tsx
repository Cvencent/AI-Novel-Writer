/* eslint-disable react-refresh/only-export-components */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { page, userEvent } from 'vitest/browser'

import '../../../index.css'
import { APPEARANCE_STORAGE_KEY } from '../../../shared/appearance-profile'
import { useAppearanceStore } from '../../../stores/appearance-bootstrap'
import type { WindowCloseGuard } from '../../layout/use-window-close-guard'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../ui/Dialog'
import StageRoot from '../StageRoot'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement | undefined

function Broken(): never {
  throw new Error('外壳渲染失败')
}

const idleGuard = (overrides: Partial<WindowCloseGuard> = {}): WindowCloseGuard => ({
  exitRequest: null, exitBusy: false, exitError: null,
  cancelExit: vi.fn(async () => undefined), discardAndExit: vi.fn(async () => undefined), saveAndExit: vi.fn(async () => undefined),
  ...overrides,
})

async function mount(guard: WindowCloseGuard, children: ReactNode = <Broken />) {
  host = document.createElement('div')
  host.style.cssText = 'width: 1280px; height: 800px;'
  document.body.append(host)
  root = createRoot(host)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  await act(async () => root!.render(<StageRoot theme="paper" exitGuard={guard}>{children}</StageRoot>))
}

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  vi.restoreAllMocks()
  localStorage.removeItem(APPEARANCE_STORAGE_KEY)
  document.getElementById('ai-novel-ink-overlay')?.remove()
  useAppearanceStore.setState({ resolvedShell: 'classic' })
})

describe('新外壳渲染出错', () => {
  it('显示出错界面，「切回工作台」写回 unset，下次启动进工作台，存储是旧版本也能读的 v1', async () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ schemaVersion: 2, revision: 3, shellPreference: 'stage', colorTheme: 'paper',
      zoom: 1, writingFont: 'lxgw-wenkai', uiFont: 'noto-sans-sc', origin: 'author', legacyImportCompleted: true }))
    await useAppearanceStore.getState().bootstrap({
      waitForMainReady: async () => ({ state: 'ready', globalGeneration: 'g', skinRevision: 1 }),
      readSkinSnapshot: async () => ({ globalGeneration: 'g', skinRevision: 1, backgroundSkin: 'classic' }),
      acknowledgeReadback: async () => true,
    })
    expect(useAppearanceStore.getState().resolvedShell).toBe('stage')
    await mount(idleGuard())
    expect(host!.querySelector('h3')?.textContent).toBe('创作流程界面出错了')
    const button = [...host!.querySelectorAll('button')].find(candidate => candidate.textContent === '切回工作台')!
    expect(button.classList.contains('pi-btn--primary')).toBe(true)
    await act(async () => button.click())
    expect(useAppearanceStore.getState().resolvedShell).toBe('writer')
    expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY)!)).toMatchObject({ schemaVersion: 1, shellPreference: 'unset', revision: 4 })
  })

  it('外壳出错后关窗，退出确认仍在纸墨作用域里，按钮能用', async () => {
    const saveAndExit = vi.fn(async () => undefined)
    await mount(idleGuard({ exitRequest: { requestId: 'close-1' }, saveAndExit }))
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('退出前处理未保存的内容')
    expect(dialog.closest('.paper-ink')).not.toBeNull()
    expect(getComputedStyle(dialog).backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
    const save = [...dialog.querySelectorAll('button')].find(candidate => candidate.textContent === '保存并退出')!
    await act(async () => save.click())
    expect(saveAndExit).toHaveBeenCalledOnce()
  })

  it('退出确认点「取消」或按 Esc 关闭后，焦点回到弹出它之前的元素', async () => {
    useAppearanceStore.setState({ resolvedShell: 'stage' })
    function Harness() {
      const [exitRequest, setExitRequest] = useState<WindowCloseGuard['exitRequest']>(null)
      return (
        <StageRoot theme="paper" exitGuard={idleGuard({ exitRequest, cancelExit: async () => setExitRequest(null) })}>
          <button type="button" onClick={() => setExitRequest({ requestId: 'close-3' })}>第 3 章</button>
        </StageRoot>
      )
    }
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root!.render(<Harness />))
    const chapter = page.getByRole('button', { name: '第 3 章' })
    const landed: boolean[] = []
    for (const close of ['取消', 'Escape']) {
      await userEvent.click(chapter)
      await expect.element(page.getByRole('dialog')).toBeVisible()
      if (close === 'Escape') await userEvent.keyboard('{Escape}')
      else await userEvent.click(page.getByRole('button', { name: close }))
      await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
      await new Promise(resolve => setTimeout(resolve, 20))
      landed.push(document.activeElement === chapter.element())
    }
    expect(landed).toEqual([true, true])
  })

  it('导出等旧对话框开着时关窗，退出确认与遮罩画在它上面', async () => {
    useAppearanceStore.setState({ resolvedShell: 'stage' })
    await mount(idleGuard({ exitRequest: { requestId: 'close-2' } }), (
      <Dialog open>
        <DialogContent><DialogHeader><DialogTitle>导出项目</DialogTitle></DialogHeader></DialogContent>
      </Dialog>
    ))
    const exit = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(dialog => dialog.textContent?.includes('退出前处理未保存的内容'))!
    const legacy = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(dialog => dialog.textContent?.includes('导出项目'))!
    // Radix 让下层的模态不接指针，elementFromPoint 会跳过它；放开之后取到的才是画在最上面的那一层
    for (const layer of document.querySelectorAll<HTMLElement>('[role="dialog"], .pi-scrim')) layer.style.pointerEvents = 'auto'
    const center = (element: Element) => {
      const rect = element.getBoundingClientRect()
      return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    }
    expect(center(exit)?.closest('[role="dialog"]')).toBe(exit)
    expect(center(legacy)?.closest('[role="dialog"]')).toBe(exit)
  })
})
