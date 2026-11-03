import { describe, expect, it } from 'vitest'

import {
  glyphRadicalFindings,
  glyphRadicalMismatches,
  radicalLabelOf,
  radicalNamesIn,
} from '../glyph-radical'
import { RADICAL_CHARS_BY_INDEX } from '../glyph-radical-table'

// issue #99：那本 45 章的悬疑长篇，核心金手指是「溯读」——读出被覆盖的字。
// 「半个字 + 偏旁」是全书最高频的证据形态，但两处关键线索把偏旁写错了：
//   第 45 章「半个“温”字。左边半边，立人旁。」（温 = 氵，不含立人旁）
//   第 43 章「先露走之底，再往上——徐。」（徐 = 彳，不含走之底）
// 全书出现具体偏旁名的只有 3 处，**两处指到具体字的断言，两处都错**。
describe('the radical table itself (issue #99)', () => {
  /** 按部首序号查字 —— 与 detection 用的是同一份数据。 */
  const radicalOf = (character: string): number | null => {
    const at = RADICAL_CHARS_BY_INDEX.findIndex(chars => chars.includes(character))
    return at >= 0 ? at + 1 : null
  }

  it('covers all 214 Kangxi radicals', () => {
    expect(RADICAL_CHARS_BY_INDEX).toHaveLength(214)
  })

  it('agrees with the reported characters — the two the issue says were written wrong', () => {
    // 温 = 氵（第 85 部 水），徐 = 彳（第 60 部 彳）—— 与 issue 的字形事实一致。
    expect(radicalOf('温')).toBe(85)
    expect(radicalOf('徐')).toBe(60)
    // 反证：issue 说的那两个偏旁确实**不在**这些字里。
    expect(RADICAL_CHARS_BY_INDEX[8]).not.toContain('温') // 第 9 部 人（亻）
    expect(RADICAL_CHARS_BY_INDEX[8]).not.toContain('徐')
    expect(RADICAL_CHARS_BY_INDEX[161]).not.toContain('徐') // 第 162 部 辵（辶）
  })

  it('agrees on the cast-name characters used by the book', () => {
    expect(radicalOf('周')).toBe(30)   // 口
    expect(radicalOf('海')).toBe(85)   // 氵
    expect(radicalOf('林')).toBe(75)   // 木
    expect(radicalOf('叶')).toBe(30)   // 口
  })

  it('does not contain a character under two radicals (lookup must be unambiguous)', () => {
    const seen = new Map<string, number>()
    RADICAL_CHARS_BY_INDEX.forEach((chars, position) => {
      for (const char of chars) {
        const previous = seen.get(char)
        // 同一字落两部会让「实际部首」取决于遍历顺序——表生成时已经按第一部取。
        expect(previous, `${char} in radicals ${previous} and ${position + 1}`).toBeUndefined()
        seen.set(char, position + 1)
      }
    })
  })

  // 俗称 → 部首序号是我**手写**的，必须能被生成数据反向印证：
  // 该部的代表字里得真的有俗称描述的那个构件。手抄错一个序号，判据就会把
  // 「对的说成错的」——这种错误比漏报严重得多（本仓 #30 的教训）。
  it('every hand-written name maps to the radical whose members actually carry it', () => {
    const checks: ReadonlyArray<[name: string, radicalIndex: number, sample: string]> = [
      ['立人旁', 9, '你'], ['双人旁', 60, '往'], ['走之底', 162, '边'], ['三点水', 85, '江'],
      ['提手旁', 64, '打'], ['竖心旁', 61, '忙'], ['草头', 140, '花'], ['言字旁', 149, '计'],
      ['金字旁', 167, '钢'], ['绞丝旁', 120, '红'], ['食字旁', 184, '饭'], ['示字旁', 113, '社'],
      ['衣字旁', 145, '补'], ['竹字头', 118, '笔'], ['反犬旁', 94, '狗'], ['王字旁', 96, '玩'],
      ['病字旁', 104, '病'], ['皿字底', 108, '盘'], ['火字旁', 86, '灯'], ['木字旁', 75, '林'],
      ['口字旁', 30, '叶'], ['宝盖头', 40, '安'], ['国字框', 31, '国'], ['门字框', 169, '问'],
      ['左耳旁', 170, '陈'], ['右耳旁', 163, '邻'], ['立刀旁', 18, '别'], ['单耳旁', 26, '却'],
    ]
    for (const [name, index, sample] of checks) {
      // 该俗称确实被表认识，且指向这个序号。
      expect(radicalNamesIn(name)[0]?.index, name).toBe(index)
      // 该部的成员里确实有这个代表字（序号抄错时会在这里红）。
      expect(RADICAL_CHARS_BY_INDEX[index - 1], `${name} -> 第 ${index} 部`).toContain(sample)
    }
  })
})

