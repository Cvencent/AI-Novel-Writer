import { describe, expect, it } from 'vitest'

import {
  AI_FLAVOR_QUOTAS,
  METAPHOR_CONNECTORS,
  hasFunctionCharacter,
  findChapterMotif,
  measureProseFlavor,
  PHYSIOLOGICAL_CLICHES,
  proseFlavorFindings,
} from '../prose-flavor'

const ch = (chapterNumber: number, content: string) => ({ chapterNumber, content })

// issue #93：用户要「审稿里有一个『AI 味』维度」。核查发现起草侧有一份很具体的
// 反制清单，而审稿侧只有三个字、54 条真实审稿意见里文风类 0 条 —— 缺的是「查」。
// 本模块把清单里**可机器判**的一半落成判据，接在与 #82/#83 同一条通道上。
describe('measureProseFlavor (issue #93)', () => {
  it('counts the explicit simile connectives only — never bare 「像」', () => {
    // 实测那本书裸「像」12 次 / 10 章，绝大多数是「像被什么东西撞了一下」这类正常叙述；
    // 把它算成比喻会让判据变成噪声源（本仓吃过词表过拟合的亏 #30/#43/#70/#80）。
    const measurement = measureProseFlavor(ch(1, '他像被撞了一下。门仿佛开了一条缝。'))
    expect(measurement.metaphor).toBe(1)
    expect(METAPHOR_CONNECTORS).toEqual(['仿佛', '犹如', '宛如', '如同'])
  })

  it('counts templated physiological reactions', () => {
    const measurement = measureProseFlavor(ch(1, '他攥紧拳头。喉结滚了一下。'))
    expect(measurement.physiological).toBe(2)
    expect(PHYSIOLOGICAL_CLICHES).toContain('攥紧拳')
  })

  it('counts overlapping entries separately — which can only over-report, never under-report', () => {
    // 「咬了咬唇」同时含「咬唇」？不含（中间隔着「了咬」）——但「咬唇」与「咬了咬唇」
    // 若同段出现会各计一次。这是刻意的：**宁多算不少算**，因为配额本来就窄（1 处），
    // 漏算会让判据沉默，而多算只会让作者看到一次「你用了 2 处」的提示。
    expect(measureProseFlavor(ch(1, '他咬唇，又咬了咬唇。')).physiological).toBe(2)
  })

  it('does not count a reaction word used at the start of a paragraph as a summarising tail', () => {
    // 「他知道」出现在段首是正常叙述（陈述人物所知），只有落在**段落后半**、
    // 用来替读者总结意思时才叫总结腔。
    expect(measureProseFlavor(ch(1, '他知道那扇门后面是什么。他推开了。')).summaryTails).toEqual([])
  })

  it('flags a paragraph that ends on a summarising note', () => {
    const measurement = measureProseFlavor(ch(1, '他推开门，走了进去。他知道，这一切才刚刚开始。'))
    expect(measurement.summaryTails).toHaveLength(1)
    expect(measurement.summaryTails[0]!.paragraphIndex).toBe(1)
  })

  it('computes the average sentence length, ignoring fragments under two characters', () => {
    const measurement = measureProseFlavor(ch(1, '他推门。门开了。'))
    expect(measurement.averageSentenceChars).toBe(3)
    expect(measureProseFlavor(ch(1, '。！？')).averageSentenceChars).toBeNull()
  })
})

