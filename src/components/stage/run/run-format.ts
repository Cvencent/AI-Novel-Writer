import type { Locale } from '../../../i18n/types'

type Text = (zh: string, en: string) => string

/** 时刻只到分钟，例如 21:26。 */
export function clockTime(iso: string | undefined, locale: Locale): string {
  return iso ? new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false }) : ''
}

/** 步骤耗时：不到一分钟写秒，否则写分与秒。 */
export function stepDuration(startedAt: string | undefined, completedAt: string | undefined, text: Text): string {
  if (!startedAt || !completedAt) return ''
  const seconds = Math.max(0, Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1000))
  if (seconds < 60) return text(`${seconds} 秒`, `${seconds}s`)
  const minutes = Math.floor(seconds / 60)
  return text(`${minutes} 分 ${seconds % 60} 秒`, `${minutes}m ${seconds % 60}s`)
}

/** 统计数字：大数按本地习惯缩写（21.4万 / 21.4K），没有上报时写一条短横。 */
export function compactNumber(value: number | null, locale: Locale): string {
  if (value === null) return '—'
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}
