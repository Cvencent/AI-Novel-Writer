import { describe, expect, it } from 'vitest'

import {
  findDuplicateChapterTitleFindings,
  findDuplicateChapterTitles,
  normalizeTitleForUniqueness,
} from '../chapter-title-uniqueness'

const bp = (chapterNumber: number, title: string) => ({ chapterNumber, title })

// issue #110：章节标题「同题加尾」复用——「压印」/「压印的」（第 15、21 章）、
// 「无人认领」/「无人认领，一并化浆」（第 18、22 章）。#16 的唯一性校验只查精确同名，
// 所以两对都放行；而读者在目录里读到的是同一章写了两遍。
describe('normalizeTitleForUniqueness (issue #110)', () => {
  it('strips trailing punctuation and whitespace but keeps inner punctuation', () => {
    expect(normalizeTitleForUniqueness(' 无人认领， ')).toBe('无人认领')
    expect(normalizeTitleForUniqueness('压印。')).toBe('压印')
    // 句中的逗号是内容：「无人认领，一并化浆」与「无人认领」的区别正是那个分句。
    expect(normalizeTitleForUniqueness('无人认领，一并化浆')).toBe('无人认领，一并化浆')
  })

  it('is empty-safe', () => {
    expect(normalizeTitleForUniqueness('')).toBe('')
    expect(normalizeTitleForUniqueness(null)).toBe('')
    expect(normalizeTitleForUniqueness('   ')).toBe('')
  })
})

describe('findDuplicateChapterTitles (issue #110)', () => {
  it('catches both reported pairs — the same title with a tail glued on', () => {
    const hits = findDuplicateChapterTitles([
      bp(15, '压印'), bp(18, '无人认领'), bp(21, '压印的'), bp(22, '无人认领，一并化浆'),
    ])
    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({ title: '压印', chapters: [15, 21] })
    expect(hits[1]).toMatchObject({ title: '无人认领', chapters: [18, 22] })
  })

  it('catches an exact duplicate (the #16 case) through the same route', () => {
    expect(findDuplicateChapterTitles([bp(5, '待核'), bp(9, '待核')]))
      .toEqual([{ title: '待核', chapters: [5, 9] }])
  })

  it('does not fire on titles that merely share a lead-in', () => {
    // 真实语料里的对照：这两对共享 3 字前缀，但谁也不包含谁。
    expect(findDuplicateChapterTitles([bp(7, '空着的那一格'), bp(8, '空着的第二格')])).toEqual([])
    expect(findDuplicateChapterTitles([bp(9, '末页之名'), bp(10, '末页那一格')])).toEqual([])
    expect(findDuplicateChapterTitles([bp(1, '雨夜来信1'), bp(2, '雨夜来信2')])).toEqual([])
  })

  it('requires both sides to reach the minimum length — single characters must not swallow', () => {
    // 「印」是「压印」的前缀，但单字标题会互相吞（本仓 #87 的教训：宁漏不误报）。
    expect(findDuplicateChapterTitles([bp(1, '印'), bp(2, '压印')])).toEqual([])
  })

  it('treats a trailing-punctuation-only difference as the same title', () => {
    expect(findDuplicateChapterTitles([bp(1, '无人认领'), bp(2, '无人认领，')]))
      .toEqual([{ title: '无人认领', chapters: [1, 2] }])
  })

  it('groups three-plus chapters under one title', () => {
    const hits = findDuplicateChapterTitles([bp(3, '归册'), bp(7, '归册的'), bp(9, '归册，入池')])
    expect(hits).toHaveLength(1)
    expect(hits[0]!.chapters).toEqual([3, 7, 9])
  })

  it('keeps the shortest form as the group representative', () => {
    expect(findDuplicateChapterTitles([bp(1, '压印的'), bp(2, '压印')])[0]!.title).toBe('压印')
  })

  it('ignores blank titles and needs at least two usable chapters', () => {
    expect(findDuplicateChapterTitles([bp(1, '压印')])).toEqual([])
    expect(findDuplicateChapterTitles([bp(1, ''), bp(2, '   ')])).toEqual([])
  })
})

describe('findDuplicateChapterTitleFindings (issue #110 finding shape)', () => {
  const chapters = [bp(15, '压印'), bp(18, '无人认领'), bp(21, '压印的'), bp(22, '无人认领，一并化浆')]

  it('names the chapters and their original titles, and stays a warning', () => {
    const findings = findDuplicateChapterTitleFindings({ chapters })
    expect(findings).toHaveLength(2)
    const first = findings.find(finding => finding.stableFactKey.includes('压印'))!
    expect(first.stableFactKey).toBe('chapter-title:duplicate:压印')
    expect(first.severity).toBe('warning')
    // sourceChapter 指向**首次使用该标题的章**（旧账，不是正在写的那一章——#79/#108）。
    expect(first.sourceChapter).toBe(15)
    expect(first.evidence).toContain('第15章「压印」')
    expect(first.evidence).toContain('第21章「压印的」')
  })

  it('hands over an actionable exit (give one title its own identity)', () => {
    const finding = findDuplicateChapterTitleFindings({ chapters })[0]!
    expect(finding.suggestion.zhCN).toContain('有区分度')
    expect(finding.suggestion.zhCN).toContain('而不是在原标题后面加')
    expect(finding.suggestion.enUS).toContain('its own identity')
  })

  it('keeps the key stable as the book advances — an ack must stick (issues #86/#89/#98/#108)', () => {
    const before = findDuplicateChapterTitleFindings({ chapters })[0]!
    const after = findDuplicateChapterTitleFindings({ chapters: [...chapters, bp(30, '另一件事')] })[0]!
    expect(after.stableFactKey).toBe(before.stableFactKey)
    expect(before.stableFactKey).not.toContain(':15')
  })

  it('says nothing when every title is distinct', () => {
    expect(findDuplicateChapterTitleFindings({
      chapters: [bp(1, '多出的一格'), bp(2, '缺角存根'), bp(3, '撕口对得上')],
    })).toEqual([])
  })
})
