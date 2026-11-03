import { describe, expect, it } from 'vitest'

import {
  TITLE_CONVERGENCE_MIN_HITS,
  TITLE_CONVERGENCE_WINDOW,
  findTitleShapeConvergence,
  findTitleShapeConvergenceFindings,
  titleShapeOf,
} from '../title-shape'

const bp = (chapterNumber: number, title: string) => ({ chapterNumber, title })

// issue #106：那本 49 章的悬疑长篇，标题后半程收敛成「【物件】＋方位＋的＋【线索】」——
// ch1–10 2/10、ch11–20 2/10、ch21–30 2/10、ch31–40 4/10、**ch41–50 8/9**。
// 标题层此前只有「不得重名」（字面相等），而正文已建五层位置轴（#71/#28#65#66/#81/#94/#95）——
// 标题层是第六层，完全空白。
describe('titleShapeOf (issue #106)', () => {
  it('recognizes the frame from the reported chapters', () => {
    for (const title of [
      '墨盒底下的旧票根', '短褂夹层里的木片', '库门前的稽核令', '报告上的空白',
      '口供上的指印', '客源单上的空船位', '补底根之前', '铜墨盒旁的湿痕',
      '名单上的半页', '底板下的最后一册', '册子里的空号段',
    ]) {
      expect(titleShapeOf(title), title).toBe('locative')
    }
  })

  it('treats 「X 上的 Y」「X 里的 Y」「X 之前的 Y」 as one skeleton, not three', () => {
    // issue 的要求：「算同一骨架，换名词不算换结构」。
    expect(new Set([
      titleShapeOf('口供上的指印'), titleShapeOf('册子里的空号段'), titleShapeOf('补底根之前'),
    ])).toEqual(new Set(['locative']))
  })

  it('does not call a plain 「X 的 Y」 a locative frame', () => {
    expect(titleShapeOf('对不上的姓氏')).toBe('other')
    expect(titleShapeOf('半个字连成的名字')).toBe('other')
    expect(titleShapeOf('父亲的名字')).toBe('other')
  })

  it('rejects a locative-looking word that is actually a function word or ordinal', () => {
    // 前一字是虚词/否定/序数时不是方位结构（封闭的语法类，不是内容词表）。
    for (const title of ['最后的一页', '无底的船', '其后的路', '第一页的表']) {
      expect(titleShapeOf(title), title).toBe('other')
    }
  })

  it('does not fire on a single-character locative that closes an ordinary phrase', () => {
    // ⚠️ 误报源：单字方位收尾太容易撞上普通动宾短语（「湿票不入底」）。只有多字方位收尾才算。
    for (const title of ['湿票不入底', '中堂大人', '内河航道', '到底怎样']) {
      expect(titleShapeOf(title), title).toBe('other')
    }
  })

  it('handles empty and blank titles without throwing', () => {
    expect(titleShapeOf('')).toBe('other')
    expect(titleShapeOf('   ')).toBe('other')
  })
})

