import type { ProjectSessionContext } from '../shared/ipc-channels'
import { parseResourceUri, resourceWriteAllowed } from '../shared/project-paths'
import { ipc } from './ipc-client'
export { parseResourceUri, formatResourceUri, canonicalResourceUri, isResourceUri, resourceWriteAllowed } from '../shared/project-paths'

export const CORE_FIELD_MAP: Record<string, string> = { premise: 'premise', worldbuilding: 'worldbuilding', characters: 'charactersArch', synopsis: 'synopsis' }

/** 粗纲是多段台账而不是单一正文字段，只能查看，不能像其它节那样整篇覆盖保存。 */
export const ARC_RESOURCE_KEY = 'arc'
export function parseCoreField(value: string): string | null {
  const resource = parseResourceUri(value)
  return resource?.kind === 'core' ? CORE_FIELD_MAP[resource.key]! : null
}
export async function readCoreContent(value: string, session: ProjectSessionContext): Promise<string> {
  const resource = parseResourceUri(value)
  if (resource?.kind !== 'core') throw new Error('INVALID_RESOURCE_URI')
  if (resource.key === ARC_RESOURCE_KEY) {
    const arcs = await ipc.invokeWithProjectSession(session, 'db:arc-outline-list', session.projectPath)
    return renderArcOutlineMarkdown(Array.isArray(arcs) ? arcs : [])
  }
  if (resource.key === 'characters') {
    const roster = await ipc.invokeWithProjectSession(session, 'db:character-roster-read', session.projectPath)
    return roster.status === 'ready' ? roster.renderedMarkdown : roster.legacyMarkdown ?? ''
  }
  const core = await ipc.invokeWithProjectSession(session, 'db:project-core-get', session.projectPath)
  if (!core) throw new Error('无法读取故事架构内容')
  return core[resource.key] || ''
}
/** 把粗纲段渲染成可读 Markdown，只在标签里查看。 */
export function renderArcOutlineMarkdown(arcs: readonly { arcIndex: number; fromChapter: number; toChapter: number; title: string; beat: string; summary: string; status: string }[]): string {
  if (arcs.length === 0) return ''
  return arcs.map(arc => [
    `## 第 ${arc.fromChapter}–${arc.toChapter} 章：${arc.title}`,
    `beat: ${arc.beat} · 状态: ${arc.status}`,
    '',
    arc.summary,
  ].join('\n')).join('\n\n')
}

export async function writeCoreContent(value: string, content: string, session: ProjectSessionContext): Promise<boolean> {
  const resource = parseResourceUri(value)
  if (resource?.kind !== 'core' || !resourceWriteAllowed(value)) return false
  // 粗纲按段保存在 arc_outlines 里，整篇覆盖写入会丢掉分段结构，因此拒绝。
  if (resource.key === ARC_RESOURCE_KEY) return false
  const result = await ipc.invokeWithProjectSession(session, 'db:project-core-update', { [CORE_FIELD_MAP[resource.key]!]: content }, session.projectPath)
  return result.success === true
}
export async function readResourceContent(value: string, session: ProjectSessionContext): Promise<string> {
  const resource = parseResourceUri(value)
  if (!resource) throw new Error('INVALID_RESOURCE_URI')
  if (resource.kind === 'core') return readCoreContent(value, session)
  if (!('id' in resource)) throw new Error('RESOURCE_REQUIRES_DOMAIN_RESOLVER')
  const full = resource.kind === 'draft' || resource.kind === 'manuscript'
    ? await ipc.invokeWithProjectSession(session, 'db:draft-get-full', resource.id, session.projectPath)
    : resource.kind === 'revision' ? await ipc.invokeWithProjectSession(session, 'db:revision-get-full', resource.id, session.projectPath)
      : await ipc.invokeWithProjectSession(session, 'db:review-get-full', resource.id, session.projectPath)
  if (!full) throw new Error('虚拟资源不存在或无法读取')
  return full.content
}
