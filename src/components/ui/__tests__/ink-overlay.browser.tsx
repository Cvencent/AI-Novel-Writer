import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { page, userEvent } from 'vitest/browser'

import '../../../index.css'
import { useAppearanceStore } from '../../../stores/appearance-bootstrap'
import { useThemeStore } from '../../../stores/theme-store'
import { actionToast } from '../ActionToast'
import { alertError } from '../AlertDialog'
import { confirm } from '../Confirm'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../Dialog'
import { toast } from '../Toast'
import ClearProjectDataDialog from '../../dialogs/ClearProjectDataDialog'
import { DangerConfirm } from '../DangerConfirm'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SHOTS = '../../../../.runtime/rdv-shots'
const DARK = { layer: 'rgb(29, 29, 34)', ink: 'rgb(230, 228, 223)', danger: 'rgb(240, 138, 126)', accent: 'rgb(169, 190, 240)' }
const LIGHT = { ink: 'rgb(23, 23, 26)', accent: 'rgb(44, 74, 140)' }

const wait = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
const host = () => document.getElementById('ai-novel-ink-overlay')
const focused = () => document.activeElement as HTMLElement
const liveToasts = () => [...document.querySelectorAll<HTMLElement>('.pi-toast:not([data-exiting])')]
const buttonNamed = (scope: ParentNode, name: string) => [...scope.querySelectorAll('button')].find(b => b.textContent === name)!

let root: Root | undefined
let container: HTMLDivElement | undefined
const onOpenChange = vi.fn()

beforeEach(async () => {
  await page.viewport(1100, 760)
  useAppearanceStore.setState({ resolvedShell: 'stage' })
  useThemeStore.setState({ resolvedTheme: 'paper' })
})

afterEach(async () => {
  for (const close of document.querySelectorAll<HTMLButtonElement>('.pi-toast button[aria-label="关闭通知"]')) await act(async () => close.click())
  await wait(200)
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  host()?.remove()
  document.getElementById('ai-novel-toast-root')?.remove()
  useAppearanceStore.setState({ resolvedShell: 'classic' })
  useThemeStore.setState({ resolvedTheme: 'paper' })
})

