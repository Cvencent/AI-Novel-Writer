import { describe, expect, it } from 'vitest'

import { findRepeatedSentenceFindings, findShortSentenceReuseFindings } from '../repeated-sentence'

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
/**
 * issue #145：金手指的代价落点句在 12 章里用同一句叙述短句（「脑子里空了一块」）。
 *
 * #140 的判据两条限制把它整个漏掉：整句只有 8 字（门槛 12 字）+ 相邻 3 章窗口
 * （实测跨度 33 章）。这一档是同一族的**短句 / 分布**版本，与 #140 边界不重叠。
 */
describe('findShortSentenceReuseFindings (issue #145)', () => {
  const CAST = ['周叙', '温珩', '柯明远']
  const book = (...chapters: Array<[number, string]>) =>
    chapters.map(([chapterNumber, content]) => ({ chapterNumber, content }))

  it('flags one short narrative line reused verbatim across many chapters', () => {
    const [hit] = findShortSentenceReuseFindings(book(
      [34, '他伸手去够。脑子里空了一块。'],
      [43, '墨渗进纸背。脑子里空了一块。'],
      [48, '外廊没人。脑子里空了一块。'],
      [64, '他把绳圈收紧。脑子里空了一块。'],
      [67, '引桥的灯亮着。脑子里空了一块。'],
    ), CAST)
    expect(hit).toBeDefined()
    expect(hit!.stableFactKey.startsWith('prose:short-sentence-reuse:34:')).toBe(true)
    // 证据要把**所有**章号列出来，作者才知道这一句用了多少次。
    for (const number of [34, 43, 48, 64, 67]) expect(hit!.evidence).toContain(`第${number}章`)
    expect(hit!.issue.zhCN).toContain('脑子里空了一块')
  })

  it('does not fire on the same line used twice, or inside a short span', () => {
    // 两章：不足以说「反复」。
    expect(findShortSentenceReuseFindings(book(
      [34, '脑子里空了一块。'],
      [43, '脑子里空了一块。'],
    ), CAST)).toEqual([])
    // 三章但都在同一段里（跨度 < 8）→ 视为连续剧情的合法延续。
    expect(findShortSentenceReuseFindings(book(
      [34, '脑子里空了一块。'],
      [36, '脑子里空了一块。'],
      [38, '脑子里空了一块。'],
    ), CAST)).toEqual([])
  })

  it('narrows out dialogue: a quoted line is a character speaking, not a narrative template', () => {
    // 台词复现是设定/口头禅（「随册送检。」三章都有），不是叙述模板。
    expect(findShortSentenceReuseFindings(book(
      [21, '“随册送检。”他把回执推过去。'],
      [23, '“随册送检。”柯明远说。'],
      [30, '“随册送检。”'],
    ), CAST)).toEqual([])
  })

  it('narrows out cast names: 「周叙没动。」八章是动作 idiom，不是模板', () => {
    // 逐字实测：本书「周叙没动。」8 章、「周叙没答。」7 章——都是正常的受挫反应短句。
    // 判据要求整句里没有在册人名，才是在看「叙述者怎么落这一拍」。
    const lines: Array<[number, string]> = [[2, '周叙没动。'], [9, '周叙没动。'], [12, '周叙没动。'],
      [28, '周叙没动。'], [35, '周叙没动。'], [48, '周叙没动。']]
    expect(findShortSentenceReuseFindings(book(...lines), CAST)).toEqual([])
    // 同一句去掉人名后同样的形态也不算：判据看的是**整句原文**里有没有人名。
    expect(findShortSentenceReuseFindings(book(
      [2, '他没动。'], [9, '他没动。'], [12, '他没动。'], [28, '他没动。'], [35, '他没动。'], [48, '他没动。'],
    ), CAST)).toEqual([])
  })

  it('leaves 12+ character sentences to #140, so the two axes never double-report', () => {
    const long = '周叙看了两息，指腹按进印泥，压在栏上。'
    const chapters = book([1, long], [2, long], [3, long], [20, long])
    // 短句一档不管它（> 11 字）……
    expect(findShortSentenceReuseFindings(chapters, CAST)).toEqual([])
    // ……而 #140 的整句一档会报（相邻 3 章内 ≥12 字逐字相同）。
    expect(findRepeatedSentenceFindings(chapters).length).toBeGreaterThan(0)
  })

  it('is structural: a different book with a different cast is judged the same way', () => {
    const [hit] = findShortSentenceReuseFindings(book(
      [4, '沈砚把刀收回鞘里。手背上那处旧伤发麻。'],
      [12, '灯芯烧短了一截。手背上那处旧伤发麻。'],
      [23, '风把门推开。手背上那处旧伤发麻。'],
    ), ['沈砚'])
    expect(hit!.issue.zhCN).toContain('手背上那处旧伤发麻')
  })

  it('keys on the first chapter, which does not drift as the book advances', () => {
    const base = findShortSentenceReuseFindings(book(
      [34, '脑子里空了一块。'], [43, '脑子里空了一块。'], [48, '脑子里空了一块。'],
    ), CAST)[0]!.stableFactKey
    const later = findShortSentenceReuseFindings(book(
      [34, '脑子里空了一块。'], [43, '脑子里空了一块。'], [48, '脑子里空了一块。'],
      [80, '脑子里空了一块。'],
    ), CAST)[0]!.stableFactKey
    expect(base).toBe(later)
  })
})

