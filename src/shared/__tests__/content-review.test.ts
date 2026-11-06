import { describe, expect, it } from 'vitest'

import { CONTENT_AXES, buildContentReviewPrompt, contentReviewFindings, parseContentReview } from '../content-review'

const CHAPTERS = [
  { chapterNumber: 3, content: '他蹲下来，把风灯搁在膝盖边。纸角在衬页里没了。' },
  { chapterNumber: 7, content: '他蹲下去，风灯放在膝上。册子被收走。' },
]
const request = { chapters: CHAPTERS, axes: ['repeated-reaction', 'prop-terminal'] as const, language: 'zh-CN' as const }

/**
 * 几族「重复写法 / 道具链 / 陈旧时长」判据改由模型判断（用户 2026-11-05）。
 *
 * 旧实现靠 `POSTURE_PHRASES = ['蹲','俯身',…]`、`TERMINAL_ACTIONS = ['解开','烧掉',…]`
 * 这类题材动词表——用户明确否掉：「不能去设计词表，也不能用任何的短语匹配」。
 */
describe('buildContentReviewPrompt', () => {
  it('describes each axis as a phenomenon, not as a word list', () => {
    const { system } = buildContentReviewPrompt(request)
    expect(system).toContain(CONTENT_AXES['repeated-reaction'][0])
    expect(system).toContain(CONTENT_AXES['prop-terminal'][0])
    // 轴名里不许出现题材词（那只是「问什么」，不是「按什么词找」）。
    for (const [zh] of Object.values(CONTENT_AXES)) expect(zh).not.toContain('蹲|俯身')
  })

  it('judges by meaning and requires a verbatim quote', () => {
    const { system } = buildContentReviewPrompt(request)
    expect(system).toContain('按**意思**判断')
    expect(system).toContain('同一个问题换措辞写仍然算')
    expect(system).toContain('逐字引用')
  })

  it('only asks the axes the caller selected', () => {
    const { system } = buildContentReviewPrompt(request)
    expect(system).not.toContain(CONTENT_AXES['stale-duration'][0])
  })
})

describe('parseContentReview', () => {
  const raw = (issues: unknown) => JSON.stringify({ issues })

  it('accepts an issue with a known axis and a locatable quote', () => {
    expect(parseContentReview(raw([{
      chapterNumber: 7, axis: 'repeated-reaction', quote: '他蹲下去，风灯放在膝上。', explanation: '同一个起手动作。',
    }]), request)).toEqual([{
      chapterNumber: 7, axis: 'repeated-reaction', quote: '他蹲下去，风灯放在膝上。', explanation: '同一个起手动作。',
    }])
  })

  it('drops an axis the caller did not ask about', () => {
    expect(parseContentReview(raw([{
      chapterNumber: 7, axis: 'stale-duration', quote: '他蹲下去，风灯放在膝上。', explanation: 'x',
    }]), request)).toEqual([])
  })

  it('drops a quote that is not verbatim in that chapter', () => {
    expect(parseContentReview(raw([{
      chapterNumber: 7, axis: 'repeated-reaction', quote: '他蹲在膝边。', explanation: 'x',
    }]), request)).toEqual([])
    // 引文在另一章里也不算（章号必须对）。
    expect(parseContentReview(raw([{
      chapterNumber: 3, axis: 'repeated-reaction', quote: '他蹲下去，风灯放在膝上。', explanation: 'x',
    }]), request)).toEqual([])
  })

  it('rejects malformed output, accepts an empty answer', () => {
    expect(parseContentReview('不是 JSON', request)).toBeNull()
    expect(parseContentReview('{"issues":{}}', request)).toBeNull()
    expect(parseContentReview(raw([]), request)).toEqual([])
  })
})

describe('contentReviewFindings', () => {
  it('keys on axis and chapter', () => {
    const [finding] = contentReviewFindings([{
      chapterNumber: 7, axis: 'prop-terminal', quote: '册子被收走。', explanation: 'e',
    }])
    expect(finding!.stableFactKey).toBe('prose:prop-terminal:7')
    expect(finding!.severity).toBe('warning')
  })
})

/**
 * issue #164：同章同轴的两条必须**合并成一条**，而不是同 key 的两条。
 *
 * 原本 key 只含 `轴 + 章号`，而提示词允许「每类最多 3 条」→ 第 1、2 条同 key：
 * React 列表复用错节点、**ack 按 key 精确匹配会把没修的那条一起静默掉**、
 * `findingByKey` 只留最后一条（#120 的标题错配）。
 */
