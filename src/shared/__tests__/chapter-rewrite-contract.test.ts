import { describe, expect, it } from 'vitest'
import { buildChapterRewriteBlock } from '../chapter-rewrite-contract'

describe('buildChapterRewriteBlock', () => {
  const base = { draftId: 17, version: 1, content: '定稿正文第一段。\n\n定稿正文第二段。' }

  it('embeds the finalized prose and author guidance verbatim in zh-CN', () => {
    const block = buildChapterRewriteBlock({
      language: 'zh-CN',
      chapterNumber: 3,
      base,
      guidance: '视角换成女主；结尾多埋一个伏笔。',
    })
    expect(block).toContain('【重写任务】第 3 章已有一版定稿')
    expect(block).toContain('【重写基准：本章定稿全文】')
    expect(block).toContain(base.content)
    expect(block).toContain('【作者的修改想法】')
    expect(block).toContain('视角换成女主；结尾多埋一个伏笔。')
    expect(block).not.toContain('作者没有额外要求')
  })

  it('uses the English wording and the no-notes fallback in en-US', () => {
    const block = buildChapterRewriteBlock({
      language: 'en-US',
      chapterNumber: 1,
      base: { ...base, content: 'Finalized prose.' },
      guidance: '  ',
    })
    expect(block).toContain('[Rewrite task] Chapter 1 already has a finalized version')
    expect(block).toContain('[Rewrite base: the finalized prose of this chapter]')
    expect(block).toContain('Finalized prose.')
    expect(block).toContain('[Author revision notes]')
    expect(block).toContain('(No extra notes from the author:')
  })
})