describe('radicalNamesIn (issue #99)', () => {
  it('recognizes the colloquial names from the report', () => {
    expect(radicalNamesIn('先露走之底，再往上')).toEqual([{ name: '走之底', index: 162, at: 2 }])
    expect(radicalNamesIn('左边半边，立人旁')).toEqual([{ name: '立人旁', index: 9, at: 5 }])
  })

  it('prefers the longer name over its prefix (「走之底」 before 「走之」)', () => {
    const hits = radicalNamesIn('半个走之底')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.name).toBe('走之底')
  })

  it('does not report overlapping matches twice', () => {
    // 「三点水旁」同时含「三点水」与「三点水旁」——只算最长的那一次。
    expect(radicalNamesIn('左边是三点水旁').map(hit => hit.name)).toEqual(['三点水旁'])
  })

  it('stays silent on ordinary prose with no radical name', () => {
    expect(radicalNamesIn('他把票根压在水槽里，绳缝吐着白汽。')).toEqual([])
  })

  it('refuses names that map to two radicals (a false positive would be worse)', () => {
    // 「月字旁」既可能是「月」（第 74 部）也可能是「肉」（第 130 部）——刻意不收。
    expect(radicalNamesIn('月字旁')).toEqual([])
    expect(radicalNamesIn('双耳旁')).toEqual([])
  })
})

describe('radicalLabelOf (issue #99)', () => {
  it('gives the colloquial name plus the Kangxi glyph, so the author can act on it', () => {
    expect(radicalLabelOf(85)).toBe('三点水（氵）')
    expect(radicalLabelOf(60)).toBe('双人旁（彳）')
    expect(radicalLabelOf(9)).toBe('单人旁（亻）')
    expect(radicalLabelOf(162)).toBe('走之底（辶）')
  })

  it('falls back to the Kangxi radical glyph for a radical with no colloquial name', () => {
    // 第 210 部 齊：俗称表里没有，但要给出可核对的部首原型（康熙部首字形）而不是空串。
    expect(radicalLabelOf(210)).toContain('第 210 部')
    expect(radicalLabelOf(210)).toContain(String.fromCodePoint(0x2f00 + 209))
    // 有俗称的部走俗称分支，不走兜底。
    expect(radicalLabelOf(85)).not.toContain('第 85 部')
  })
})

describe('glyphRadicalMismatches (issue #99)', () => {
  it('catches the reported chapter 45 sentence (温 written with 立人旁)', () => {
    const findings = glyphRadicalMismatches(45,
      '蒸汽熏了一盏茶的工夫，那面返潮。\n\n半个“温”字。左边半边，立人旁。\n\n底下一串数字残笔，头三个还认得出——一七四。')
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      chapterNumber: 45,
      character: '温',
      claimedName: '立人旁',
      actualRadical: 85,
      actualLabel: '三点水（氵）',
    })
  })

  it('catches the reported chapter 43 sentence (徐 written with 走之底)', () => {
    const findings = glyphRadicalMismatches(43,
      '第三张按下去。潮气走慢，字浮得也慢。先露走之底，再往上——徐。\n\n徐哥。')
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ character: '徐', claimedName: '走之底', actualRadical: 60 })
  })

  it('does not guess the character from a number sequence after a dash', () => {
    // 真实语料踩到的坑：「——一七四」里的「一」不是被讨论的字。
    // 不加「其后不接汉字」这条限制时，第 45 章会出现两个候选字（温、一）→ 判据沉默。
    expect(glyphRadicalMismatches(45, '半个“温”字。左边半边，立人旁。底下一串数字残笔——一七四。')).toHaveLength(1)
  })

  it('stays silent when the named radical IS the character\'s radical', () => {
    // 第 5 章的「半个草头」：草头（艹 = 第 140 部）与「草」的实际部首一致，且没指名具体字。
    expect(glyphRadicalMismatches(5, '笔尖悬着，纸面已经洇出半个草头。他把笔提起来。')).toEqual([])
    expect(glyphRadicalMismatches(1, '先露三点水，再往上——温。')).toEqual([])
  })

  it('does not judge a sentence that names a radical but no specific character', () => {
    // 没有引号单字、破折号后也没单字时，判据无从核对——宁漏不误报。
    expect(glyphRadicalMismatches(5, '纸面已经留了半个草头。')).toEqual([])
  })

  it('stays silent when any neighbouring radical name matches', () => {
    // 并列交代同一个字的好几个部件时，只要有一项对得上就不该报。
    expect(glyphRadicalMismatches(1, '“温”字，左边三点水，右边是立人旁。')).toEqual([])
  })

  it('does not guess when the window contains two different candidate characters', () => {
    // 牵连不清时不报：本仓在 #30/#93 反复吃过「规则层输出全是假阳性」的亏。
    expect(glyphRadicalMismatches(1, '“温”字旁边还有“徐”字，都带立人旁。')).toEqual([])
  })

  it('reads the assertion across a sentence break', () => {
    // 断言常被句号切开：被描述的字在前一句、偏旁名在后一句。
    const findings = glyphRadicalMismatches(45, '半个“温”字。左边半边，立人旁。')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.character).toBe('温')
  })
})