describe('同章同轴的合并 (issue #164)', () => {
  it('merges two quotes on the same axis into one finding, keeping both as evidence', () => {
    const findings = contentReviewFindings([
      { chapterNumber: 7, axis: 'repeated-reaction', quote: '他蹲下去。', explanation: '同一个起手动作' },
      { chapterNumber: 7, axis: 'repeated-reaction', quote: '他把风灯搁在膝上。', explanation: '同一个落手动作' },
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0]!.stableFactKey).toBe('prose:repeated-reaction:7')
    // 两句都要出现在证据里，否则作者只看到一半。
    expect(findings[0]!.evidence).toContain('他蹲下去')
    expect(findings[0]!.evidence).toContain('他把风灯搁在膝上')
    expect(findings[0]!.evidence).toContain('2 处')
  })

  it('keeps different axes and different chapters separate', () => {
    const findings = contentReviewFindings([
      { chapterNumber: 7, axis: 'repeated-reaction', quote: 'a', explanation: '' },
      { chapterNumber: 7, axis: 'prop-terminal', quote: 'b', explanation: '' },
      { chapterNumber: 8, axis: 'repeated-reaction', quote: 'c', explanation: '' },
    ])
    expect(findings.map(item => item.stableFactKey)).toEqual([
      'prose:repeated-reaction:7', 'prose:prop-terminal:7', 'prose:repeated-reaction:8',
    ])
  })

  it('every emitted key is unique — the exit guard’s invariant', () => {
    const findings = contentReviewFindings([
      { chapterNumber: 7, axis: 'repeated-reaction', quote: 'a', explanation: '' },
      { chapterNumber: 7, axis: 'repeated-reaction', quote: 'b', explanation: '' },
      { chapterNumber: 7, axis: 'repeated-reaction', quote: 'c', explanation: '' },
    ])
    expect(new Set(findings.map(item => item.stableFactKey)).size).toBe(findings.length)
  })
})

/**
 * issue #185：一次调用返回 5 条、覆盖 3 个不同的轴，而**建议与解释逐字相同**。
 *
 * 那句「换这一拍的落点」对 `repeated-reaction` / `repeated-device` 成立，
 * 对 `prop-terminal`（该删一次终结）/ `prop-moved`（该补交接动作）/
 * `stale-duration`（该统一时长）**根本讲不通**：作者照字面做，
 * 会把「铜墨盒昨夜已交稽核组封存」换成另一句话，而真正缺的是那次交接动作。
 *
 * 另外轴名原来只在「来源」行的括号里，正文里完全没有 —— 作者看到 5 条一样的建议时无从分辨。
 */
describe('按轴给建议与解释 (issue #185)', () => {
  const issue = (axis: any, chapterNumber = 83) => ({
    chapterNumber, axis, quote: `第${chapterNumber}章的某一句。`, explanation: '模型的一句话',
  })

  const suggestionsOf = (axis: any) => contentReviewFindings([issue(axis)] as never)[0]!.suggestion.zhCN

  it('gives prop-moved the handover fix, not the "change the beat" fix', () => {
    const text = suggestionsOf('prop-moved')
    expect(text).toContain('交接')
    expect(text).not.toContain('换这一拍的落点')
  })

  it('gives prop-terminal the delete/explain fix', () => {
    const text = suggestionsOf('prop-terminal')
    expect(text).toContain('删掉')
    expect(text).not.toContain('换这一拍的落点')
  })

  it('gives stale-duration the unify-the-duration fix', () => {
    const text = suggestionsOf('stale-duration')
    expect(text).toContain('统一')
    expect(text).not.toContain('换这一拍的落点')
  })

  it('keeps the "change the beat" fix for the two repeated-* axes', () => {
    expect(suggestionsOf('repeated-reaction')).toContain('换这一拍的落点')
    expect(suggestionsOf('repeated-device')).toContain('开场装置')
  })

  it('five findings on five axes no longer share one suggestion string', () => {
    const axes = ['repeated-reaction', 'repeated-device', 'prop-terminal', 'prop-moved', 'stale-duration'] as const
    const texts = axes.map(axis => contentReviewFindings([issue(axis)] as never)[0]!.suggestion.zhCN)
    expect(new Set(texts).size).toBe(5)
  })

  it('names the axis inside the card text, not only in the source line', () => {
    // issue #185 建议 ③：作者要能一眼看出「这条是「道具换手没交接」还是「同一状态两个时长」」。
    const [finding] = contentReviewFindings([issue('stale-duration')] as never)
    expect(finding!.issue.zhCN).toContain('同一处状态')
    expect(finding!.issue.enUS).toContain('incompatible durations')
    // 解释串也按轴取：这句「读者读到的是流程」不该出现在 stale-duration 上。
    expect(finding!.issue.zhCN).not.toContain('读者读到的是流程')
  })

  it('keeps the per-chapter+axis key so acknowledgement stays exact', () => {
    const [finding] = contentReviewFindings([issue('prop-moved', 82)] as never)
    expect(finding!.stableFactKey).toBe('prose:prop-moved:82')
  })
})

