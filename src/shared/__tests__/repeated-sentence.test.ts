import { describe, expect, it } from 'vitest'

import { findRepeatedSentenceFindings } from '../repeated-sentence'

const ch = (chapterNumber: number, content: string) => ({ chapterNumber, content })

/**
 * issue #140：相邻两章里出现**逐字相同的一整句**，而写第 63 章时预检弹了 46 条、
 * 没有一条提到它——`prose-repetition` 只扫三族固定短语，覆盖率阈值又是样本章数的
 * 60%，整句复用永远够不到。
 */
describe('findRepeatedSentenceFindings (issue #140)', () => {
  const CH59 = '周叙下舱核舱。周叙看了两息，指腹按进印泥，压在栏上。他往前走。'
  const CH60 = '船开了。周叙看了两息，指腹按进印泥，压在栏上。温珩在舵位上。'

  it('flags a whole sentence copied verbatim into the next chapter', () => {
    const [hit] = findRepeatedSentenceFindings([ch(59, CH59), ch(60, CH60)])
    expect(hit).toBeDefined()
    expect(hit!.evidence).toContain('第59章与第60章')
    expect(hit!.evidence).toContain('16 字逐字相同')
    expect(hit!.evidence).toContain('周叙看了两息，指腹按进印泥，压在栏上。')
  })

  it('does not flag a deliberately quoted line', () => {
    // 实测形态（第 20 章）：「他把叶九那句话原样端出来。『这一笔不是我一个人要补的。』谁下的令？」
    const quoted = '周叙没坐。他把叶九那句话原样端出来。「这一笔不是我一个人要补的。」谁下的令？'
    expect(findRepeatedSentenceFindings([
      ch(19, '叶九说：「这一笔不是我一个人要补的。」他把账本一塞。'),
      ch(20, quoted),
    ])).toEqual([])
  })

  it('stays silent on short sentences: the threshold is what keeps it quiet', () => {
    // 「他把存根摊在桌上。」这类通用短句在长篇里必然重复——不判。
    expect(findRepeatedSentenceFindings([
      ch(1, '他把存根摊在桌上。'),
      ch(2, '他把存根摊在桌上。'),
    ])).toEqual([])
  })

  it('ignores punctuation differences: the comparison is literal after stripping', () => {
    // 同一句话换个标点仍是逐字复用。
    expect(findRepeatedSentenceFindings([
      ch(9, '他看了两息，指腹按进印泥，压在栏上。'),
      ch(10, '他看了两息：指腹按进印泥，压在栏上。'),
    ]).length).toBe(1)
  })

  it('does not compare chapters beyond the window', () => {
    expect(findRepeatedSentenceFindings([
      ch(1, CH59),
      ch(40, CH60),
    ])).toEqual([])
  })

  it('does not treat the same action written differently as a copy', () => {
    // issue 里明确区分过：同场景合法延续不算（第 49→50 章又写同一处刮痕）。
    expect(findRepeatedSentenceFindings([
      ch(49, '贴到掌心的潮气上，翻出一个半边——三点水。温。'),
      ch(50, '指尖在板面蹭了潮，压在残片上。刮痕底下翻出一个半边，三点水。'),
    ])).toEqual([])
  })

  it('keys name the chapter where the sentence first appeared, so it does not drift', () => {
    const printed = 0
    const base = findRepeatedSentenceFindings([ch(59, CH59), ch(60, CH60)])[0]!.stableFactKey
    const later = findRepeatedSentenceFindings([ch(59, CH59), ch(60, CH60), ch(61, '他把缆绳绕好。')])[0]!.stableFactKey
    expect(base).toBe(later)
    expect(base.startsWith('prose:sentence-reuse:59:')).toBe(true)
    expect(printed).toBe(0)
  })

  it('is structural: a different book with different sentences is judged the same way', () => {
    const hits = findRepeatedSentenceFindings([
      ch(3, '铜钥匙在桌上搁着，谁也没去拿。'),
      ch(4, '风从窗缝里进来。铜钥匙在桌上搁着，谁也没去拿。'),
    ])
    expect(hits.length).toBe(1)
    expect(hits[0]!.stableFactKey).toContain('prose:sentence-reuse:3:')
  })
})