describe('findTitleShapeConvergence (issue #106)', () => {
  it('reports the reported tail — the frame takes most of a consecutive window', () => {
    const chapters = [
      bp(41, '口供上的指印'), bp(42, '客源单上的空船位'), bp(43, '补底根之前'),
      bp(44, '铜墨盒旁的湿痕'), bp(45, '名单上的半页'), bp(46, '对不上的姓氏'),
    ]
    const convergence = findTitleShapeConvergence(chapters)
    expect(convergence).not.toBeNull()
    expect(convergence!.window).toBe(TITLE_CONVERGENCE_WINDOW)
    expect(convergence!.hits).toEqual([41, 42, 43, 44, 45])
  })

  it('stays silent on a book whose titles rotate', () => {
    // 0202 的真实形态：24 章里只有 1 章落在这一族。
    const chapters = [
      bp(1, '多出的一格'), bp(2, '缺角存根'), bp(3, '撕口对得上'), bp(4, '自己的心跳'),
      bp(5, '掌心的两个字'), bp(6, '最后一页末位'),
    ]
    expect(findTitleShapeConvergence(chapters)).toBeNull()
  })

  it('requires a consecutive window — a gap breaks the run', () => {
    const chapters = [
      bp(41, '口供上的指印'), bp(42, '客源单上的空船位'), bp(44, '铜墨盒旁的湿痕'),
      bp(45, '名单上的半页'), bp(46, '底板下的最后一册'), bp(47, '册子里的空号段'),
    ]
    expect(findTitleShapeConvergence(chapters)).toBeNull()
  })

  it('requires the full window before judging', () => {
    expect(findTitleShapeConvergence([
      bp(1, '口供上的指印'), bp(2, '名单上的半页'), bp(3, '册子里的空号段'),
    ])).toBeNull()
  })

  it('needs enough hits inside the window, not just a few', () => {
    const chapters = [
      bp(1, '口供上的指印'), bp(2, '名单上的半页'),
      bp(3, '一个人'), bp(4, '又一个决定'), bp(5, '对峙'), bp(6, '代价'),
    ]
    expect(findTitleShapeConvergence(chapters)).toBeNull()
    expect(TITLE_CONVERGENCE_MIN_HITS).toBeGreaterThan(2)
  })

  it('looks at the most recent window only, not any window in the book', () => {
    // 第 1–5 章同构但最近 6 章已经换了写法 → 不报（读者看的是目录末尾那一段）。
    const chapters = [
      bp(1, '口供上的指印'), bp(2, '名单上的半页'), bp(3, '册子里的空号段'), bp(4, '底板下的最后一册'),
      bp(5, '铜墨盒旁的湿痕'), bp(6, '对峙'), bp(7, '代价'), bp(8, '一个人'),
      bp(9, '又一个决定'), bp(10, '天亮之前'), bp(11, '谁在乎'),
    ]
    expect(findTitleShapeConvergence(chapters)).toBeNull()
  })
})

describe('findTitleShapeConvergenceFindings (issue #106 finding shape)', () => {
  const chapters = [
    bp(41, '口供上的指印'), bp(42, '客源单上的空船位'), bp(43, '补底根之前'),
    bp(44, '铜墨盒旁的湿痕'), bp(45, '名单上的半页'), bp(46, '对不上的姓氏'),
  ]

  it('reports one finding naming the window and the real hits', () => {
    const findings = findTitleShapeConvergenceFindings({ chapters })
    expect(findings).toHaveLength(1)
    expect(findings[0]!.stableFactKey).toBe('chapter-title:locative-frame')
    expect(findings[0]!.severity).toBe('warning')
    // 证据落在**已定稿的那几章**里，不是当前章（#79/#108）。
    expect(findings[0]!.sourceChapter).toBe(46)
    expect(findings[0]!.evidence).toContain('第 41–46 章')
    expect(findings[0]!.evidence).toContain('5 章')
    // 样例只取命中章（不把反例列成样例——#98 的教训）。
    expect(findings[0]!.evidence).toContain('口供上的指印')
    expect(findings[0]!.evidence).not.toContain('对不上的姓氏')
  })

  it('hands over a concrete exit (ban the structure, not the words)', () => {
    const finding = findTitleShapeConvergenceFindings({ chapters })[0]!
    expect(finding.suggestion.zhCN).toContain('不要与最近几章共用同一句法骨架')
    expect(finding.suggestion.zhCN).toContain('换名词不算换结构')
    expect(finding.suggestion.enUS).toContain('ban the structure, not the words')
  })

  it('keeps the key stable as the window rolls — an ack must stick', () => {
    // key 不带章号（#86/#89/#98/#108 的教训）：窗口滚一章，key 不变。
    const before = findTitleShapeConvergenceFindings({ chapters })[0]!
    const after = findTitleShapeConvergenceFindings({
      chapters: [...chapters, bp(47, '底板下的最后一册')],
    })[0]!
    expect(after.stableFactKey).toBe(before.stableFactKey)
  })

  it('says nothing when the titles rotate', () => {
    expect(findTitleShapeConvergenceFindings({
      chapters: [bp(1, '多出的一格'), bp(2, '缺角存根'), bp(3, '撕口对得上'), bp(4, '自己的心跳'), bp(5, '半画'), bp(6, '死墨')],
    })).toEqual([])
  })
})