/**
 * issue #213：同一个人（或同一件东西）在相邻章之间换了提称，而**没有一句把两个接起来**。
 *
 * 现场（第 91 → 92 章，同一个经办人）：
 * - ch91「一个套蓝布袖套的中年人才夹着薄册过来」「**袖套**翻开册子」「**袖套**抽出第三格页，
 *   连同存根联塞进牛皮复核袋」（这一章一律叫「袖套」，共 7 次）
 * - ch92「桌另一头，**管流程册的经办**把笔搁下」「**经办**出去了一趟…腋下夹着牛皮复核袋」
 * - ch94 还是「经办」（手里的薄册与第 91 章那本对得上）
 *
 * 「袖套」全书 7 次全在第 91 章，「经办」在 91 章只出现 1 次（就是问路那句）；
 * 全书没有一句桥接。而**谁封的袋、谁开的袋**正是这条主线的支点 ——
 * 读者认不出是同一个人，整段推理就变成流水账。
 *
 * ⚠️ 与 `cast-name-drift`（#102，陆敬堂/穆敬堂，一字之差）不同：那条是**字形相近**、
 * 纯结构可判；本条是两个**完全不同的提称**（职务名 vs 衣着代称），
 * 只能靠读懂「这两处说的是不是同一个人」——所以交模型，不写词表。
 */
describe('appellation-unbridged：换了提称却没有桥接 (issue #213)', () => {
  const bagChapters = [
    { chapterNumber: 90, content: '周叙在「结案过程无异议」确认书上按下拇指。' },
    { chapterNumber: 91, content: '一个套蓝布袖套的中年人才夹着薄册过来。袖套翻开册子。袖套抽出第三格页，连同存根联塞进牛皮复核袋。' },
    { chapterNumber: 92, content: '桌另一头，管流程册的经办把笔搁下。经办出去了一趟，腋下夹着牛皮复核袋。' },
  ]

  it('offers the axis to the model, described as a question and not as a list of titles', () => {
    const { system } = buildContentReviewPrompt({ chapters: bagChapters, axes: ['appellation-unbridged'], language: 'zh-CN' })
    expect(system).toContain('appellation-unbridged')
    expect(system).toContain('没有一句把两个提称接起来')
    // ⚠️ 不许出现本书的提称 —— 那等于把这本书编进代码。
    for (const term of ['袖套', '经办', '灰褂', '薄册']) {
      expect(system, `提示词不该出现「${term}」`).not.toContain(term)
    }
  })

  it('accepts the axis and keeps the quote-verbatim rule', () => {
    const request = { chapters: bagChapters, axes: ['appellation-unbridged'] as const }
    const good = JSON.stringify({ issues: [{
      chapterNumber: 92, axis: 'appellation-unbridged', quote: '管流程册的经办把笔搁下', explanation: '两章说的是同一个经办人，但没有一句把两个提称接起来',
    }] })
    expect(parseContentReview(good, request)).toHaveLength(1)
    // 引文对不上 → 整条丢弃。
    const bad = JSON.stringify({ issues: [{
      chapterNumber: 92, axis: 'appellation-unbridged', quote: '这句不在正文里', explanation: 'x',
    }] })
    expect(parseContentReview(bad, request)).toEqual([])
  })

  it('asks for a bridging line or a single label — and says not to fix only one of the two', () => {
    const [finding] = contentReviewFindings([{
      chapterNumber: 92, axis: 'appellation-unbridged', quote: '管流程册的经办把笔搁下',
      explanation: '两章是同一个经办人，中间没有桥接',
    }])
    expect(finding!.stableFactKey).toBe('prose:appellation-unbridged:92')
    // 轴名要写进正文（#185）：作者一眼看出这是哪一类。
    expect(finding!.issue.zhCN).toContain('提称')
    expect(finding!.suggestion.zhCN).toContain('补一句桥接')
    expect(finding!.suggestion.zhCN).toContain('不要只改其中一处')
  })

  it('keeps the guidance per-axis so this one is not worded like a repeated-move fix', () => {
    const [finding] = contentReviewFindings([{
      chapterNumber: 92, axis: 'appellation-unbridged', quote: '管流程册的经办把笔搁下', explanation: '',
    }])
    // #185 的教训：五轴共用一句建议时，改法对不上这一轴。这里必须是「统一称呼/补桥接」。
    expect(finding!.suggestion.zhCN).not.toContain('换这一拍的落点')
    expect(finding!.suggestion.zhCN).toContain('统一成一个称呼')
  })
})