describe('命令式弹窗', () => {
  it('alertError 渲染进带 .paper-ink 的宿主，深色下取到深色令牌，保留换行，焦点在确定上', async () => {
    useThemeStore.setState({ resolvedTheme: 'dark' })
    let resolved = false
    await act(async () => { void alertError('不是有效的项目目录\n\n请重新选择。', { title: '打开项目失败' }).then(() => { resolved = true }) })
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!
    expect(dialog.closest('.paper-ink')).toBe(host())
    expect(host()!.dataset.theme).toBe('dark')
    expect(getComputedStyle(dialog).backgroundColor).toBe(DARK.layer)
    expect(getComputedStyle(dialog.querySelector('.pi-dialog-title')!).color).toBe(DARK.ink)
    expect(dialog.querySelector('.pi-dialog-title')!.textContent).toBe('打开项目失败')
    expect(getComputedStyle(dialog.querySelector('.pi-dialog-message')!).whiteSpace).toBe('pre-line')
    expect(focused().textContent).toBe('确定')
    await page.screenshot({ path: `${SHOTS}/rdv-alert-dark.png` })

    await userEvent.keyboard('{Enter}')
    await wait(10)
    expect(resolved).toBe(true)
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('主题切换时宿主跟着换 data-theme', async () => {
    await act(async () => { void alertError('写入失败') })
    expect(host()!.dataset.theme).toBe('light')
    await act(async () => useThemeStore.setState({ resolvedTheme: 'galaxy' }))
    expect(host()!.dataset.theme).toBe('dark')
    await userEvent.keyboard('{Escape}')
  })

  it('危险确认：焦点落在取消，确认键为实心朱印，回车取消得到 false', async () => {
    let answer: boolean | undefined
    await act(async () => { void confirm('将删除第 3 章的定稿正文。删除后无法恢复。', { title: '删除定稿正文？', confirmText: '删除', danger: true }).then(value => { answer = value }) })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.className).toContain('pi-dialog--marked')
    expect(focused().textContent).toBe('取消')
    expect(buttonNamed(dialog, '删除').className).toContain('pi-btn--danger-solid')
    expect(dialog.querySelector('.pi-dialog-consequence')!.textContent).toContain('删除后无法恢复')
    await page.screenshot({ path: `${SHOTS}/rdv-confirm-danger-light.png` })
    await userEvent.keyboard('{Enter}')
    await wait(10)
    expect(answer).toBe(false)
  })

  it('普通确认：焦点在确认上，标题为墨色，点确认得到 true', async () => {
    let answer: boolean | undefined
    await act(async () => { void confirm('有未保存内容，保存后再切换吗？').then(value => { answer = value }) })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(focused().textContent).toBe('确认')
    expect(focused().className).toContain('pi-btn--primary')
    expect(getComputedStyle(dialog.querySelector('.pi-dialog-title')!).color).toBe(LIGHT.ink)
    expect(dialog.querySelector('.pi-dialog-mark')).toBeNull()
    await userEvent.click(focused())
    await wait(10)
    expect(answer).toBe(true)
  })

  it('对话框开着时点通知的关闭按钮，通知关闭而对话框不关', async () => {
    await act(async () => { void confirm('切换项目？') })
    await act(async () => toast.info('已复制安全诊断'))
    expect(liveToasts()).toHaveLength(1)
    await userEvent.click(page.getByRole('button', { name: '关闭通知' }))
    await wait(200)
    expect(liveToasts()).toHaveLength(0)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    await userEvent.keyboard('{Escape}')
  })

  it('旧外壳仍走旧弹窗，不建纸墨宿主', async () => {
    useAppearanceStore.setState({ resolvedShell: 'classic' })
    await act(async () => { void alertError('写入失败') })
    expect(document.querySelector('[role="alertdialog"]')!.closest('.paper-ink')).toBeNull()
    expect(host()).toBeNull()
    await userEvent.keyboard('{Escape}')
    await wait(250)
  })
})

describe('提示栈', () => {
  it('toast 与 actionToast 进同一个栈，最多 4 条、新的在下、互不重叠', async () => {
    await act(async () => {
      toast.success('第 1 章已定稿')
      actionToast.show({ type: 'success', message: '「第 2 章」已完成', actions: [{ label: '打开查看' }, { label: '忽略', variant: 'ghost' }] })
      toast.warning('字数超出限制')
      toast.error('保存失败\n\n磁盘已满')
      actionToast.show({ type: 'error', message: '第 3 章审稿失败\n\n模型连接超时，已保留草稿。', actions: [{ label: '查看' }] })
      toast.info('已复制本章正文')
    })
    await wait(200)
    expect(document.querySelectorAll('.pi-toast-stack')).toHaveLength(1)
    const items = liveToasts()
    expect(items).toHaveLength(4)
    expect(items.map(item => item.querySelector('.pi-toast-title')!.textContent)).toEqual(['字数超出限制', '保存失败', '第 3 章审稿失败', '已复制本章正文'])
    expect(items[1].querySelector('.pi-toast-text')!.textContent).toBe('磁盘已满')
    const rects = items.map(item => item.getBoundingClientRect())
    for (let i = 1; i < rects.length; i++) expect(rects[i].top).toBeGreaterThanOrEqual(rects[i - 1].bottom)
    expect(document.getElementById('ai-novel-toast-root')).toBeNull()
    expect(document.getElementById('ai-novel-action-toast-root')).toBeNull()
    await page.screenshot({ path: `${SHOTS}/rdv-toast-stack-light.png` })
  })

  it('actionToast 的 error 语气是危险色八角符号，以 alert 播报', async () => {
    useThemeStore.setState({ resolvedTheme: 'dark' })
    await act(async () => { actionToast.show({ type: 'error', message: '第 3 章审稿失败', actions: [{ label: '查看' }] }) })
    const [item] = liveToasts()
    expect(item.dataset.tone).toBe('danger')
    expect(item.getAttribute('role')).toBe('alert')
    const mark = item.querySelector('.pi-toast-mark')!
    expect(mark.querySelector('svg')!.getAttribute('class')).toContain('octagon-alert')
    expect(getComputedStyle(mark).color).toBe(DARK.danger)
    expect(getComputedStyle(item).backgroundColor).toBe(DARK.layer)
  })

  it('鼠标停在栈上时计时暂停，移开后照常消失；actionToast.show 返回的函数能关掉它', async () => {
    await act(async () => toast.success('已保存', 1000))
    await userEvent.hover(liveToasts()[0])
    await wait(1400)
    expect(liveToasts()).toHaveLength(1)
    await userEvent.unhover(liveToasts()[0])
    await wait(1300)
    expect(liveToasts()).toHaveLength(0)

    let dismiss = () => {}
    await act(async () => { dismiss = actionToast.show({ message: '发现新版本 v1.3', duration: 0 }) })
    expect(liveToasts()).toHaveLength(1)
    await act(async () => dismiss())
    expect(liveToasts()).toHaveLength(0)
  })

  it('点通知上的动作先执行回调再关闭', async () => {
    const open = vi.fn()
    await act(async () => actionToast.workflowComplete('「第 4 章」已完成', open))
    await userEvent.click(page.getByRole('button', { name: '打开查看' }))
    await wait(10)
    expect(open).toHaveBeenCalledTimes(1)
    expect(liveToasts()).toHaveLength(0)
  })
})

describe('旧 ui/Dialog 在新外壳下', () => {
  it('Portal 进纸墨宿主，外壳是浮笺，内容区的旧变量映射到纸墨令牌，尺寸仍听调用方', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <Dialog open>
        <DialogContent className="max-w-[420px]">
          <DialogHeader><DialogTitle>导出项目</DialogTitle></DialogHeader>
          <p className="px-6 text-[var(--color-accent)]">正文</p>
          <DialogFooter className="justify-end"><button type="button">导出</button></DialogFooter>
        </DialogContent>
      </Dialog>,
    ))
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.closest('.paper-ink')).toBe(host())
    expect(dialog.className).toContain('pi-dialog')
    expect(dialog.getBoundingClientRect().width).toBe(420)
    expect(getComputedStyle(dialog.querySelector('p')!).color).toBe(LIGHT.accent)
    expect(getComputedStyle(dialog.querySelector('.pi-dialog-foot')!).justifyContent).toBe('flex-end')
    expect(dialog.querySelector('.pi-dialog-close')!.className).toContain('pi-btn--icon')
  })
})

