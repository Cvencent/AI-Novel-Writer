import { useAppearanceStore } from '../../stores/appearance-bootstrap'
import { useThemeStore } from '../../stores/theme-store'
import { inkTheme } from '../stage/ink-theme'

const HOST_ID = 'ai-novel-ink-overlay'
let unsubscribeTheme: (() => void) | undefined

/** 命令式弹窗、提示栈与全局旧对话框只在新外壳下改用纸墨样式；旧外壳原样保留，RD-10 随旧外壳删除这个判断。 */
export function isStageShell() {
  return useAppearanceStore.getState().resolvedShell === 'stage'
}

/**
 * body 下唯一的纸墨宿主。挂在 body 上的浮层碰不到外壳根的 .paper-ink，所以宿主自带 .paper-ink 与 data-theme，
 * 并跟随主题切换；它是 display: contents，不画底色、不建层叠上下文。
 */
export function inkOverlayHost(): HTMLElement {
  const existing = document.getElementById(HOST_ID)
  if (existing) return existing
  const host = document.createElement('div')
  host.id = HOST_ID
  host.className = 'paper-ink pi-overlay-host'
  host.dataset.theme = inkTheme(useThemeStore.getState().resolvedTheme)
  unsubscribeTheme?.()
  unsubscribeTheme = useThemeStore.subscribe(state => { host.dataset.theme = inkTheme(state.resolvedTheme) })
  document.body.append(host)
  return host
}

/** 宿主里放一个独立的挂载点：命令式弹窗用完即删，提示栈常驻。 */
export function createInkOverlayMount(): HTMLElement {
  const mount = document.createElement('div')
  inkOverlayHost().append(mount)
  return mount
}