/**
 * issue #145 的关键：**换措辞不算换写法**。
 *
 * 那本书 8 章里同一拍换了三种写法（「空了一块」「空了一下」「空了一小块」），
 * 逐字整句比对（#140）与「换个说法写同一件事」都判不出来——判据比的是**句首骨架**。
 */
describe('short sentence reuse groups variants by skeleton (issue #145)', () => {
  const CAST = ['周叙', '温珩']
  const book = (...chapters: Array<[number, string]>) =>
    chapters.map(([chapterNumber, content]) => ({ chapterNumber, content }))

  it('groups differently-worded instances under one finding', () => {
    const [hit] = findShortSentenceReuseFindings(book(
      [34, '脑子里空了一块。'],
      [43, '脑子里空了一块。'],
      [52, '脑子里空了一下。'],
      [62, '脑子里空了一小块。'],
      [67, '脑子里空了一块。'],
    ), CAST)
    expect(hit).toBeDefined()
    expect(hit!.stableFactKey).toBe('prose:short-sentence-reuse:34:脑子里空了一')
    // 三种写法都要在证据里，作者才知道这不是「一句话的 8 个副本」。
    expect(hit!.evidence).toContain('脑子里空了一块')
    expect(hit!.evidence).toContain('脑子里空了一下')
    expect(hit!.evidence).toContain('脑子里空了一小块')
    // 8 章 → 章号要全列出来。
    expect(hit!.issue.zhCN).toContain('第62章')
  })

  it('uses a 6-character skeleton: 5 would start flagging place names', () => {
    // 实测 5 字前缀会把「码头办公室的门半开着」「码头办公室门开着」判成模板——
    // 那是同一个**地方**，不是同一个句式。
    expect(findShortSentenceReuseFindings(book(
      [5, '码头办公室的门半开着。'],
      [20, '码头办公室门开着，灯亮着。'],
      [51, '码头办公室的门半掩。'],
    ), CAST)).toEqual([])
  })

  it('reports the skeleton once, not once per variant', () => {
    const hits = findShortSentenceReuseFindings(book(
      [34, '脑子里空了一块。'],
      [43, '脑子里空了一下。'],
      [52, '脑子里空了一小块。'],
      [67, '脑子里空了一块。'],
    ), CAST)
    expect(hits).toHaveLength(1)
  })
})
