import { createElement, useEffect, useState, type ComponentType } from 'react'
import { useLocaleStore } from '../../stores/locale-store'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'

/** Chromium 动态导入失败的消息：Failed to fetch dynamically imported module: <地址>。 */
const FAILED_MODULE_URL = /dynamically imported module: (\S+)/

/**
 * 书房冷启动用不到的整页（设定页、设置页）拆成单独的代码块，外壳空下来后预先载入。
 * 不用 React.lazy：它首次渲染一定挂起，Suspense 的揭示节流会让页面晚出现（见 RD-3 的 f89bc700）；
 * 这里载入完成前什么也不画，预载入后打开页面时代码已在手里，直接渲染。
 */
export function lazyPage<P extends object>(load: () => Promise<{ default: ComponentType<P> }>) {
  type Module = { default: ComponentType<P> }
  let loaded: ComponentType<P> | null = null
  let pending: Promise<boolean> | null = null
  let failedUrl: string | null = null
  let retries = 0
  // Chromium 记住失败的动态导入，同一地址再 import 不会重新读文件；重试时给失败的地址加查询串，换一个模块记录。
  const attemptLoad = (): Promise<Module> => failedUrl
    ? import(/* @vite-ignore */ `${failedUrl}?retry=${++retries}`) as Promise<Module>
    : load()
  // 载入失败时清掉 pending，重试或下次打开页面会重新载入，而不是一直拿着失败的结果。
  const preload = () => (pending ??= attemptLoad().then(
    module => {
      loaded = module.default
      return true
    },
    (error: unknown) => {
      pending = null
      failedUrl ??= FAILED_MODULE_URL.exec(error instanceof Error ? error.message : '')?.[1] ?? null
      console.warn('[lazyPage] 页面代码载入失败', error)
      return false
    },
  ))

  function Page(props: P) {
    const text = useLocaleStore(s => s.text)
    const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
    const attempt = () => {
      setStatus('loading')
      void preload().then(ok => setStatus(ok ? 'ready' : 'failed'))
    }
    useEffect(() => {
      if (!loaded) attempt()
    }, [])
    if (loaded) return createElement(loaded, props)
    if (status !== 'failed') return null
    return (
      <EmptyState
        heading={text('页面没有载入', 'This page did not load')}
        description={text('页面代码读取失败，作品内容不受影响。', 'The page code could not be read. Your book is not affected.')}
        action={<Button variant="primary" onClick={attempt}>{text('重试', 'Retry')}</Button>}
      />
    )
  }

  return { Page, preload }
}