describe('proseFlavorFindings (issue #93)', () => {
  // 实测那本书（42 章 / 40266 字）是**合格的负对照**：比喻 0 次、生理反应 3 处
  // （分散在 3 章）、无段尾总结腔、平均句长 9.5–19.5 全在 22 以内。
  const compliantBook = [
    ch(1, '周叙把铜尺插进撬痕，往外一别。铁皮翻口很新，锈是断的。他蹲下去看。'),
    ch(2, '全叔把绳圈挂上桩。他蹲在那边，绳头压得死紧。船还没开。'),
  ]

  it('stays silent on a book that meets every quota — no noise for good prose', () => {
    expect(proseFlavorFindings(compliantBook, 3)).toEqual([])
  })

  it('reports excessive simile connectives with the count, and keeps the quota honest', () => {
    const findings = proseFlavorFindings([
      ch(1, '门仿佛开了。光犹如水一样漫进来。他的心跳宛如鼓点，空气如同凝固。'),
    ], 2)
    const finding = findings.find(item => item.stableFactKey.startsWith('prose-flavor:metaphor'))
    expect(finding).toBeDefined()
    expect(finding!.evidence).toContain('4 次')
    expect(finding!.evidence).toContain(String(AI_FLAVOR_QUOTAS.metaphor))
    expect(finding!.sourceChapter).toBe(1)
    // 出路必须可执行：给「换成动作或数字」的具体例子，而不是「写得更像人写的」。
    expect(finding!.suggestion.zhCN).toContain('动作')
    expect(finding!.issue.enUS.length).toBeGreaterThan(20)
  })

  it('reports excessive physiological reactions', () => {
    const findings = proseFlavorFindings([
      ch(1, '他攥紧拳头。喉结滚了一下。'),
    ], 2)
    const finding = findings.find(item => item.stableFactKey.startsWith('prose-flavor:physiological'))
    expect(finding).toBeDefined()
    // 配额是 1：两处即超。
    expect(finding!.evidence).toContain('2 处')
    // 出路要去角色卡里找「这个人特有」的反应，而不是换一个同类套话。
    expect(finding!.suggestion.zhCN).toContain('特有')
  })

  it('reports a paragraph that closes on a summary line', () => {
    const findings = proseFlavorFindings([
      ch(1, '船开走了。他知道，这一切才刚刚开始。'),
    ], 2)
    const finding = findings.find(item => item.stableFactKey.startsWith('prose-flavor:summary-tail'))
    expect(finding).toBeDefined()
    expect(finding!.evidence).toContain('第1段')
  })

  it('reports an average sentence length above the quota', () => {
    const long = Array.from({ length: 12 }, () => '他沿着码头一路往前走着并且不断回想着方才那些事情发生的经过')
      .join('。') + '。'
    const findings = proseFlavorFindings([ch(1, long)], 2)
    expect(findings.some(item => item.stableFactKey.startsWith('prose-flavor:sentence-length'))).toBe(true)
  })

  it('never marks a prose-flavor finding as anything but a warning (style must not block)', () => {
    // issue #93 明确要求：风格类问题保持不 blocking。判据这边也不得给出更高等级。
    const findings = proseFlavorFindings([
      ch(1, '门仿佛开了。光犹如水。心跳宛如鼓点。空气如同凝固。他攥紧拳头，喉结滚动。他知道，这一切才刚刚开始。'),
    ], 2)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings.every(item => item.severity === 'warning')).toBe(true)
  })

  it('does not judge blank chapters', () => {
    expect(proseFlavorFindings([ch(1, '   '), ch(2, '')], 3)).toEqual([])
  })

  it('caps the metaphor finding at two occurrences — the drafting list says two, not three', () => {
    // 起草清单在【写作质量硬约束】里写「≤2」，在【AI 味反制】里写「≤3」——
    // 取更严的那个（2），两处口径才一致。
    const two = proseFlavorFindings([ch(1, '门仿佛开了。光犹如水。')], 2)
    expect(two.some(item => item.stableFactKey.startsWith('prose-flavor:metaphor'))).toBe(false)
    const three = proseFlavorFindings([ch(1, '门仿佛开了。光犹如水。心跳宛如鼓点。')], 2)
    expect(three.some(item => item.stableFactKey.startsWith('prose-flavor:metaphor'))).toBe(true)
  })
})

// 真实语料实测的假阳性（本轮亲自踩到）：中文「攥着」绝大多数是**字面意义的握持**——
// 那本书的「伙计攥着一条湿布」「手里攥着半块干饼」被初版词表抓成「紧张套话」。
// 这是本仓反复吃过的词表过拟合（#30/#43/#70/#80），所以只保留**对象被限定**的形式。
describe('physical-reaction word list must not catch literal holding (issue #93)', () => {
  it('does not treat 「攥着某物」 as a tension cliché', () => {
    const measurement = measureProseFlavor(ch(1, '伙计攥着一条湿布。他手里攥着半块干饼。'))
    expect(measurement.physiological).toBe(0)
  })

  it('still catches the actual cliché form', () => {
    expect(measureProseFlavor(ch(1, '他攥紧拳头，指节发白。')).physiological).toBe(1)
  })

  it('stays silent on the whole real book (the issue measured 0 style findings there)', () => {
    // 那本书本身就是合格样本：比喻 0、生理反应 3 处（分散在 3 章、每章 1 处）、
    // 无段尾总结腔、平均句长 9.5–19.5。判据在这类书上必须**不响**。
    const good = [
      ch(1, '伙计攥着一条湿布站在货舱门口。周叙下去看了看，没说话。'),
      ch(2, '周叙把存根压在水隔下面。船还没开，跳板搭着。'),
      ch(3, '全叔蹲在桩边绕绳圈，绳头压得死紧。'),
    ]
    expect(proseFlavorFindings(good, 4)).toEqual([])
  })
})