describe('glyphRadicalFindings (issue #99 finding shape)', () => {
  const chapters = [
    { chapterNumber: 43, content: '先露走之底，再往上——徐。' },
    { chapterNumber: 45, content: '半个“温”字。左边半边，立人旁。' },
    { chapterNumber: 46, content: '他把票根压在水槽里。' },
  ]

  it('reports one finding per wrong assertion, with the correct radical handed over', () => {
    const findings = glyphRadicalFindings(chapters)
    expect(findings).toHaveLength(2)
    const warm = findings.find(item => item.stableFactKey.includes('温'))!
    expect(warm.stableFactKey).toBe('glyph:radical-mismatch:温:立人旁')
    expect(warm.severity).toBe('warning')
    expect(warm.sourceChapter).toBe(45)
    // 出路必须直接给出正确的偏旁，作者一眼能改。
    expect(warm.suggestion.zhCN).toContain('三点水（氵）')
    expect(warm.suggestion.enUS).toContain('三点水')
    // 也提示把字形判据写进账本（issue 建议 3），免得下游继承错误。
    expect(warm.suggestion.zhCN).toContain('事实账本')
  })

  it('keys do not embed the chapter number — an ack must stick (issues #86/#89/#98)', () => {
    const at45 = glyphRadicalFindings([{ chapterNumber: 45, content: '半个“温”字。左边半边，立人旁。' }])[0]!
    const at46 = glyphRadicalFindings([{ chapterNumber: 46, content: '半个“温”字。左边半边，立人旁。' }])[0]!
    expect(at45.stableFactKey).toBe(at46.stableFactKey)
  })

  it('does not cross-talk between chapters (only the wrong ones are reported)', () => {
    const findings = glyphRadicalFindings([{ chapterNumber: 46, content: '他把票根压在水槽里，绳缝吐着白汽。' }])
    expect(findings).toEqual([])
  })

  it('skips chapters without a safe integer number instead of inventing one', () => {
    expect(glyphRadicalFindings([{ chapterNumber: Number.NaN, content: '半个“温”字。左边半边，立人旁。' }]))
      .toEqual([])
  })
})

describe('glyphRadicalMismatches — 跨句借字不张冠李戴 (issue #119)', () => {
  // issue #119 第 52 章原文（逐字）：偏旁名在说第 3 句后的「柯」，判据却借了指上句的「温」。
  const CH52 = `周叙把册子摊开。裂到「温」字刮去的那处停住，缝里翻出更深一层墨——一横起头，底下跟着一竖。木字旁的起笔。

`
    + `周叙盯着那道残笔。

裂口里那道起笔立在他脑子里。像「柯」字的第一笔。`

  it('does not report 温/木字旁 when a matching 柯 appears later in the same scene', () => {
    expect(glyphRadicalMismatches(52, CH52)).toEqual([])
  })

  it('still reports the same shape when NO matching character is anywhere near', () => {
    // 去掉「像『柯』字的第一笔」那一句（—真正被描述的字没了）→ 这时才是真错报。
    const without = `周叙把册子摊开。裂到「温」字刮去的那处停住，缝里翻出更深一层墨——一横起头，底下跟着一竖。木字旁的起笔。

周叙盯着那道残笔。`
    const hits = glyphRadicalMismatches(52, without)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ character: '温', claimedName: '木字旁' })
  })

  it('prefers the character in the SAME sentence over one borrowed from an adjacent sentence', () => {
    // 本句自己有引号单字时，相邻句那个字不该被借进来。
    expect(glyphRadicalMismatches(1, '「柯」字的木字旁。上一句提到「温」。')).toEqual([])
  })

  it('keeps both #99 true positives (the radical name sits in its own sentence there)', () => {
    // ⚠️ 这里正是**不能**按 issue 建议 2 字面实现的原因：第 45/43 章里
    // 「立人旁」/「走之底」所在的那半句**自身没有字**，必须向相邻句借才判得出来。
    expect(glyphRadicalMismatches(45, '半个“温”字。左边半边，立人旁。')).toHaveLength(1)
    expect(glyphRadicalMismatches(43, '先露走之底，再往上——徐。')).toHaveLength(1)
  })
})
