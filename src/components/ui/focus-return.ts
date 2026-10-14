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