describe('清除生成内容', () => {
  it('新外壳里是标准危险确认：焦点在取消，勾选行改写后果句，全不选时不能确认', async () => {
    container = document.createElement('div')
    container.className = 'paper-ink'
    container.dataset.theme = 'light'
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<ClearProjectDataDialog open onClose={() => {}} />))
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.className).toContain('pi-dialog--marked')
    expect(focused().textContent).toBe('取消')
    const consequence = dialog.querySelector('.pi-dialog-consequence > p')!
    expect(consequence.textContent).toBe('将清除 3 类内容：故事架构与大纲、章节蓝图、草稿、定稿与审稿产物。')
    expect(getComputedStyle(dialog.querySelector('.pi-dialog-recover')!).color).toBe('rgb(180, 35, 24)')
    const boxes = [...dialog.querySelectorAll<HTMLElement>('.pi-check-row > .pi-check')]
    expect(boxes).toHaveLength(3)
    await page.screenshot({ path: `${SHOTS}/rdv-clear-light.png` })

    await userEvent.click(boxes[0])
    expect(consequence.textContent).toBe('将清除 2 类内容：章节蓝图、草稿、定稿与审稿产物。')
    await userEvent.click(boxes[1])
    await userEvent.click(boxes[2])
    expect(consequence.textContent).toBe('请至少选择一类内容。')
    expect(buttonNamed(dialog, '清除所选').disabled).toBe(true)
  })
})

describe('页面里的危险确认', () => {
  it('DangerConfirm 开着时点通知的关闭按钮，通知关闭而确认框不关', async () => {
    container = document.createElement('div')
    container.className = 'paper-ink'
    container.dataset.theme = 'light'
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <DangerConfirm open onOpenChange={onOpenChange} title="删除《灯塔》" consequence="将删除全部章节。" recoverability="删除后无法恢复。"
        confirmLabel="永久删除" cancelLabel="取消" onConfirm={() => {}} />,
    ))
    await act(async () => toast.success('已保存'))
    await userEvent.click(page.getByRole('button', { name: '关闭通知' }))
    await wait(200)
    expect(liveToasts()).toHaveLength(0)
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})
