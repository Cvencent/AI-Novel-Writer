import { describe, expect, it } from 'vitest'
import {
  buildFinalizeSyncPrompt,
  extractFinalizeSyncPlan,
  extractOutlineEntry,
  normalizeFinalizeSyncOutlineEntry,
} from '../finalize-sync-contract'

describe('extractFinalizeSyncPlan', () => {
  it('parses a full plan and normalizes fields', () => {
    const plan = extractFinalizeSyncPlan(JSON.stringify({
      outlineEntry: '## 第2章：复核被拒\n场景与出场人物：林澈、陆秉文\n章节目标：递交申报',
      blueprint: { role: '阻力', purpose: '制度对撞', keyEvents: '三次申诉被驳', characters: ['林澈', '陆秉文'], suspenseHook: '腾退倒计时' },
      notes: ['正文里陆秉文先擦眼镜再说话，细纲顺序相反。'],
    }))
    expect(plan?.outlineEntry).toContain('第2章：复核被拒')
    expect(plan?.blueprint.role).toBe('阻力')
    expect(plan?.blueprint.characters).toEqual(['林澈', '陆秉文'])
    expect(plan?.notes).toHaveLength(1)
  })

  it('returns null without outlineEntry and keeps only provided blueprint fields', () => {
    expect(extractFinalizeSyncPlan('{"blueprint":{"role":"x"}}')).toBeNull()
    const plan = extractFinalizeSyncPlan('{"outlineEntry":"## 第1章：a\n正文","blueprint":{}}')
    expect(plan?.blueprint.role).toBeUndefined()
  })

  it('extracts a fenced JSON body', () => {
    const plan = extractFinalizeSyncPlan('```json\n{"outlineEntry":"## 第1章：a"}\n```')
    expect(plan?.outlineEntry).toContain('第1章')
  })
})

describe('outline helpers', () => {
  const synopsis = '## 第1章：零\n第一章细纲。\n\n## 第2章：复核\n第二章细纲。'
  it('extracts one chapter span', () => {
    expect(extractOutlineEntry(synopsis, 2)).toContain('第二章细纲。')
    expect(extractOutlineEntry(synopsis, 9)).toBeNull()
  })
  it('normalizes the entry heading with the db title', () => {
    expect(normalizeFinalizeSyncOutlineEntry('## 第2章：旧标题\n场景：x', 2, '新标题')).toBe('## 第2章：新标题\n场景：x')
  })
  it('prompt names the prose as authoritative', () => {
    expect(buildFinalizeSyncPrompt({
      chapterNumber: 2, finalizedContent: '正文', outlineEntry: '细纲',
      blueprint: { role: 'r', purpose: 'p', keyEvents: 'k', characters: [], suspenseHook: '', costsAndTurns: '', foreshadowing: '' },
      language: 'zh-CN',
    })).toContain('定稿正文是权威')
  })
})
