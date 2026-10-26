import { describe, expect, it } from 'vitest'
import {
  buildEstablishedContinuityContext,
  establishedContinuityDirective,
  DEFAULT_CONTINUITY_BUDGET,
} from '../worldbuilding-continuity'

describe('buildEstablishedContinuityContext', () => {
  it('returns null when there is nothing established yet', () => {
    expect(buildEstablishedContinuityContext({
      finalizedChapters: [], arcs: [], synopsis: '', blueprints: [], currentWorldbuilding: '',
    }, 'zh-CN')).toBeNull()
  })

  it('includes finalized prose, arcs, synopsis spans, and blueprints', () => {
    const context = buildEstablishedContinuityContext({
      finalizedChapters: [{ chapterNumber: 1, title: '觉醒', content: '第一章正文内容。' }],
      arcs: [{ fromChapter: 1, toChapter: 8, title: '旧港钟声', beat: '起', summary: '主角在检测中归零。', status: 'confirmed' }],
      synopsis: '## 第1章：标定之外的零\n场景与出场人物\n第一章细纲正文。',
      blueprints: [{ chapterNumber: 1, role: '开篇', purpose: '建立危机', keyEvents: '检测归零' }],
      currentWorldbuilding: '刻度计量制……',
    }, 'zh-CN')
    expect(context).toBeTruthy()
    expect(context!).toContain('【已定稿正文')
    expect(context!).toContain('第一章正文内容。')
    expect(context!).toContain('【粗纲方向】')
    expect(context!).toContain('旧港钟声')
    expect(context!).toContain('【已写细纲（逐章）】')
    expect(context!).toContain('第1章：标定之外的零')
    expect(context!).toContain('【已生成蓝图要点】')
    expect(context!).toContain('建立危机')
    expect(context!).toContain('【现有世界观（修订基础')
    expect(context!).toContain('刻度计量制')
  })

  it('clips long chapters and the whole corpus within budget', () => {
    const longBody = '长'.repeat(5000)
    const context = buildEstablishedContinuityContext({
      finalizedChapters: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => ({ chapterNumber: n, content: longBody })),
      arcs: [], synopsis: '', blueprints: [], currentWorldbuilding: '',
    }, 'zh-CN', DEFAULT_CONTINUITY_BUDGET)
    expect(context!.length).toBeLessThan(40000)
    expect(context!).toContain('中段省略')
    expect(context!).toContain('章定稿正文因长度预算省略')
  })

  it('omits empty sections individually', () => {
    const context = buildEstablishedContinuityContext({
      finalizedChapters: [], arcs: [], synopsis: '', blueprints: [], currentWorldbuilding: '现有世界观',
    }, 'zh-CN')
    expect(context).toBeTruthy()
    expect(context!).not.toContain('【已定稿正文')
    expect(context!).toContain('【现有世界观（修订基础')
  })

  it('renders the English directive only when facts exist', () => {
    expect(establishedContinuityDirective(false, 'zh-CN')).toBe('')
    expect(establishedContinuityDirective(true, 'en-US')).toContain('[Revision mode')
    expect(establishedContinuityDirective(true, 'zh-CN')).toContain('【修订模式')
  })
})
