import { useEffect, useState } from 'react'
import { ipc } from '../../services/ipc-client'
import { useLocaleStore } from '../../stores/locale-store'

export interface ProxyDraft {
  enabled: boolean
  type: 'http' | 'socks5'
  host: string
  /** 输入框清空时为空串，失焦时回退到 7890。 */
  port: number | ''
}

/** 网络代理的读取与保存。旧外壳设置弹窗与新外壳设置页共用。 */
export function useProxySettings() {
  const text = useLocaleStore(s => s.text)
  const [proxy, setProxy] = useState<ProxyDraft>({ enabled: false, type: 'http', host: '', port: 7890 })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    ipc.invoke('config:get').then((cfg) => {
      if (cfg?.proxy) {
        setProxy({
          enabled: cfg.proxy.enabled ?? false,
          type: cfg.proxy.type ?? 'http',
          host: cfg.proxy.host ?? '',
          port: cfg.proxy.port ?? 7890,
        })
      }
    }).catch(() => { })
  }, [])

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const result = await ipc.invoke('config:set', { proxy: { ...proxy, port: Number(proxy.port) || 7890 } })
      if (!result.success) throw new Error(result.error || text('未知错误', 'Unknown error'))
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (error) {
      setSaved(false)
      setSaveError(text(
        `代理配置保存失败：${error instanceof Error ? error.message : String(error)}`,
        `Could not save proxy settings: ${error instanceof Error ? error.message : String(error)}`,
      ))
    } finally {
      setSaving(false)
    }
  }

  return {
    proxy,
    update: (patch: Partial<ProxyDraft>) => setProxy(previous => ({ ...previous, ...patch })),
    restorePortOnBlur: () => setProxy(previous => (Number(previous.port) ? previous : { ...previous, port: 7890 })),
    saving,
    saved,
    saveError,
    save,
  }
}
