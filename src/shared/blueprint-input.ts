/**
 * 蓝图派生用的有界输入（WP2b）。
 *
 * 旧实现把「全部架构」拼进 Prompt——其中包含整本细纲，3000 章时必然爆输入预算。
 * 派生只需要：核心大纲 + 前提 + 角色 + 世界观 + 本批细纲 + 所属粗纲段。
 * 细纲按章切出来注入，不再整本塞进去。
 */
import type { WritingLanguage } from './writing-language'

/** 从整份细纲 Markdown 中切出 [from, to] 这一段（含端点）。 */
export function outlineBatchSliceForBlueprint(synopsis: string, from: number, to: number): string {
  const lines = synopsis.split(/\r?\n/u)
  const heading = /^##\s*第\s*(\d+)\s*章/u
  const blocks: { chapter: number; lines: string[] }[] = []
  let current: { chapter: number; lines: string[] } | null = null
  for (const line of lines) {
    const match = heading.exec(line)
    if (match) {
      current = { chapter: Number(match[1]), lines: [line] }
      blocks.push(current)
      continue
    }
    if (current) current.lines.push(line)
  }
  return blocks
    .filter(block => block.chapter >= from && block.chapter <= to)
    .map(block => block.lines.join(String.fromCharCode(10)).trim())
    .filter(Boolean)
    .join(String.fromCharCode(10) + String.fromCharCode(10))
}

/** 组装蓝图派生的有界输入。 */
export function blueprintBoundedInput(input: {
  coreOutline: string
  premise: string
  charactersArch: string
  worldbuilding: string
  batchOutline: string
  arcDirective: string
  language: WritingLanguage
}): string {
  const english = input.language === 'en-US'
  const none = english ? '(not provided)' : '（未填写）'
  const parts = english
    ? [
      '[Core outline (book-level direction, must follow)]' + String.fromCharCode(10) + (input.coreOutline || none),
      '[Premise]' + String.fromCharCode(10) + (input.premise || none),
      '[Character graph (author facts)]' + String.fromCharCode(10) + (input.charactersArch || none),
      '[Worldbuilding]' + String.fromCharCode(10) + (input.worldbuilding || none),
      input.arcDirective,
      '[This batch outline (derive blueprints from it; do not invent new plot)]' + String.fromCharCode(10) + (input.batchOutline || none),
    ]
    : [
      '【核心大纲（全书方向，必须遵守）】' + String.fromCharCode(10) + (input.coreOutline || none),
      '【故事前提】' + String.fromCharCode(10) + (input.premise || none),
      '【角色图谱（作者事实）】' + String.fromCharCode(10) + (input.charactersArch || none),
      '【世界观】' + String.fromCharCode(10) + (input.worldbuilding || none),
      input.arcDirective,
      '【本批细纲（据此派生蓝图，不要新增剧情）】' + String.fromCharCode(10) + (input.batchOutline || none),
    ]
  return parts.filter(Boolean).join(String.fromCharCode(10) + String.fromCharCode(10))
}
