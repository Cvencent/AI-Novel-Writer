import { describe, expect, it } from 'vitest'

import { findRefinementFactTerms } from '../refinement-fact-diff'

/**
 * issue #123：「直接修稿」把已收进对手包里的主线物证凭空挂到另一个角色腰上。
 *
 * 这一步的唯一验收闸只查「格式完整 + 字数不少」，没有任何事实核对；作者要发现它，
 * 只能逐段读完 11 处并自己记得第 52 章那把尺在谁包里。
 *
 * 判据（结构性，无道具词表）：修稿里出现了、原稿里没有、而**本章蓝图与前文
 * 都已经确立**的专名。
 */
describe('findRefinementFactTerms (issue #123)', () => {
  const SOURCE = '回执在木面上摊平。栏底一行送检比对，红印落定。字都干着，不用蘸水。'
  const REVISION = [
    '回执在木面上摊平。栏底一行送检比对，红印落定。字都干着，不用蘸水。',
    '邵广海眼光往引桥口一瞥——叶九站在那儿，竹尺别在腰里，没过来。',
    '「程序是程序。柯代表也知道，竹尺裂口里那截残笔要是和待核旁注摆在一处——」',
  ].join('\n\n')
  const BLUEPRINT = '柯明远在码头栈桥拦住周叙递回执，邵广海跟到，报出待核旁注要求按未登船处理周叙；柯明远怕竹尺裂口“柯”字残笔被邵广海拿去并列。'
  /** 前文里竹尺/残笔/裂口都出现过（ch52、ch53 把尺子写进了柯明远包里）。 */
  const HISTORY = [
    '叶九的手从侧面伸过来，两指捏住尺尾。「这尺是我的。」周叙没松。「放下。」竹尺推进包内层。扣合上。',
    '柯明远从公文包内层抽出竹尺，卷进一张旧报纸。柯明远把卷宗扣进包内层，竹尺压在上面。铜扣合上，一声闷响。',
  ]
  const CAST = ['周叙', '温珩', '邵广海', '叶九', '柯明远', '林棠', '全叔']

  it('flags the prop the revision invented into a character’s waist', () => {
    const terms = findRefinementFactTerms({
      source: SOURCE, revision: REVISION, blueprintKeyEvents: BLUEPRINT, history: HISTORY, castNames: CAST,
    })
    expect(terms.map(item => item.term)).toContain('竹尺')
    // 前文两章都写过它 → 是已确立的物件，不是这次新造的临时词。
    expect(terms.find(item => item.term === '竹尺')!.historyChapters).toBe(2)
  })

  it('stays silent when the draft already had the term (nothing was added)', () => {
    const withProp = `${SOURCE}\n\n竹尺在桌上。`
    expect(findRefinementFactTerms({
      source: withProp, revision: REVISION, blueprintKeyEvents: BLUEPRINT, history: HISTORY, castNames: CAST,
    })).toEqual([])
  })

  it('stays silent when the term is not established in earlier prose', () => {
    // 只在前文出现过一次的词不算「已确立」——默认门槛是 2 章。
    expect(findRefinementFactTerms({
      source: SOURCE, revision: REVISION, blueprintKeyEvents: BLUEPRINT, history: HISTORY.slice(0, 1), castNames: CAST,
    })).toEqual([])
  })

  it('never reports the grammatical fragments the real revisions produced', () => {
    // 实测噪声形态（三份真实修稿上跑出来的四个）：含结构助词的「记得」、含系词的「正是」、
    // 代词开头的「他一」、含介词的「明远从」。它们都不是专名，靠**封闭功能字类**挡掉。
    const noisy = '他记得正是因为他一开口，明远从栈桥那头走过来。'
    const terms = findRefinementFactTerms({
      source: SOURCE,
      revision: `${SOURCE}

${noisy}`,
      blueprintKeyEvents: noisy,
      history: [`${noisy}一`, `${noisy}二`],
      castNames: CAST,
    })
    const names = terms.map(item => item.term)
    for (const fragment of ['记得', '正是', '他一', '明远从']) expect(names, fragment).not.toContain(fragment)
  })

  it('keeps the longest match instead of reporting every substring', () => {
    const terms = findRefinementFactTerms({
      source: SOURCE, revision: REVISION, blueprintKeyEvents: BLUEPRINT, history: HISTORY, castNames: CAST,
    })
    const names = terms.map(item => item.term)
    // 「竹尺裂口」命中后不再单报「裂口」；但「竹尺」本身没被更长命中包住时仍保留。
    expect(names).not.toContain('裂口里')
    expect(names).not.toContain('待核旁')
  })

  it('returns nothing without a blueprint, a source or a revision', () => {
    const base = { source: SOURCE, revision: REVISION, blueprintKeyEvents: BLUEPRINT, history: HISTORY, castNames: CAST }
    expect(findRefinementFactTerms({ ...base, blueprintKeyEvents: '' })).toEqual([])
    expect(findRefinementFactTerms({ ...base, source: '' })).toEqual([])
    expect(findRefinementFactTerms({ ...base, revision: '' })).toEqual([])
  })

  it('is structural: a different book and different props are judged the same way', () => {
    const terms = findRefinementFactTerms({
      source: '他把门带上。',
      revision: '他把门带上。铜钥匙在桌上搁着。',
      blueprintKeyEvents: '他放下铜钥匙，转身出门。',
      history: ['他把铜钥匙收进抽屉。', '铜钥匙一直挂在他腰上。'],
      castNames: ['他'],
    })
    expect(terms.map(item => item.term)).toEqual(['铜钥匙'])
  })
})