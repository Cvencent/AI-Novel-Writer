import { describe, expect, it } from 'vitest'

import {
  AI_FLAVOR_QUOTAS,
  METAPHOR_CONNECTORS,
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
