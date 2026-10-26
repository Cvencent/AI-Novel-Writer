import { plotOutlineChapterSpans } from './plot-outline-contract'

/** 定稿正文 → 细纲/蓝图 校正契约：AI 返回 JSON，渲染层归一化后直接写库。 */
export interface FinalizeSyncBlueprintPatch {
  chapterNumber: number
  role?: string
  purpose?: string
  keyEvents?: string
  characters?: string[]
  suspenseHook?: string
  costsAndTurns?: string
  foreshadowing?: string
}

export interface FinalizeSyncPlan {
  /** 该章完整替换条目（含 "## 第N章：标题" 标题行与全部必备小节）。 */
  outlineEntry: string
  blueprint: FinalizeSyncBlueprintPatch
  /** 模型说明的「正文与细纲/蓝图的具体差异」。 */
  notes: string[]
}

const BLUEPRINT_FIELDS = ['role', 'purpose', 'keyEvents', 'characters', 'suspenseHook', 'costsAndTurns', 'foreshadowing'] as const

export function buildFinalizeSyncPrompt(input: {
  chapterNumber: number
  finalizedContent: string
  outlineEntry: string
  blueprint: { role: string; purpose: string; keyEvents: string; characters: readonly string[]; suspenseHook: string; costsAndTurns: string; foreshadowing: string }
  language: 'zh-CN' | 'en-US'
}): string {
  const en = input.language === 'en-US'
  const blueprintText = [
    `role: ${input.blueprint.role}`,
    `purpose: ${input.blueprint.purpose}`,
    `keyEvents: ${input.blueprint.keyEvents}`,
    `characters: ${input.blueprint.characters.join(', ')}`,
    `suspenseHook: ${input.blueprint.suspenseHook}`,
    `costsAndTurns: ${input.blueprint.costsAndTurns}`,
    `foreshadowing: ${input.blueprint.foreshadowing}`,
  ].join('\n')
  return [
    en
      ? `The finalized prose of chapter ${input.chapterNumber} has drifted from its chapter outline and blueprint. Compare them and output corrections that make the outline and blueprint match the prose.`
      : `第 ${input.chapterNumber} 章的定稿正文与该章细纲、蓝图存在偏差。请对比三者，输出让细纲与蓝图与定稿正文一致的修正。`,
    en
      ? 'Rules: the finalized prose is authoritative. Only report a difference when it is real and material; keep everything that already matches. outlineEntry must be the complete replacement for the chapter entry including its "## Chapter N: title" heading and every required section, written as plain "Section: content" lines without # sub-headings. blueprint fields follow the same field names; characters is a string array. Output JSON only: {"outlineEntry": "...", "blueprint": {...}, "notes": ["..."]}.'
      : '规则：定稿正文是权威。只有真实且实质的偏差才修；已经一致的内容原样保留。outlineEntry 必须是该章条目的完整替换文本，包含 "## 第N章：标题" 标题行与全部必备小节，小节写成"小节名：内容"的普通行，不要用 # 小标题。blueprint 字段沿用同名字段；characters 是字符串数组。只输出 JSON：{"outlineEntry": "...", "blueprint": {...}, "notes": ["..."]}。',
    en ? '[Finalized prose]' : '【定稿正文】',
    input.finalizedContent,
    en ? '[Current chapter outline entry]' : '【当前细纲条目】',
    input.outlineEntry,
    en ? '[Current blueprint]' : '【当前蓝图】',
    blueprintText,
  ].join('\n\n')
}

export function extractFinalizeSyncPlan(raw: string): FinalizeSyncPlan | null {
  const text = raw.trim().replace(/^`json`?/iu, '').replace(/``?/gu, '')
  let payload: unknown = null
  try { payload = JSON.parse(text) } catch { void 0 }
  if (payload === null) {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) { try { payload = JSON.parse(text.slice(start, end + 1)) } catch { void 0 } }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  const outlineEntry = typeof record.outlineEntry === 'string' ? record.outlineEntry.trim() : ''
  if (!outlineEntry) return null
  const blueprintSource = record.blueprint && typeof record.blueprint === 'object' && !Array.isArray(record.blueprint)
    ? record.blueprint as Record<string, unknown> : {}
  const blueprint: FinalizeSyncBlueprintPatch = { chapterNumber: 0 }
  for (const key of BLUEPRINT_FIELDS) {
    const value = blueprintSource[key]
    if (key === 'characters') {
      if (Array.isArray(value)) blueprint.characters = value.map(item => String(item).trim()).filter(Boolean)
      continue
    }
    if (typeof value === 'string' && value.trim()) blueprint[key] = value.trim()
  }
  const notes = Array.isArray(record.notes) ? record.notes.map(item => String(item).trim()).filter(Boolean) : []
  return { outlineEntry, blueprint, notes }
}

/** 用当前细纲正文找到某章条目原文。 */
export function extractOutlineEntry(synopsis: string, chapterNumber: number): string | null {
  const span = plotOutlineChapterSpans(synopsis).find(entry => entry.chapter === chapterNumber)
  return span ? synopsis.slice(span.index, span.end).trim() : null
}

/** 细纲条目标题行规范（应用前归一化，避免模型写出二级结构破坏 span 解析）。 */
export function normalizeFinalizeSyncOutlineEntry(entry: string, chapterNumber: number, title: string): string {
  const body = entry.replace(/^##\s*第\s*\d+\s*章[^\n]*\n?/u, '').trim()
  return `## 第${chapterNumber}章：${title}\n${body}`
}
