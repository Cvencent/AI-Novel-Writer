import type { Locale } from '../../../i18n/types'

type Text = (zh: string, en: string) => string

/** 时刻只到分钟，例如 21:26；没有时间时为空，时间无法解析时写一条短横。 */
export function clockTime(at: string | Date | undefined, locale: Locale): string {
  if (!at) return ''
  const time = new Date(at)
  return Number.isNaN(time.getTime()) ? '—' : time.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** 步骤耗时：不到一分钟写秒，否则写分与秒。 */
export function stepDuration(startedAt: string | undefined, completedAt: string | undefined, text: Text): string {
  if (!startedAt || !completedAt) return ''
  const seconds = Math.max(0, Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1000))
  if (seconds < 60) return text(`${seconds} 秒`, `${seconds}s`)
  const minutes = Math.floor(seconds / 60)
  return text(`${minutes} 分 ${seconds % 60} 秒`, `${minutes}m ${seconds % 60}s`)
}

/** 调用记录里常见用途的说法；其余照原样显示。 */
const PURPOSES: Record<string, [string, string]> = {
  generation: ['生成', 'Generation'],
  'chapter-draft': ['写正文', 'Chapter draft'],
  'chapter-draft-short-outline': ['写细纲', 'Chapter outline'],
  'chapter-draft-continuation': ['续写正文', 'Draft continuation'],
  'chapter-draft-condense': ['压缩正文', 'Draft condensing'],
  'review-chapter': ['审稿', 'Review'],
  'chapter-review': ['审稿', 'Review'],
  'refine-draft': ['修稿', 'Revision'],
  'refine-from-review': ['按审稿修稿', 'Revision from review'],
  'character-state': ['角色状态', 'Character state'],
  'finalized-character-state': ['角色状态', 'Character state'],
  'finalized-chapter-notes': ['章节要点', 'Chapter notes'],
  'chapter-blueprint-directory': ['生成蓝图', 'Blueprints'],
  'generate-core-seed': ['填充设定', 'Setup fill'],
  'generate-world-building': ['世界观', 'World-building'],
  'generate-plot-outline': ['细纲', 'Plot outline'],
  'generate-arc-outline': ['生成粗纲', 'Arc outline'],
  'reverse-arc-outline': ['反推粗纲', 'Derive arc outline'],
  'arc-outline-review': ['检查粗纲', 'Arc review'],
  'planning-material-character-extraction': ['提取角色卡', 'Character extraction'],
  'plot-tree-snapshot': ['剧情树', 'Plot tree'],
}

/** 带运行参数的 purpose 前缀：`plot-outline:chapter:7:normal` 这类键按家族归一显示，
 *  不把章号与尝试序号吐给作者。 */
const PURPOSE_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: [string, string] }> = [
  { pattern: /^plot-outline:chapter:\d+:(?:normal|compact)$/u, label: ['写细纲', 'Chapter outline'] },
  { pattern: /^arc-outline:(?:from|revise):\d+$/u, label: ['生成粗纲', 'Arc outline'] },
  { pattern: /^chapter-blueprint-directory:compact-single/u, label: ['生成蓝图', 'Blueprints'] },
  { pattern: /^finalize-sync:chapter:\d+$/u, label: ['定稿同步', 'Finalize sync'] },
  { pattern: /^editor-ai-/u, label: ['编辑器改写', 'Editor rewrite'] },
]

export function callPurpose(purpose: string, text: Text): string {
  const known = PURPOSES[purpose]
  if (known) return text(...known)
  const matched = PURPOSE_PATTERNS.find(({ pattern }) => pattern.test(purpose))
  return matched ? text(...matched.label) : purpose || '—'
}

/** 统计数字：大数按本地习惯缩写（21.4万 / 21.4K），没有上报时写一条短横。 */
export function compactNumber(value: number | null, locale: Locale): string {
  if (value === null) return '—'
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}
