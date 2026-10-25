import { describe, expect, it } from 'vitest'
import { parseOutlineNavigation } from '../outline-navigation'
import { removeOutlineChapters } from '../outline-bulk-delete'

const synopsis = [
  '# 细纲',
  '',
  '## 第1章：入学',
  '正文一。',
  '',
  '## 第2章：试探',
  '正文二。',
  '',
  '## 第3章：交锋',
  '正文三。',
].join(String.fromCharCode(10))

describe('bulk delete of outline chapters', () => {
  it('removes every selected chapter block and keeps the rest', () => {
    const items = parseOutlineNavigation(synopsis)
    const next = removeOutlineChapters(synopsis, new Set([items[0]!.heading]))
    expect(next).not.toContain('第1章')
    expect(next).toContain('第2章：试探')
    expect(next).toContain('第3章：交锋')
  })

  it('removes all chapters when everything is selected', () => {
    const items = parseOutlineNavigation(synopsis)
    const next = removeOutlineChapters(synopsis, new Set(items.map(i => i.heading)))
    expect(next).not.toContain('第1章')
    expect(next).not.toContain('第2章')
    expect(next).not.toContain('第3章')
  })

  it('returns the input unchanged when nothing matches', () => {
    const next = removeOutlineChapters(synopsis, new Set(['## 第99章：不存在']))
    expect(next).toBe(synopsis)
  })

  it('treats a heading match as exact-prefix, not substring', () => {
    const next = removeOutlineChapters(synopsis, new Set(['## 第1章：入学（旧）']))
    expect(next).toBe(synopsis)
  })
})
