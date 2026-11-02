import { describe, expect, it } from 'vitest'

import {
  FORESHADOWING_COMMITMENT_LIMIT,
  chapterRefsInForeshadowing,
  parseForeshadowingCommitments,
  foreshadowingDueAt,
  foreshadowingKeywords,
  renderForeshadowingDue,
} from '../foreshadowing-commitments'
import { findUndeliveredForeshadowing } from '../consistency-preflight'

describe('chapterRefsInForeshadowing', () => {
  it('reads the single-chapter forms from the report', () => {
    // 四条真实承诺里的三条（issue #68）。
    expect(chapterRefsInForeshadowing('埋下水隔边的新撬痕与全叔那句「这日子你碰不得」，留待第15章揭开。')).toEqual([15])
    expect(chapterRefsInForeshadowing('以及温珩藏下的父亲油纸包，为第19—22章父亲旧账的反转留扣。')).toEqual([19, 20, 21, 22])
    expect(chapterRefsInForeshadowing('待核栏底下那层更老的墨留待下章。')).toEqual([])
  })

  it('expands a chapter range and accepts chinese connectors', () => {
    expect(chapterRefsInForeshadowing('为第 19 至 21 章留扣')).toEqual([19, 20, 21])
    expect(chapterRefsInForeshadowing('第7-9章要回收')).toEqual([7, 8, 9])
  })

  it('treats a reversed range as ascending instead of losing the promise', () => {
    expect(chapterRefsInForeshadowing('第22—19章')).toEqual([19, 20, 21, 22])
  })

  it('reads the mixed 章/夜/晚 forms', () => {
    expect(chapterRefsInForeshadowing('与第22夜“把存根藏到搭档找不到的地方”接榫'))
      .toEqual([22])
  })

  it('does not explode a whole-book range into hundreds of chapters', () => {
    // 「第 1—100 章」不是伏笔承诺；展开它会把提示词淹掉。
    const refs = chapterRefsInForeshadowing('全书第1—100章的主题')
    expect(refs).toEqual([1, 100])
  })

  it('returns nothing for text without a chapter reference', () => {
    expect(chapterRefsInForeshadowing('埋下父亲旧账的线索。')).toEqual([])
    expect(chapterRefsInForeshadowing('')).toEqual([])
    expect(chapterRefsInForeshadowing(undefined as unknown as string)).toEqual([])
  })
})

describe('parseForeshadowingCommitments', () => {
  const blueprints = [
    { chapterNumber: 13, foreshadowing: '周叙把证据藏到搭档找不到的地方，与第22夜“把存根藏到搭档找不到、把头也搜不着的地方”接榫。' },
    { chapterNumber: 14, foreshadowing: '埋下水隔边的新撬痕与全叔那句「这日子你碰不得」，留待第15章揭开。' },
    { chapterNumber: 15, foreshadowing: '埋下：本章的水盂；为第19—22章父亲旧账的反转留扣。' },
    { chapterNumber: 16, foreshadowing: '埋下本章的新撬痕。' },
  ]

  it('keeps only forward-pointing promises', () => {
    const parsed = parseForeshadowingCommitments(blueprints)
    expect(parsed.map(item => item.plantsAt)).toEqual([13, 14, 15])
    // 第 16 章只提自己这一章，不算远期承诺。
    expect(parsed.some(item => item.plantsAt === 16)).toBe(false)
  })

  it('does not turn a self-reference into a promise to itself', () => {
    // 模型常在 foreshadowing 里写「本章埋下 X，留待第 20 章揭开」——章号指向未来的才算承诺。
    const parsed = parseForeshadowingCommitments([
      { chapterNumber: 7, foreshadowing: '本章（第7章）埋下印章的缺口，留待第20章揭开。' },
    ])
    expect(parsed).toEqual([{ plantsAt: 7, paysOffAt: [20], text: '本章（第7章）埋下印章的缺口，留待第20章揭开。' }])
  })

  it('flattens whitespace and caps the text length', () => {
    const parsed = parseForeshadowingCommitments([
      { chapterNumber: 3, foreshadowing: `  埋下\n\n  ${'很长的铺垫'.repeat(40)} 留待第9章  ` },
    ])
    expect(parsed[0]!.text.length).toBeLessThanOrEqual(121)
    expect(parsed[0]!.text).not.toContain('\n')
  })
})

