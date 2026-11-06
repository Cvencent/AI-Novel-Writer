import { describe, expect, it } from 'vitest'

import { auditFinalizedProse } from '../finalized-prose-audit'
import { foreshadowingKeywords } from '../foreshadowing-commitments'

/** 报告里的原文（照抄，把判据钉在真实样本上）。 */
const CH9 = '舱门口有赤脚踩木板的声响。温珩站在那儿，靛蓝短褂下摆往下滴。'
const CH10 = '舱门口有赤脚踩木板的声响。温珩站在那儿。靛蓝短褂，没出声。'

/** 12 章样本：多数章都出现同一批否定式微动作（#33 的固定反应）。 */
const stillnessBook = (overrides: Record<number, string> = {}) =>
  Array.from({ length: 12 }, (_, index) => {
    const chapterNumber = index + 1
    return { chapterNumber, content: overrides[chapterNumber] ?? `周叙问了一句。温珩没动，也没答。` }
  })

describe('auditFinalizedProse (issue #83)', () => {
  it('returns nothing without any finalized prose', () => {
    expect(auditFinalizedProse({ chapters: [], castNames: [], blueprints: [] })).toEqual([])
  })

  it('ignores blank chapters instead of judging them', () => {
    expect(auditFinalizedProse({
      chapters: [{ chapterNumber: 1, content: '   ' }, { chapterNumber: 2, content: '' }],
      castNames: [], blueprints: [],
    })).toEqual([])
  })

  it('no longer judges cross-chapter repetition in rules: that axis moved to the model', () => {
    // ⚠️ 口径变更（用户 2026-11-05）：跨章重复原先靠三族**题材短语表**（没动／没答／下舱底…），
    // 用户明确要求「不能设计词表、不能用短语匹配，内容类全部让模型判断」。
    // 因此这条断言从「audit 必须报」改成「audit **不再**在规则层报」——
    // 该轴现在由 `content-review.ts` 交给模型（`repeated-reaction` / `repeated-device`），
    // 由作者在预检里主动触发。留着旧的「必须报」断言等于把已删除的词表钉成规格。
    const findings = auditFinalizedProse({
      chapters: stillnessBook(), castNames: ['温珩'], blueprints: [],
    })
    expect(findings.some(finding => finding.stableFactKey.startsWith('prose:stillness'))).toBe(false)
    expect(findings.some(finding => finding.stableFactKey.startsWith('prose:repeated-reaction'))).toBe(false)
  })

  /**
   * issue #132：蓝图声明了跨日、正文没写——这条必须从**共用出口**报出来，
   * 否则写前预检与审稿两条路径都拿不到它（#83 的意义就在于此）。
   */
  /**
   * issue #133：清单件数对不上——必须从**共用出口**报出来，否则写前预检与审稿两条路径都拿不到。
   */
  /** issue #136：量具换算矛盾必须从共用出口报出来。 */
  /** issue #144：标题点到的角色本章没出场，必须从共用出口报出来。 */
  it('surfaces a title naming an absent cast member from the shared exit (issue #144)', () => {
    const findings = auditFinalizedProse({
      chapters: [{ chapterNumber: 67, content: '周叙把布铺在舵板上，指腹压下去。' }],
      castNames: ['周叙', '温珩'],
      blueprints: [{ chapterNumber: 67, title: '温珩按住了那一角布', keyEvents: '周叙读布角' }],
    })
    const title = findings.filter(finding => finding.stableFactKey.startsWith('chapter-title:unmet:'))
    expect(title).toHaveLength(1)
    expect(title[0]!.evidence).toContain('温珩')
  })

  /** issue #142：口头约定被复述反了，必须从共用出口报出来。 */
  it('surfaces a promise restated backwards from the shared exit (issue #142)', () => {
    const findings = auditFinalizedProse({
      chapters: [
        { chapterNumber: 60, content: '「答应我。座号不写进任何册。」周叙看着他。' },
        { chapterNumber: 63, content: '「一七四。」温珩说，「你答应过写进册。」' },
      ],
      castNames: [], blueprints: [],
    })
    const promise = findings.filter(finding => finding.stableFactKey.startsWith('promise:polarity:'))
    expect(promise).toHaveLength(1)
    expect(promise[0]!.evidence).toContain('不写进册')
  })

  /** issue #140：整句逐字复用必须从共用出口报出来。 */
  it('surfaces a whole sentence copied across chapters from the shared exit (issue #140)', () => {
    const findings = auditFinalizedProse({
      chapters: [
        { chapterNumber: 59, content: '周叙下舱核舱。周叙看了两息，指腹按进印泥，压在栏上。他往前走。' },
        { chapterNumber: 60, content: '船开了。周叙看了两息，指腹按进印泥，压在栏上。温珩在舵位上。' },
      ],
      castNames: [], blueprints: [],
    })
    const reuse = findings.filter(finding => finding.stableFactKey.startsWith('prose:sentence-reuse:'))
    expect(reuse).toHaveLength(1)
    expect(reuse[0]!.evidence).toContain('16 字逐字相同')
  })

  it('surfaces a gauge scale mismatch from the shared exit (issue #136)', () => {
    const findings = auditFinalizedProse({
      chapters: [
        { chapterNumber: 1, content: '眼睛落到吃水线的刻痕上，比空载时沉了半指。半指，八个人。' },
        { chapterNumber: 59, content: '船尾吃水刻痕没在水里，比空载时沉出一指。票三十二张。' },
      ],
      castNames: [], blueprints: [],
    })
    // ⚠️ 两处都用**绝对容量**形态（以空载为基准）：增量句（「多一个人」）按 issue #139
    // 不与容量可比，拿它会得到「不报」，测不出这条接线。
    const gauge = findings.filter(finding => finding.stableFactKey.startsWith('gauge:'))
    expect(gauge.length).toBeGreaterThan(0)
    expect(gauge.some(finding => finding.stableFactKey === 'gauge:scale-ratio:指')).toBe(true)
  })

  it('surfaces an inventory shortfall from the shared exit (issue #133)', () => {
    const findings = auditFinalizedProse({
      chapters: [
        { chapterNumber: 57, content: '清库名单。无编号薄本六册。靛蓝短褂一件。旧航次账抄件一册。' },
        { chapterNumber: 58, content: '三样东西码成一排：无编号薄本在左；靛蓝短褂在中；旧航次账抄件在右。' },
      ],
      castNames: [], blueprints: [],
    })
    const shortfall = findings.filter(finding => finding.stableFactKey.startsWith('inventory:shortfall:'))
    expect(shortfall).toHaveLength(1)
    expect(shortfall[0]!.evidence).toContain('合计 8 件')
  })

  it('surfaces a declared-but-unwritten day boundary from the shared exit (issue #132)', () => {
    const chapters = [
      { chapterNumber: 1, content: '回执摊在桌上，边角还带着潮气。' },
      { chapterNumber: 2, content: '缝里卡着册子边角，露半指宽。' },
      { chapterNumber: 3, content: '两日后，送检结案日。' },
    ]
    const blueprints = [
      { chapterNumber: 1, keyEvents: '核账。【时点：同日夜】' },
      { chapterNumber: 2, keyEvents: '翻册。【时点：次日天亮前至上午（紧接上一章，跨日）】' },
      { chapterNumber: 3, keyEvents: '送检。【时点：次日（送检结案日）上午】' },
    ]
    const findings = auditFinalizedProse({ chapters, castNames: [], blueprints })
    const unmet = findings.filter(finding => finding.stableFactKey.startsWith('chapter-time:anchor-unmet:'))
    // 只有第 2 章：第 1 章蓝图没声明跨日，第 3 章正文写了日界。
    expect(unmet.map(finding => finding.sourceChapter)).toEqual([2])
    expect(unmet[0]!.evidence).toContain('跨日')
  })

  it('stays silent on repetition with a 6-chapter sample, because the judge needs 8', () => {
    // 防回归：旧的写前预检只有 6 章样本，接上去就是一条永远不响的分支。
    const findings = auditFinalizedProse({
      chapters: stillnessBook().slice(-6), castNames: ['温珩'], blueprints: [],
      // 显式把窗口压回 6，模拟旧接线。
      repetitionWindow: 6,
    })
    expect(findings.some(finding => finding.stableFactKey.startsWith('prose:'))).toBe(false)
  })

  it('reports a closing label that contradicts the finalized ending (issue #65)', () => {
    const findings = auditFinalizedProse({
      chapters: [{ chapterNumber: 17, content: '温珩把箱子按紧了些，没有回头。' }],
      castNames: ['温珩'],
      blueprints: [{ chapterNumber: 17, keyEvents: '【收束：对话收束】温珩追上周叙。' }],
    })
    expect(findings.map(finding => finding.stableFactKey))
      .toContain('chapter-ending:label-mismatch:17')
  })

  it('reports a declared digit count that disagrees with the number (issue #47)', () => {
    const findings = auditFinalizedProse({
      chapters: [{ chapterNumber: 16, content: '存根上写着：编号五位，零三一七。' }],
      castNames: [], blueprints: [],
    })
    expect(findings.some(finding => finding.stableFactKey.startsWith('numbering:digits:16'))).toBe(true)
  })

  it('no longer judges ability exhaustion by rules — that moved to the model (issues #51 / #163)', () => {
    const findings = auditFinalizedProse({
      chapters: [{
        chapterNumber: 13,
        content: '这是最后一次溯读，本班次再读不出第二处。他按住存根，一行字浮出来。',
      }],
      castNames: [], blueprints: [],
    })
    // 「这句话是不是在说用尽」「这个动作算不算又成功用了一次」要读懂句子——
    // 旧实现靠 `EXHAUSTED_DECLARATION` + `SUCCESSFUL_USE` 两张词表，已下线。
    // 现在由 `ability-review.ts` 的第二类 `exhausted-then-reused`（作者主动触发）承接；
    // 这条断言钉住「规则侧不再自己冒出这一类」。
    expect(findings.some(finding => finding.stableFactKey.startsWith('ability-budget'))).toBe(false)
  })

  it('reports a promise whose target chapter never names it (issue #68)', () => {
    const findings = auditFinalizedProse({
      chapters: [{ chapterNumber: 15, content: '周叙把担保书叠好，按了手印。' }],
      castNames: [],
      blueprints: [{ chapterNumber: 14, foreshadowing: '埋下水隔边的新撬痕，留待第15章揭开。' }],
    })
    expect(findings.some(finding => finding.stableFactKey === 'foreshadowing:undelivered:14:15')).toBe(true)
  })

  it('clears the promise once the chapter names the thing in plain words', () => {
    // 与 #70 同一判据：正文按语义写出来即可，不必连原话抄一遍。
    const findings = auditFinalizedProse({
      chapters: [{ chapterNumber: 15, content: '舱底水隔边的新撬痕还在，边缘的木屑还是软的。' }],
      castNames: [],
      blueprints: [{ chapterNumber: 14, foreshadowing: '埋下水隔边的新撬痕，留待第15章揭开。' }],
    })
    expect(findings.some(finding => finding.stableFactKey.startsWith('foreshadowing:'))).toBe(false)
  })

  it('splits a conjunctive promise into atoms, so no unmatchable run-on fragment is produced (issue #83)', () => {
    // 报告原文的承诺剥掉引号后成了「水隔边的新撬痕与全叔那句」——那半句话正文里
    // 永远不会出现，于是整段拿去检索**必然**命不中，正文明明写了「撬痕」也照报。
    // 拆成原子后：「水隔边的新撬痕」可在正文命中，不再是无解的假阳性来源。
    expect(foreshadowingKeywords('埋下水隔边的新撬痕与全叔那句「这日子你碰不得」，留待第15章揭开。'))
      .toEqual(['水隔边的新撬痕', '全叔那句'])
    expect(auditFinalizedProse({
      chapters: [{ chapterNumber: 15, content: '舱底水隔边的新撬痕还在，边缘的木屑还是软的。' }],
      castNames: [],
      blueprints: [{ chapterNumber: 14, foreshadowing: '埋下水隔边的新撬痕与全叔那句「这日子你碰不得」，留待第15章揭开。' }],
    }).some(finding => finding.stableFactKey.startsWith('foreshadowing:'))).toBe(false)
  })

  it('does not relax to the head noun: a bare 撬痕 still does not clear the promise (issue #83)', () => {
    // 刻意的遗留限度，写进测试以免日后被当成 bug 改松：判据是「承诺的**锚点**
    // 能不能被检索到」，不是「这一章有没有沾到这件事」。放宽到词尾名词（撬痕／名字）
    // 会立刻产生**假阴性**——实测「名字」在 ch19–22 都出现，而那四章都没兑现
    // 「短褂头一行父亲的名字」这条承诺，放宽后它们的真问题会被压掉。
    expect(auditFinalizedProse({
      chapters: [{ chapterNumber: 15, content: '周叙把铜尺尖插进撬痕，往外一别。' }],
      castNames: [],
      blueprints: [{ chapterNumber: 14, foreshadowing: '埋下水隔边的新撬痕与全叔那句「这日子你碰不得」，留待第15章揭开。' }],
    }).some(finding => finding.stableFactKey.startsWith('foreshadowing:'))).toBe(true)
  })

  it('reports a run of chapters closing on ultimatums (issue #66)', () => {
    const findings = auditFinalizedProse({
      chapters: [
        { chapterNumber: 23, content: '“但你泡了，它就化了。”' },
        { chapterNumber: 24, content: '“不签，箱子当场扣下。今夜别想开船。”' },
        { chapterNumber: 25, content: '“那你今晚别下船。”' },
      ],
      castNames: [], blueprints: [],
    })
    expect(findings.some(finding => finding.stableFactKey.startsWith('chapter-ending:ultimatum-streak:'))).toBe(true)
  })

  it('reports a later chapter that reverses an earlier chapter’s assertion (issue #52)', () => {
    const findings = auditFinalizedProse({
      chapters: [
        { chapterNumber: 13, content: '笔压没抖一下，那是叶九的手。' },
        { chapterNumber: 19, content: '他看清了：这不是叶九的手。' },
      ],
      castNames: ['叶九'], blueprints: [],
    })
    expect(findings.some(finding => finding.stableFactKey.startsWith('assertion-reversal:'))).toBe(true)
  })

  it('labels findings with the chapter being written, not the audited one', () => {
    // 写前预检的语义是「过去这几章已经这样了，你正要写的那一章注意」。
    const findings = auditFinalizedProse({
      chapters: [{ chapterNumber: 16, content: '存根上写着：编号五位，零三一七。' }],
      castNames: [], blueprints: [],
    })
    // 编号问题的 sourceChapter 是**它自己那一章**（问题就在那一章里）。
    expect(findings.find(finding => finding.stableFactKey.startsWith('numbering:'))!.sourceChapter).toBe(16)
  })

  it('drops findings that carry no evidence, keeping the list author-actionable', () => {
    const findings = auditFinalizedProse({
      chapters: [{ chapterNumber: 1, content: '温珩站在梯口，赤脚，靛蓝短褂下摆还滴着水。' }],
      castNames: ['温珩'],
      blueprints: [{ chapterNumber: 1, keyEvents: '【收束：对话收束】' }],
    })
    // 无正文收束可判（内容与标注都在，但标注为「对话收束」而正文是叙述）→ 应报；
    // 这里只断言每条 finding 都带可定位的 evidence 与 stable key。
    expect(findings.every(finding => Boolean(finding.stableFactKey) && Boolean(finding.evidence))).toBe(true)
  })

  it('does not compare entrances far apart when building the audit', () => {
    const findings = auditFinalizedProse({
      chapters: [{ chapterNumber: 9, content: CH9 }, { chapterNumber: 40, content: CH10 }],
      castNames: ['温珩'], blueprints: [],
    })
    expect(findings.some(finding => finding.stableFactKey.startsWith('prose:'))).toBe(false)
  })
})