import { describe, expect, it } from 'vitest'
import { extractChapterDigest, outlineRecentEvent, splitChapterBlock } from '../outline-chapter-digest'

const block = `## 第12章：旧仓库
主角在旧仓库找到账册，于是确认了失踪者的行动路线。
他因此失去了最后一次见面的机会。
对手发现账册后决定连夜转移。`

describe('splitChapterBlock', () => {
  it('解析章号、标题与正文', () => {
    expect(splitChapterBlock(block)).toMatchObject({ chapterNumber: 12, title: '旧仓库' })
    expect(splitChapterBlock(block).body).toContain('账册')
  })

  it('无标题时章号为 null', () => {
    expect(splitChapterBlock('只是正文').chapterNumber).toBeNull()
  })
})

describe('extractChapterDigest', () => {
  it('摘要取前 4 句', () => {
    const digest = extractChapterDigest(block, [])
    expect(digest.chapterNotes).toContain('旧仓库找到账册')
    expect(digest.chapterNotes).toContain('失去了最后一次见面的机会')
  })

  it('只保留出现过的已知人名', () => {
    const digest = extractChapterDigest(block, ['主角', '对手', '未出场的人'])
    expect(digest.characterNames).toEqual(['主角', '对手'])
  })

  it('抽取含因果结果词的连续性事实', () => {
    const digest = extractChapterDigest(block, [])
    expect(digest.continuityFacts.length).toBeGreaterThan(0)
    expect(digest.continuityFacts.join(' ')).toContain('于是')
  })

  it('正文为空时返回空字段而不抛错', () => {
    expect(extractChapterDigest('## 第1章：空', [])).toEqual({ chapterNotes: '', characterNames: [], continuityFacts: [] })
  })
})

describe('outlineRecentEvent', () => {
  it('只取首个句末，避免把整章摘要写进最近事件', () => {
    expect(outlineRecentEvent('**场景与出场人物**：大厅。**本章目标**：查验台账。'))
      .toBe('**场景与出场人物**：大厅。')
  })

  it('超长时截断并加省略号', () => {
    const long = `${'甲'.repeat(80)}。`
    const result = outlineRecentEvent(long, 50)
    expect(result.endsWith('…')).toBe(true)
    expect(result.length).toBeLessThanOrEqual(50)
  })

  it('空摘要返回空字符串', () => {
    expect(outlineRecentEvent('   ')).toBe('')
  })
})
