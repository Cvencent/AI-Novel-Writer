/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CircleCheck, Info, OctagonAlert, TriangleAlert, X, type LucideIcon } from 'lucide-react'
import { useLocaleStore } from '../../stores/locale-store'
import { Button } from './Button'
import { createInkOverlayMount } from './ink-overlay'

/**
 * 新外壳下 toast.* 与 actionToast.* 共用的提示栈：右下角一列，新的在下，同时最多 4 条，再来的把最旧的一条挤出；
 * 鼠标停在栈上时所有计时暂停。两个公共 API 的签名不变，只是往这里推条目。
 */
export type ToastTone = 'ok' | 'info' | 'warn' | 'danger'

export interface ToastStackAction {
  label: string
  onClick?: () => void | Promise<void>
  emphasis: 'secondary' | 'text'
}

interface ToastStackInput {
  tone: ToastTone
  /** 调用方写的整段消息；第一个空行之前是标题，之后是说明。 */
  message: string
  actions?: ToastStackAction[]
  /** 毫秒；0 表示不自动消失。 */
  duration: number
}

interface ToastStackEntry extends ToastStackInput {
  id: number
  exiting: boolean
}

const TOAST_STACK_LIMIT = 4
const EXIT_MS = 140

const toneIcons: Record<ToastTone, LucideIcon> = { ok: CircleCheck, info: Info, warn: TriangleAlert, danger: OctagonAlert }

let entries: ToastStackEntry[] = []
let counter = 0
const listeners = new Set<() => void>()
let mount: HTMLElement | null = null
let stackRoot: Root | null = null

function publish(next: ToastStackEntry[]) {
  entries = next
  listeners.forEach(listener => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function ensureStack() {
  if (mount?.isConnected) return
  // 宿主被移走后旧栈不能留着：它的计时器会替新栈关掉条目
  stackRoot?.unmount()
  mount = createInkOverlayMount()
  stackRoot = createRoot(mount)
  stackRoot.render(<ToastStack />)
}

function dismissToast(id: number) {
  if (!entries.some(entry => entry.id === id && !entry.exiting)) return
  publish(entries.map(entry => (entry.id === id ? { ...entry, exiting: true } : entry)))
  setTimeout(() => publish(entries.filter(entry => entry.id !== id)), EXIT_MS)
}

/** 推入一条通知，返回关闭它的函数。 */
export function pushToast(input: ToastStackInput): () => void {
  ensureStack()
  const id = ++counter
  publish([...entries, { ...input, id, exiting: false }])
  const live = entries.filter(entry => !entry.exiting)
  live.slice(0, Math.max(0, live.length - TOAST_STACK_LIMIT)).forEach(entry => dismissToast(entry.id))
  return () => dismissToast(id)
}

/** 对话框开着时点通知不能被当成「点外部」而关掉对话框。 */
export function keepToastStackClickable(event: { target: EventTarget | null; preventDefault: () => void }) {
  if (event.target instanceof Element && event.target.closest('.pi-toast-stack')) event.preventDefault()
}

function splitMessage(message: string) {
  const at = message.indexOf('\n\n')
  return at < 0 ? { title: message, text: '' } : { title: message.slice(0, at), text: message.slice(at + 2).trim() }
}

function ToastCard({ entry, paused }: { entry: ToastStackEntry; paused: boolean }) {
  const text = useLocaleStore(s => s.text)
  const remaining = useRef(entry.duration)
  const Icon = toneIcons[entry.tone]
  const { title, text: detail } = splitMessage(entry.message)

  useEffect(() => {
    if (paused || entry.exiting || entry.duration <= 0) return
    const startedAt = Date.now()
    const timer = setTimeout(() => dismissToast(entry.id), remaining.current)
    return () => {
      clearTimeout(timer)
      remaining.current -= Date.now() - startedAt
    }
  }, [paused, entry.exiting, entry.duration, entry.id])

  const run = async (action: ToastStackAction) => {
    await action.onClick?.()
    dismissToast(entry.id)
  }

  return (
    <div className="pi-toast" data-tone={entry.tone} data-exiting={entry.exiting || undefined} role={entry.tone === 'danger' ? 'alert' : 'status'}>
      <span className="pi-toast-mark" aria-hidden><Icon /></span>
      <div className="pi-toast-body">
        <p className="pi-toast-title">{title}</p>
        {detail && <p className="pi-toast-text">{detail}</p>}
      </div>
      <Button variant="icon" size="sm" aria-label={text('关闭通知', 'Dismiss notification')} onClick={() => dismissToast(entry.id)}>
        <X aria-hidden />
      </Button>
      {entry.actions && entry.actions.length > 0 && (
        <div className="pi-toast-actions">
          {entry.actions.map(action => (
            <Button key={action.label} variant={action.emphasis} size="sm" onClick={() => void run(action)}>{action.label}</Button>
          ))}
        </div>
      )}
    </div>
  )
}

function ToastStack() {
  const items = useSyncExternalStore(subscribe, () => entries)
  const [paused, setPaused] = useState(false)
  // 关掉最后一条时指针下已没有元素，mouseleave 不一定触发
  if (paused && items.length === 0) setPaused(false)
  return (
    <div className="pi-toast-stack" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      {items.map(entry => <ToastCard key={entry.id} entry={entry} paused={paused} />)}
    </div>
  )
}