describe('foreshadowingDueAt', () => {
  const commitments = parseForeshadowingCommitments([
    { chapterNumber: 13, foreshadowing: '与第22夜接榫。' },
    { chapterNumber: 14, foreshadowing: '留待第15章揭开。' },
    { chapterNumber: 15, foreshadowing: '为第19—22章留扣。' },
  ])

  it('returns the promises pointing at this chapter, oldest first', () => {
    const due = foreshadowingDueAt(commitments, 22)
    expect(due.map(item => item.plantsAt)).toEqual([13, 15])
  })

  it('returns only the promise that targets chapter 15', () => {
    expect(foreshadowingDueAt(commitments, 15).map(item => item.plantsAt)).toEqual([14])
  })

  it('returns nothing for a chapter nobody promised to', () => {
    expect(foreshadowingDueAt(commitments, 18)).toEqual([])
  })

  it('can exclude the recent chapters whose blueprints are already in context', () => {
    // 第 22 章时最近 3 章（19–21）已整段在上下文里；这两条承诺埋在第 13、15 章，都在窗口之外。
    expect(foreshadowingDueAt(commitments, 22, { alreadyInContextChapters: 3 }).map(item => item.plantsAt)).toEqual([13, 15])
    // 把窗口放大到第 12 章起都已可见时，埋设章落在窗口内的两条都不再重复出现——
    // 这正是「已可见的不再当承诺重复一遍」的意图。
    expect(foreshadowingDueAt(commitments, 22, { alreadyInContextChapters: 10 })).toEqual([])
  })

  it('caps the list so a late chapter cannot flood the prompt', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ chapterNumber: index + 1, foreshadowing: '留待第99章揭开。' }))
    expect(foreshadowingDueAt(parseForeshadowingCommitments(many), 99)).toHaveLength(FORESHADOWING_COMMITMENT_LIMIT)
  })
})

describe('foreshadowingKeywords', () => {
  it('extracts searchable fragments after dropping the chapter reference', () => {
    const keywords = foreshadowingKeywords('埋下水隔边的新撬痕与全叔那句「这日子你碰不得」，留待第15章揭开。')
    expect(keywords.some(word => word.includes('撬痕'))).toBe(true)
    expect(keywords.join(' ')).not.toContain('第15章')
  })

  it('is empty when nothing searchable remains', () => {
    expect(foreshadowingKeywords('留待第15章揭开。')).toEqual([])
  })
})

describe('renderForeshadowingDue', () => {
  const commitment = { plantsAt: 13, paysOffAt: [22], text: '与第22夜“把存根藏到搭档找不到的地方”接榫。' }

  it('renders the promise with its planting chapter', () => {
    const rendered = renderForeshadowingDue({ commitments: [commitment], targetChapter: 22, language: 'zh-CN' })
    expect(rendered).toContain('第 13 章埋下')
    expect(rendered).toContain('接榫')
  })

  it('says these are earlier intentions, not mandatory events', () => {
    // 关键：把远期承诺写成硬约束会让后期章节被十几章前的旧计划绑住。
    const rendered = renderForeshadowingDue({ commitments: [commitment], targetChapter: 22, language: 'zh-CN' })
    expect(rendered).toContain('不是本章的强制事件')
    const english = renderForeshadowingDue({ commitments: [commitment], targetChapter: 22, language: 'en-US' })
    expect(english).toContain('not mandatory events')
  })

  it('returns an empty string when there is nothing due', () => {
    expect(renderForeshadowingDue({ commitments: [], targetChapter: 5, language: 'zh-CN' })).toBe('')
  })
})

describe('findUndeliveredForeshadowing (issue #68)', () => {
  const promise = [{ plantsAt: 14, paysOffAt: [15], text: '埋下水隔边的新撬痕，留待第15章揭开。' }]

  it('reports a promise the chapter never touches', () => {
    const findings = findUndeliveredForeshadowing({
      chapterNumber: 15, content: '周叙把担保书叠好，按了手印。', commitments: promise,
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      stableFactKey: 'foreshadowing:undelivered:14:15',
      sourceChapter: 15,
      severity: 'warning',
    })
    expect(findings[0]!.evidence).toContain('撬痕')
  })

  it('stays silent once the chapter mentions the anchor', () => {
    expect(findUndeliveredForeshadowing({
      chapterNumber: 15, content: '舱底水隔边的新撬痕还在。', commitments: promise,
    })).toEqual([])
  })

  it('does not judge a promise with no searchable anchor', () => {
    expect(findUndeliveredForeshadowing({
      chapterNumber: 15, content: '正文。', commitments: [{ plantsAt: 14, paysOffAt: [15], text: '留待第15章揭开。' }],
    })).toEqual([])
  })

  it('does nothing for an empty chapter', () => {
    expect(findUndeliveredForeshadowing({ chapterNumber: 15, content: '  ', commitments: promise })).toEqual([])
  })
})
