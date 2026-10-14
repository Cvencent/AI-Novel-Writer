import { useRef } from 'react'

/**
 * 记下此刻的焦点，返回把焦点放回去的函数。打开它的元素已被移除或已禁用时，
 * 落到 container 最近的、仍在文档里的可聚焦祖先（带 tabindex 的侧页、内容区等），不让焦点掉到 body。
 */
export function rememberFocus(container: Element | null): () => void {
  const active = document.activeElement
  const opener = active instanceof HTMLElement && active !== document.body ? active : null
  const fallbacks: HTMLElement[] = []
  for (let node = container?.parentElement; node; node = node.parentElement) {
    if (node.hasAttribute('tabindex')) fallbacks.push(node)
  }
  return () => {
    for (const target of [opener, ...fallbacks]) {
      if (!target?.isConnected) continue
      target.focus()
      if (document.activeElement === target) return
    }
  }
}

/**
 * 受控打开、没有 Dialog.Trigger 的 Radix 对话框用：Radix 关闭时只把焦点还给 Trigger，没有就落到 body。
 * remember 在 onOpenAutoFocus 里调（此时焦点还在打开它的按钮上），onCloseAutoFocus 直接交给 Content。
 */
export function useDialogFocusReturn() {
  const restore = useRef<() => void>(() => {})
  return {
    remember: () => { restore.current = rememberFocus(document.activeElement) },
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault()
      restore.current()
    },
  }
}