// issue #96：起草清单里「意象配额：每个词在本章最多出现 2 次」从来没有被检查，
// 而同一条清单里紧挨着的比喻/生理反应/句长三项（#93）已经落地。
// ⚠️ 字面实现「每词 ≤2 次」实测 **43/43 章**都超 —— 那是「规则层输出全是假阳性
// 等于零信息」（#30），所以按**密度**判（同一实词的平均出现间隔）。
describe('findChapterMotif (issue #96)', () => {
  it('finds the word the chapter keeps leaning on, with the count and the paragraphs', () => {
    const chapter = ch(36, Array.from({ length: 8 }, (_, index) =>
      `他把墨盒放在桌沿，墨汁淌开第${index + 1}回。`).join('\n\n'))
    const motif = findChapterMotif(chapter)
    expect(motif).toBeDefined()
    expect(motif!.word).toContain('墨')
    expect(motif!.count).toBeGreaterThanOrEqual(8)
    expect(motif!.paragraphIndexes.length).toBeGreaterThan(0)
  })

  it('is word-list free: a different book and different motif still fire', () => {
    // 判据不枚举「意象」清单（那串例子词是科幻题材的，换一本就失效）。
    const chapter = ch(1, Array.from({ length: 9 }, () => '他把玄铁令按在石台上，灵纹亮了一瞬。').join('\n\n'))
    const motif = findChapterMotif(chapter)
    expect(motif).toBeDefined()
    expect(motif!.word).toMatch(/玄铁|石台|灵纹|铁令/)
  })

  it('never picks a window that contains a function character', () => {
    // 「了一」「的那」「他把」这类窗口在每章都大量出现；不剔掉它们，最高频词永远是虚词。
    const chapter = ch(1, Array.from({ length: 20 }, () => '他把那件事说了，她的意思他懂。').join('\n\n'))
    const motif = findChapterMotif(chapter)
    if (motif) expect(hasFunctionCharacter(motif.word)).toBe(false)
  })

  it('excludes cast names — a person is content, not a prop', () => {
    const chapter = ch(1, Array.from({ length: 12 }, () => '柯明远把纸按在桌上。').join('\n\n'))
    const motif = findChapterMotif(chapter, ['柯明远'])
    expect(motif?.word ?? '').not.toContain('柯明')
  })

  it('drops a short window when a longer, equally frequent one contains it', () => {
    // 「票」⊂「票根」：两者都高频时报「票根」而不是两条（同 #73「去子串锚点」）。
    const chapter = ch(1, Array.from({ length: 10 }, () => '那张票根是票根，边角发硬。').join('\n\n'))
    expect(findChapterMotif(chapter)!.word).toBe('票根')
  })

  it('stays silent on a chapter whose words are spread out (density is the criterion)', () => {
    // 同一个词出现 4 次、但每次都隔了很长的不同内容——不到密度门槛，不报。
    // （注意 filler 本身必须是**各不相同**的句子，否则会造出一个新的高频窗口，
    //  那时判据报的是那个窗口而不是这句测试想验的「稀疏」——第一版就踩了这个。）
    const varied = [
      '船沿水道往东，两侧的芦苇被风压向一边。',
      '码头尽头有个人在收网，动作很慢。',
      '账房的算盘响了一阵，又停了。',
      '他把缆绳绕上桩，绳头垂进水里。',
      '远处的灯桩一闪一闪，像是要灭。',
      '仓门被推开又合上，木头发出闷响。',
      '早潮退了，滩上留下几道湿痕。',
      '有人在低声说话，听不清内容。',
      '风灯的光晃过墙面，影子拉长又缩回。',
      '跳板搭上岸，木板之间磨出吱声。',
    ].join('')
    const chapter = ch(1, `${varied}票根。${varied}票根。${varied}票根。${varied}票根。`)
    expect(findChapterMotif(chapter)).toBeNull()
  })

  it('keeps the quota honest against the drafting list (motifPerChapter is documented)', () => {
    expect(AI_FLAVOR_QUOTAS.motifPerChapter).toBe(2)
    expect(AI_FLAVOR_QUOTAS.motifDensityChars).toBeGreaterThan(0)
  })

  it('reports a motif finding through the shared channel with a stable key', () => {
    const dense = ch(43, Array.from({ length: 12 }, () => '三张存根按到毛巾底下，存根吃水，墨翻上来。').join('\n\n'))
    const findings = proseFlavorFindings([dense], 44)
    const finding = findings.find(item => item.stableFactKey.startsWith('prose-flavor:motif'))
    expect(finding).toBeDefined()
    expect(finding!.stableFactKey).toBe('prose-flavor:motif:43')
    expect(finding!.severity).toBe('warning')
    expect(finding!.evidence).toContain('存根')
    // 出路三选一都得是可执行的，而不是「少用点这个词」。
    expect(finding!.suggestion.zhCN).toContain('换指称')
    expect(finding!.suggestion.enUS).toContain('vary the reference')
  })

  it('runs on the whole book without the earlier three checks firing (no cross-talk)', () => {
    // 只超「意象配额」的正文，不该顺带触发比喻/生理/句长任何一条。
    const onlyMotif = ch(1, Array.from({ length: 10 }, () => '玄铁令在石台上，玄铁令没有动。').join('\n\n'))
    const findings = proseFlavorFindings([onlyMotif], 2)
    expect(findings.every(item => item.stableFactKey.startsWith('prose-flavor:motif'))).toBe(true)
  })
})