/**
 * issue #208 / #199：前文已确立的**身份、资格或认知**被本章无声推翻。
 *
 * 两处现场（同一个判断类）：
 *
 * **#208（官方登记状态）**：ch87 温珩当着人「笔尖落在册页上。温珩两个字进了名」，
 * ch91 他凭「在册船员」的身份在联名栏按印（经办刚用「一格一案」拒掉另一张申请，说明他是核过资格的）；
 * ch92 却被廊下杂役一句「**在册的进**」拦住。全书「除名/撤名/注销/出册」**0 次**
 * ——中间没有任何一句交代身份变了。
 *
 * **#199（人物认知）**：ch26–28 阿棠是「铺口带了个年轻散工」、跟周叙学过压印、还拿走过木戳；
 * ch29 掌柜「**这谁？**」+ 伙计摇头 + 落笔写「杂」。前四章把他立住了，本章当陌生人。
 *
 * ⚠️ 为什么原来一层都没抓到：角色卡没有「名册/身份」字段（`characters` 表无此列），
 * `cast:absent` 判的是「该出场却没出场」（这里他出场了），
 * `memory-anchor` 判的是「回指没有前文锚点」（这里是**反向**：有锚点却当没有）。
 * 而「这一章说的和前文是不是同一回事」本来就是内容判断 → 交模型。
 */
describe('established-status-reset：已确立的身份／资格被无声推翻 (issue #208 / #199)', () => {
  const rosterChapters = [
    { chapterNumber: 87, content: '灰褂把名册摊上桌面。「温珩。入册，谁担保。」笔尖落在册页上。温珩两个字进了名。' },
    { chapterNumber: 91, content: '袖套翻开册子。「第三格页单独留册，得两名在册船员联名。验实物。」温珩上前，拇指按下去。' },
    { chapterNumber: 92, content: '廊下杂役扫了温珩一眼。「在册的进。」手横在门框前。温珩停了脚。' },
  ]

  it('offers the axis to the model as a question, not as a list of institutional words', () => {
    const { system } = buildContentReviewPrompt({ chapters: rosterChapters, axes: ['established-status-reset'], language: 'zh-CN' })
    expect(system).toContain('established-status-reset')
    expect(system).toContain('身份、资格或认知')
    expect(system).toContain('没有任何一句交代这个变化')
    // ⚠️ 不许出现本书的身份词 —— 那等于把这本书编进代码（#209 第一版就栽在这里）。
    for (const term of ['在册', '除名', '名册', '散工', '拦在廊下']) {
      expect(system, `提示词不该出现「${term}」`).not.toContain(term)
    }
    // 原文当然要喂（那是样本）。
    const { user } = buildContentReviewPrompt({ chapters: rosterChapters, axes: ['established-status-reset'], language: 'zh-CN' })
    expect(user).toContain('在册')
  })

  it('covers the recognition case in the same axis rather than a second one', () => {
    // #199（没人认识 vs 前四章认识）与 #208 是同一个判断类：前文立住了、本章推翻。
    const { system } = buildContentReviewPrompt({ chapters: rosterChapters, axes: ['established-status-reset'], language: 'zh-CN' })
    expect(system).toContain('被认识')
    expect(system).toContain('没人认识')
    // 不新开轴（用户定规：同类判断合并成一档）。
    expect(Object.keys(CONTENT_AXES)).toContain('established-status-reset')
  })

  it('accepts the axis and keeps the quote-verbatim rule', () => {
    const request = { chapters: rosterChapters, axes: ['established-status-reset'] as const }
    const good = JSON.stringify({ issues: [{
      chapterNumber: 92, axis: 'established-status-reset', quote: '「在册的进。」手横在门框前。',
      explanation: '第 87 章他已入册、第 91 章还凭在册身份按了印，本章却被当作未在册拦下，中间没有除名交代',
    }] })
    expect(parseContentReview(good, request)).toHaveLength(1)
    const bad = JSON.stringify({ issues: [{
      chapterNumber: 92, axis: 'established-status-reset', quote: '这句不在正文里', explanation: 'x',
    }] })
    expect(parseContentReview(bad, request)).toEqual([])
  })

  it('asks to account for the change on the page, and warns about the fact ledger', () => {
    const [finding] = contentReviewFindings([{
      chapterNumber: 92, axis: 'established-status-reset', quote: '「在册的进。」手横在门框前。',
      explanation: '前文已入册，本章被当未在册',
    }])
    expect(finding!.stableFactKey).toBe('prose:established-status-reset:92')
    expect(finding!.suggestion.zhCN).toContain('补一句交代')
    expect(finding!.suggestion.zhCN).toContain('事实账本')
    // 改法必须是这一轴专用的，不能复用 repeated-* 那句「换这一拍的落点」（#185 的教训）。
    expect(finding!.suggestion.zhCN).not.toContain('换这一拍的落点')
  })
})
