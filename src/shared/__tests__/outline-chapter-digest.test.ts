import { describe, expect, it } from 'vitest'
import { extractChapterDigest, splitChapterBlock } from '../outline-chapter-digest'

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
