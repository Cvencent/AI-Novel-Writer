import { createElement, useEffect, useReducer, type ComponentType } from 'react'

/**
 * 书房冷启动用不到的整页（设定页、设置页）拆成单独的代码块，外壳空下来后预先载入。
 * 不用 React.lazy：它首次渲染一定挂起，Suspense 的揭示节流会让页面晚出现（见 RD-3 的 f89bc700）；
 * 这里载入完成前什么也不画，预载入后打开页面时代码已在手里，直接渲染。
 */
export function lazyPage<P extends object>(load: () => Promise<{ default: ComponentType<P> }>) {
  let loaded: ComponentType<P> | null = null
  let pending: Promise<unknown> | null = null
  const preload = () => (pending ??= load().then(module => { loaded = module.default }))

  function Page(props: P) {
    const [, rerender] = useReducer((count: number) => count + 1, 0)
    useEffect(() => {
      if (!loaded) void preload().then(rerender)
    }, [])
    return loaded ? createElement(loaded, props) : null
  }

  return { Page, preload }
}
