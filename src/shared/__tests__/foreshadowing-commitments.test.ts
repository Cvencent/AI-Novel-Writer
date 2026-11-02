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

describe('foreshadowingKeywords handles every quote style (issue #70)', () => {
  // 报告里的原句：18 章用弯引号，2 章用 ASCII 撇号，3 章用直角引号。
  const curved = '埋下存根背面的靛蓝旧字“只剩最后一次溯读机会”与温珩短褂同源'
  // 用 charCode 拼 ASCII 撇号，避免在单引号字符串里和转义打架。
  const apostrophe = String.fromCharCode(39)
  const ascii = `埋下水隔边的新撬痕与全叔那句${apostrophe}这日子你碰不得${apostrophe}，留待第15章揭开。`
  const corner = '埋下存根背面的靛蓝旧字「只剩最后一次溯读机会」与温珩短褂同源'
  const straight = '埋下存根背面的靛蓝旧字"只剩最后一次溯读机会"与温珩短褂同源'

  it('strips typographic curved quotes instead of gluing them into a keyword', () => {
    // 旧实现把 U+201C/U+201D 漏在字符类外，整段（含引号）成了一个永远命不中的检索词。
    const keywords = foreshadowingKeywords(curved)
    expect(keywords.length).toBeGreaterThan(0)
    expect(keywords.every(word => !/[“”]/u.test(word))).toBe(true)
    expect(keywords.join(' ')).toContain('靛蓝旧字')
  })

  it('treats curved, corner and straight quotes the same way', () => {
    expect(foreshadowingKeywords(curved)).toEqual(foreshadowingKeywords(corner))
    expect(foreshadowingKeywords(curved)).toEqual(foreshadowingKeywords(straight))
  })

  it('strips ascii apostrophes and never returns a fragment with one', () => {
    const keywords = foreshadowingKeywords(ascii)
    expect(keywords.every(word => !word.includes("'"))).toBe(true)
    // 「原本不属于温珩'与」这种带撇号又带连接词的碎片必须被丢掉。
    expect(keywords.every(word => !/[‘’]/u.test(word))).toBe(true)
  })

  it('drops fragments that still carry a quote after the bulk strip', () => {
    // 未成对/嵌套引号无法整段剥掉时，残留片段必须被丢弃，而不是拿去比对。
    const keywords = foreshadowingKeywords('埋下靛蓝旧字”与温珩短褂同源')
    expect(keywords.every(word => !/[“”]/u.test(word))).toBe(true)
  })

  it('does not keep fragments that merely start or end with a connector', () => {
    const keywords = foreshadowingKeywords('埋下与存根背面与、短褂浮字')
    expect(keywords).toContain('短褂浮字')
    expect(keywords.every(word => !/^与|与$/u.test(word))).toBe(true)
  })

  it('the reported bp13 promise no longer yields quoted keywords', () => {
    const bp13 = '回收第11章“只剩最后一次溯读机会”、第7章“空额”与第10章“徐哥”的伏笔；埋下：存根背面靛蓝旧字与温珩短褂同源，指向隐藏主线；周叙把证据藏到搭档找不到的地方，与第22夜“把存根藏到搭档找不到、把头也搜不着的地方”接榫。'
    const keywords = foreshadowingKeywords(bp13)
    expect(keywords.every(word => !/[“”]/u.test(word))).toBe(true)
    // 旧实现抽出的三个词全带引号；现在必须至少有一个能在正常正文里出现的实体词。
    expect(keywords.length).toBeGreaterThan(0)
  })
})

describe('findUndeliveredForeshadowing clears once the prose names the thing (issue #70)', () => {
  const curvedPromise = [{ plantsAt: 13, paysOffAt: [22], text: '埋下存根背面的靛蓝旧字“只剩最后一次溯读机会”与温珩短褂同源' }]

  it('stops reporting when the finalized prose writes the matter out in plain words', () => {
    // 作者按语义补写（不带引号）必须能消掉提示——旧实现里唯一能消掉的办法是连引号一起抄。
    expect(findUndeliveredForeshadowing({
      chapterNumber: 22,
      // 正文按语义把这件事写出来（不含引号）：检索词是「存根背面的靛蓝旧字」，
      // 正文里出现即可，不需要连原话抄一遍。
      content: '周叙翻过存根。存根背面的靛蓝旧字还在，他只剩最后一次溯读机会。',
      commitments: curvedPromise,
    })).toEqual([])
  })

  it('still reports when the chapter never touches it', () => {
    expect(findUndeliveredForeshadowing({
      chapterNumber: 22,
      content: '柯明远把笔帽拧上，按了补人；不按，船停。',
      commitments: curvedPromise,
    })).toHaveLength(1)
  })
})

describe('quote handling cannot silently regress (issue #70)', () => {
  const sources = [
    '埋下存根背面的靛蓝旧字“只剩最后一次溯读机会”与温珩短褂同源',
    '埋下存根背面的靛蓝旧字「只剩最后一次溯读机会」与温珩短褂同源',
    '埋下存根背面的靛蓝旧字『只剩最后一次溯读机会』与温珩短褂同源',
    '埋下存根背面的靛蓝旧字"只剩最后一次溯读机会"与温珩短褂同源',
  ]

  it('never returns a keyword containing any quote character', () => {
    // 这是 issue #70 的本质：任何一个引号类字符漏在剥壳之外，都会造出
    // 「自带引号、正文永远命不中」的检索词（提示永久假阳性且作者消不掉）。
    const codePoints = [0x22, 0x27, 0x2018, 0x2019, 0x201c, 0x201d, 0x300c, 0x300d, 0x300e, 0x300f]
    const quoteChars = codePoints.map(code => String.fromCodePoint(code))
    for (const source of sources) {
      for (const keyword of foreshadowingKeywords(source)) {
        for (const quote of quoteChars) {
          expect(keyword).not.toContain(quote)
        }
      }
    }
  })

  it('yields the same plain keywords for all four quoting styles', () => {
    const base = foreshadowingKeywords(sources[0])
    expect(base.length).toBeGreaterThan(0)
    for (const source of sources.slice(1)) {
      expect(foreshadowingKeywords(source)).toEqual(base)
    }
  })
})
