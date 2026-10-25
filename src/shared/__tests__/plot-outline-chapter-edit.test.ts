import { describe, expect, it } from 'vitest'
import {
  plotOutlineChapterSpans,
  plotOutlineChapterText,
  replacePlotOutlineChapter,
} from '../plot-outline-contract'

const synopsis = [
  '# 细纲',
  '',
  '## 第1章：入学',
  '场景与出场人物：主角在校门口。',
  '本章目标：进入校园。',
  '阻力与升级：门禁阻拦。',
  '转折与代价：暴露身份。',
  '结尾钩子：有人认出他。',
  '伏笔：零号档案。',
  '',
  '## 第2章：试探',
  '场景与出场人物：主角与对手。',
  '本章目标：试探。',
  '阻力与升级：对手警觉。',
  '转折与代价：失去线索。',
  '结尾钩子：被跟踪。',
  '伏笔：钥匙。',
  '',
  '> 本大纲已覆盖至第 2 章（全书 2 章），其余章节将在后续批次继续生成。',
].join(String.fromCharCode(10))

describe('plot outline chapter spans', () => {
  it('finds each chapter span in order', () => {
    const spans = plotOutlineChapterSpans(synopsis)
    expect(spans.map(span => span.chapter)).toEqual([1, 2])
    expect(spans[0]!.index).toBeLessThan(spans[1]!.index)
    expect(synopsis.slice(spans[0]!.index, spans[0]!.end)).toContain('## 第1章：入学')
  })

  it('reads a single chapter text', () => {
    const chapter = plotOutlineChapterText(synopsis, 2)
    expect(chapter).toContain('## 第2章：试探')
    expect(chapter).not.toContain('## 第1章')
    expect(plotOutlineChapterText(synopsis, 99)).toBeNull()
  })

  it('replaces exactly one chapter and preserves the rest', () => {
    const next = '## 第1章：入学（改）' + String.fromCharCode(10)
      + '场景与出场人物：改后。' + String.fromCharCode(10)
      + '本章目标：改后。' + String.fromCharCode(10)
      + '阻力与升级：改后。' + String.fromCharCode(10)
      + '转折与代价：改后。' + String.fromCharCode(10)
      + '结尾钩子：改后。' + String.fromCharCode(10)
      + '伏笔：改后。'
    const updated = replacePlotOutlineChapter(synopsis, 1, next)
    expect(updated).toContain('## 第1章：入学（改）')
    expect(updated).toContain('## 第2章：试探')
    expect(updated).toContain('场景与出场人物：主角与对手')
    expect(updated).toContain('# 细纲')
  })

  it('refuses a replacement that breaks the per-chapter structure', () => {
    expect(() => replacePlotOutlineChapter(synopsis, 1, '随便一段话')).toThrow('PLOT_OUTLINE_REPLACEMENT_INVALID')
    expect(() => replacePlotOutlineChapter(synopsis, 99, '## 第99章：x')).toThrow('PLOT_OUTLINE_CHAPTER_NOT_FOUND')
  })
})

describe('outline prompt character naming', () => {
  it('requires every speaking character to carry a personal name', async () => {
    const { plotOutlineRequestContract } = await import('../plot-outline-contract')
    const progress = {
        protocol: 'chapter-outline-v3',
        range: { from: 1, to: 1 },
        content: { maxAttemptsPerChapter: 2 },
        targetUnits: 300,
        cursor: { kind: 'request', chapterNumber: 1, attempt: 'normal' },
        sourceExpected: {
          synopsis: '', premise: '', charactersArch: '', worldbuilding: '', genre: '', totalChapters: 10,
          wordsPerChapter: 3000, writingLanguage: 'zh-CN', plotStructure: '', narrativePov: '', globalGuidance: '',
        },
        confirmedPrefix: '',
        composition: null,
    } as never
    const prompt = plotOutlineRequestContract(progress as never, 1, 'normal')
    expect(prompt).toContain('人物命名规则')
    expect(prompt).toContain('身份·姓名')
    expect(prompt).toContain('create_character')
  })
})
