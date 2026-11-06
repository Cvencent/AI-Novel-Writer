import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { CONTENT_AXES, CONTENT_AXES_FOR_BUTTON, CONTENT_AXIS_GUIDANCE, buildContentReviewPrompt, contentReviewFindings, parseContentReview } from '../content-review'
import { blueprintSemanticGenerationContract } from '../blueprint-semantic-contract'

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

/**
 * issue #219：轴名原来要在**三处**各写一遍（`CONTENT_AXES` / `CONTENT_AXIS_GUIDANCE` /
 * 界面调用点硬编码数组），而没有任何守卫保证一致。漏在第三处的后果是**静默**的：
 * 那个轴永远不会被问、永远不会产出 finding，而代码与测试看起来全绿。
 *
 * 这一族在本仓已出过四次，都是「接口上手工对齐，必然漂」：
 *   #189 `firstFailedCheck` 的产出穿不过 IPC 白名单
 *   #200 `readRecovery` 缺 `parentRootActionId`
 *   #205 `pollUntilOrStall` 六个调用点漏传一个 `session`
 *   #219 本条
 *
 * 修法两层：① 调用点不再手写（引用 `CONTENT_AXES_FOR_BUTTON`，产品代码只认一处）；
 * ② 这条守卫钉住①②一致 + 调用点确实在用那个常量。
 */
describe('轴清单只有一处真源，且三处不许漂 (issue #219)', () => {
  it('CONTENT_AXES and CONTENT_AXIS_GUIDANCE cover exactly the same axes', () => {
    // 两张表必须同键：只加①②之一，会出现「能被问到但没有改法」或「有改法但问不到」。
    expect(Object.keys(CONTENT_AXIS_GUIDANCE).sort()).toEqual(Object.keys(CONTENT_AXES).sort())
  })

  it('the button asks for every axis, taken from the single exported list', () => {
    // 界面默认全问：清单 = CONTENT_AXES 的键（顺序也一致，便于人读日志）。
    expect([...CONTENT_AXES_FOR_BUTTON]).toEqual(Object.keys(CONTENT_AXES))
  })

  it('the call site references the constant instead of hardcoding the names', () => {
    // ⚠️ 这条是**结构守卫**：扫源码，确认调用点不再出现手写的轴名字面量。
    // 「守卫生效的证据是它曾经红过」——把调用点改回硬编码数组，这条会红。
    const source = readFileSync(join(__dirname, '..', '..', 'components', 'stage', 'write', 'WriteChapterPopover.tsx'), 'utf8')
    expect(source).toContain('CONTENT_AXES_FOR_BUTTON')
    for (const axis of Object.keys(CONTENT_AXES)) {
      expect(source, `调用点又手写了轴名「${axis}」`).not.toContain(`'${axis}'`)
    }
  })

  it('keeps the guard honest: the exported list is not empty', () => {
    // 防止「清单空了 → 上面几条空对比也全绿」。
    expect(CONTENT_AXES_FOR_BUTTON.length).toBeGreaterThanOrEqual(5)
  })
})

/**
 * issue #206：**本章把前文已经完整写过的一段事件又写了一遍**（同一组动作、同一段因果链），
 * 而且时间线倒回去了。
 *
 * 现场（ch28 → ch30，同一本 30 章的书）：
 * - ch28「拆墙是入冬后的事…**阿棠翻出那个布包**，问了一圈没人认，就拿木戳在废票根上乱压」
 *   → 收在「**多年后**各铺留印痕」；
 * - ch30「后墙砌完了。**泥水匠起那块翘起的旧船板，板缝里滑出一个布包**…没人认。
 *   周叙把案角的杂物拨开，**拆开布包**」→ 时间回到「封库那天」。
 *
 * 同一个布包被翻出两次，去向还不同（阿棠拿去学艺 / 周叙收进内襟），
 * 而 ch28 已经把时间推到多年后、ch30 又拉回当天（无闪回标记）。
 *
 * 机制在**蓝图层**：bp30 自己的 `keyEvents` 就写着「后墙砌完，泥水匠起翘船板，
 * 板缝掉出旧布包」——不是模型自由发挥，是章节骨架重叠。
 * 所以除了这一轴，`blueprintSemanticGenerationContract` 也补了「不得重演前几章蓝图排过的事件」。
 */
describe('content-overlap：本章重演了前文已收线的一段事件 (issue #206)', () => {
  const chapters = [
    { chapterNumber: 28, content: '拆墙是入冬后的事。阿棠翻出那个布包，问了一圈没人认，就拿木戳在废票根上乱压。多年后各铺手写簿的边角都留着深浅一致的印痕。' },
    { chapterNumber: 30, content: '后墙砌完了。泥水匠起那块翘起的旧船板，板缝里滑出一个布包，灰扑扑的，掉在碎石里，没人认。周叙把案角的杂物拨开，拆开布包。' },
  ]

  it('offers the axis as a question about a repeated causal chain, not as a prop list', () => {
    const { system } = buildContentReviewPrompt({ chapters, axes: ['content-overlap'], language: 'zh-CN' })
    expect(system).toContain('content-overlap')
    expect(system).toContain('前文已经完整写过的一段事件')
    expect(system).toContain('时间线还倒回去')
    // ⚠️ 不许出现本书的物件名（三次栽在这件事上，现在是固定检查项）。
    for (const term of ['布包', '船板', '木戳', '纸角']) {
      expect(system, `提示词不该出现「${term}」`).not.toContain(term)
    }
    const { user } = buildContentReviewPrompt({ chapters, axes: ['content-overlap'], language: 'zh-CN' })
    expect(user).toContain('布包')
  })

  it('accepts the axis and keeps the quote-verbatim rule', () => {
    const request = { chapters, axes: ['content-overlap'] as const }
    const good = JSON.stringify({ issues: [{
      chapterNumber: 30, axis: 'content-overlap',
      quote: '泥水匠起那块翘起的旧船板，板缝里滑出一个布包，灰扑扑的，掉在碎石里，没人认。',
      explanation: '第 28 章已写过同一个包裹被翻出并收在多年后，本章回到当天又翻出一次',
    }] })
    expect(parseContentReview(good, request)).toHaveLength(1)
    const bad = JSON.stringify({ issues: [{
      chapterNumber: 30, axis: 'content-overlap', quote: '这句不在正文里', explanation: 'x',
    }] })
    expect(parseContentReview(bad, request)).toEqual([])
  })

  it('asks to keep one pass and warns about the timeline and the fact ledger', () => {
    const [finding] = contentReviewFindings([{
      chapterNumber: 30, axis: 'content-overlap',
      quote: '泥水匠起那块翘起的旧船板，板缝里滑出一个布包，灰扑扑的，掉在碎石里，没人认。', explanation: '重演',
    }])
    expect(finding!.stableFactKey).toBe('prose:content-overlap:30')
    // 改法必须是这一轴专用：删一遍改承接 / 或把前文降级为预告。
    expect(finding!.suggestion.zhCN).toContain('删掉本章这一遍')
    expect(finding!.suggestion.zhCN).toContain('时间线')
    expect(finding!.suggestion.zhCN).toContain('事实账本')
    expect(finding!.suggestion.zhCN).not.toContain('换这一拍的落点')
  })
})

/**
 * issue #206 的**机制层**：bp30 的 `keyEvents` 自己就排了「泥水匠起船板、板缝掉出旧布包」。
 * 契约原来只禁「重演**已定稿章节**里写过的场景」——而撞的恰是**前几章的蓝图**。
 */
const buildBlueprintSemanticGenerationContractZh = () => blueprintSemanticGenerationContract('zh-CN')

describe('蓝图契约：不得重演前几章蓝图已排过的事件 (issue #206)', () => {
  it('forbids replaying an event another blueprint already scheduled', () => {
    const contract = buildBlueprintSemanticGenerationContractZh()
    expect(contract).toContain('也不得重演前几章蓝图')
    expect(contract).toContain('只能发生一次')
    // 「回到当天」这条要写明，否则模型不知道时间线也是判据的一部分。
    expect(contract).toContain('回到「当天」')
  })

  it('does not name this book’s props (no word lists in the contract either)', () => {
    const contract = buildBlueprintSemanticGenerationContractZh()
    for (const term of ['布包', '船板', '木戳']) {
      expect(contract, `契约不该出现「${term}」`).not.toContain(term)
    }
  })
})

/**
 * issue #194 / #193：同一件物**换了持有者或所在处**却没写交接。
 *
 * 两处现场是同一个判断类，所以**加宽已有轴**而不是新开一轴/一颗按钮
 * （issue 作者自己也写「我倾向加宽」，理由是本仓已有 12 颗「核对…」）：
 *
 * **#194（跨章）**：
 * ```
 * ch22 周叙从内衬摸出木戳。手指再探，夹出转印过刻名墨路的纸角…
 * ch23 压印的纸角随签收单归了货栈档。          ← 明确离开周叙、归了档
 * ch28 他从内衬里掏出三样：一枚木戳，一片转印过墨路的存根纸角…   ← 中间没有取回动作
 * ```
 * 与 #113（ch14 塞衬页 → 册子被收走 → ch17 又从内衬）是同一形状。
 *
 * **#193（章内）**：
 * ```
 * ch27 第 27 行「压到日头偏西，戳收回内衬。」
 *      第 39 行「戳递回去」（那是递回去让阿棠再试 = 借，不是交付）
 *      第 51 行「木戳不在内衬里了。」
 *      第 53 行「第二日照旧到石墩上坐着，戳在阿棠手里。」  ← 且他第二天还要压印
 * ```
 * 两处都被原来那句「**在几章之间**换了持有者或容器」挡在窗口外（一个跨章但形态不同、
 * 一个压根在章内）。
 */
describe('prop-moved 覆盖三种形状：章内换手、跨章复活、原持有者还要用它 (issue #194 / #193)', () => {
  const paperChapters = [
    { chapterNumber: 22, content: '周叙从内衬摸出木戳。手指再探，夹出转印过刻名墨路的纸角，边角发毛。纸角覆在签收单尾格的纸背上。' },
    { chapterNumber: 23, content: '压印的纸角随签收单归了货栈档。' },
    { chapterNumber: 28, content: '他从内衬里掏出三样：一枚木戳，一片转印过墨路的存根纸角，一截侧面刻着旧名、被手汗磨圆的船牌。' },
  ]

  it('tells the model that the cross-chapter shape counts even when it is not "changed container"', () => {
    const { system } = buildContentReviewPrompt({ chapters: paperChapters, axes: ['prop-moved'], language: 'zh-CN' })
    expect(system).toContain('prop-moved')
    // 跨章那一支：交出/归档/封存之后又从原持有者身上取出
    expect(system).toContain('归到某处之后')
    expect(system).toContain('没有取回动作')
  })

  it('covers the in-chapter shape and says a borrow is not a handover', () => {
    const { system } = buildContentReviewPrompt({ chapters: paperChapters, axes: ['prop-moved'], language: 'zh-CN' })
    // 章内那一支：原来完全不在取数口径里（「在几章之间」）。
    expect(system).toContain('同一章之内')
    expect(system).toContain('借用')
    expect(system).toContain('交付')
  })

  it('covers the logical break where the original holder still needs it', () => {
    const { system } = buildContentReviewPrompt({ chapters: paperChapters, axes: ['prop-moved'], language: 'zh-CN' })
    // #193 的功能冲突：他第二天还要压印，而戳在别人手里。
    expect(system).toContain('离了它做不成的事')
    expect(system).toContain('逻辑断裂')
  })

  it('does not name this book’s props (fixed checklist item since #209/#213/#208/#206)', () => {
    const { system, user } = buildContentReviewPrompt({ chapters: paperChapters, axes: ['prop-moved'], language: 'zh-CN' })
    for (const term of ['纸角', '木戳', '内衬', '货栈档', '船牌']) {
      expect(system, `提示词不该出现「${term}」`).not.toContain(term)
    }
    // 原文照喂（那是样本）。
    expect(user).toContain('纸角')
  })

  it('keeps both quotes verbatim for both shapes', () => {
    const request = { chapters: paperChapters, axes: ['prop-moved'] as const }
    const crossChapter = JSON.stringify({ issues: [{
      chapterNumber: 28, axis: 'prop-moved',
      quote: '他从内衬里掏出三样：一枚木戳，一片转印过墨路的存根纸角，一截侧面刻着旧名、被手汗磨圆的船牌。',
      explanation: '第 23 章纸角已随签收单归了货栈档，本章又从内衬掏出，中间没有取回动作',
    }] })
    expect(parseContentReview(crossChapter, request)).toHaveLength(1)

    const inChapter = JSON.stringify({ issues: [{
      chapterNumber: 27, axis: 'prop-moved',
      quote: '木戳不在内衬里了。',
      explanation: '同一章前面写「戳收回内衬」，这里内衬已经空了，中间只有「戳递回去」这次借用',
    }] })
    expect(parseContentReview(inChapter, { chapters: [{ chapterNumber: 27, content: '压到日头偏西，戳收回内衬。\n\n戳递回去。\n\n木戳不在内衬里了。' }], axes: ['prop-moved'] }))
      .toHaveLength(1)
  })

  it('tells the author a borrow is not a handover, and that a logical break needs more than a sentence', () => {
    const [finding] = contentReviewFindings([{
      chapterNumber: 27, axis: 'prop-moved', quote: '木戳不在内衬里了。', explanation: '章内换手',
    }])
    expect(finding!.suggestion.zhCN).toContain('不是交接')
    expect(finding!.suggestion.zhCN).toContain('留在谁那里')
    expect(finding!.suggestion.zhCN).toContain('逻辑断裂')
  })
})

/**
 * issue #190 / #191：与 #194/#193 是**同一族**（物件的状态/所在处变了却没写那一次动作），
 * 所以继续**加宽 `prop-moved`**，不新开轴：
 *
 * **#190（封存状态）**：ch63 便条当场验完「压回箱盖」，同章收尾「箱盖合上，封条按下去」
 * （那是送检箱）→ ch84 同一张纸从柯明远的**公文包**里被当随身物清点出来
 * （「一张窄纸条压上桌面，边角起毛，上头三个数，墨色深浅不一」），中间 20 章没有启封。
 *
 * **#191（固定存放点被整体搬动）**：ch78「私柜靠墙」、ch82「办公楼墙边，私柜挂着一把锁」、
 * ch84「历年签字底单在**我私柜里**」→ ch85「**私柜是两个人抬进来的**」，
 * 一夜之间到了正厅，全书没有一句搬运动作。
 */
describe('prop-moved 再扩两档：封存后未经启封出现 / 固定存放点被搬动 (issue #190 / #191)', () => {
  const sealChapters = [
    { chapterNumber: 63, content: '周叙把便条翻个面，压回箱盖。柯明远在箱盖四边刷了一遭，浆糊水汽在封条底下洇开一线。箱盖合上，封条按下去。' },
    { chapterNumber: 84, content: '公文包打开。一张窄纸条压上桌面，边角起毛，上头三个数，墨色深浅不一。「誊封时抄的座号。」柯明远说。' },
  ]
  const cabinetChapters = [
    { chapterNumber: 78, content: '盒子进了私柜。钥匙在锁孔里转了一圈，铜扣按紧。私柜靠墙。柯明远的手在锁上压着，没挪开。' },
    { chapterNumber: 82, content: '办公楼墙边，私柜挂着一把锁，没锁死。柜门拉开，铜墨盒不在。' },
    { chapterNumber: 85, content: '铜碰木头，磕了一声。「历年签字底单。全部。」私柜是两个人抬进来的。柜门拉开，底单一沓一沓摊上桌。' },
  ]

  it('adds the sealed-state shape and says a new explanation is not a retrieval', () => {
    const { system } = buildContentReviewPrompt({ chapters: sealChapters, axes: ['prop-moved'], language: 'zh-CN' })
    expect(system).toContain('未经启封')
    expect(system).toContain('送检送出')
    // 建议里要挡掉「换个说法解释来源」这条假出路。
    const [finding] = contentReviewFindings([{ chapterNumber: 84, axis: 'prop-moved', quote: '一张窄纸条压上桌面', explanation: '封存后又出现' }])
    expect(finding!.suggestion.zhCN).toContain('启封')
    expect(finding!.suggestion.zhCN).toContain('不算交代')
  })

  it('adds the moved-fixed-place shape and offers the "walk to it" alternative', () => {
    const { system } = buildContentReviewPrompt({ chapters: cabinetChapters, axes: ['prop-moved'], language: 'zh-CN' })
    expect(system).toContain('固定存放点')
    expect(system).toContain('靠某面墙')
    expect(system).toContain('谁搬的、几人抬的')
    // 改法要给两条出路：补搬运动作，或改成「人走到柜子跟前」。
    const [finding] = contentReviewFindings([{ chapterNumber: 85, axis: 'prop-moved', quote: '私柜是两个人抬进来的。', explanation: '柜子整体换了房间' }])
    expect(finding!.suggestion.zhCN).toContain('搬运动作')
    expect(finding!.suggestion.zhCN).toContain('人走到柜子跟前')
  })

  it('does not name this book’s props (fixed checklist item)', () => {
    const { system, user } = buildContentReviewPrompt({ chapters: sealChapters, axes: ['prop-moved'], language: 'zh-CN' })
    for (const term of ['便条', '私柜', '公文包', '封条', '窄纸条']) {
      expect(system, `提示词不该出现「${term}」`).not.toContain(term)
    }
    expect(user).toContain('便条')
  })

  it('counts five shapes now, and names them in both languages', () => {
    const zh = buildContentReviewPrompt({ chapters: sealChapters, axes: ['prop-moved'], language: 'zh-CN' }).system
    expect(zh).toContain('五种形状')
    const en = buildContentReviewPrompt({ chapters: sealChapters, axes: ['prop-moved'], language: 'en-US' }).system
    expect(en).toContain('Five shapes')
    expect(en).toContain('sealed state')
  })
})

/**
 * ⚠️ 我在本轮踩到的一个**静默陷阱**：`CONTENT_AXES[axis]` 是 `[中文, 英文]` 二元组，
 * 而提示词与 finding 只读 **`[0]` / `[1]`**。我一开始把新形状写成
 * `'前半句'\n + '后半句'`（数组的第三个元素），**提示词里一个字都看不到，测试也不报**
 * ——「加了但永远问不到」的第二形态（#219 修的是清单漏轴，这个是**轴里漏内容**）。
 *
 * 所以这里钉住：**每条轴的每一种语言都是一个字符串**，元素数恰好 2。
 */
describe('轴描述必须是「中文 + 英文」两个整串，不许靠数组追加 (本轮踩到的静默陷阱)', () => {
  it('every axis has exactly two elements, both non-empty strings', () => {
    for (const [axis, value] of Object.entries(CONTENT_AXES)) {
      expect(Array.isArray(value), `${axis} 应写成 [中文, 英文]`).toBe(true)
      expect((value as readonly string[]).length, `${axis} 应恰好 2 个元素（多写的会被静默丢弃）`).toBe(2)
      for (const text of value as readonly string[]) {
        expect(typeof text).toBe('string')
        expect(text.trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('renders the whole description into the prompt, including its later clauses', () => {
    // issue #190/#191 的内容在**同一条描述的后半段**：若有人把它拆成数组第二项，
    // 这段断言会红（这正是我本轮踩的坑）。
    const { system } = buildContentReviewPrompt({
      chapters: [{ chapterNumber: 1, content: '正文。' }], axes: ['prop-moved'], language: 'zh-CN',
    })
    const line = system.split('\n').find(item => item.includes('prop-moved'))!
    expect(line).toContain('未经启封')
    expect(line).toContain('固定存放点')
    expect(line).toContain('谁搬的、几人抬的')
  })

  it('keeps the guidance table free of the same trap (each axis has one problem + one fix per language)', () => {
    for (const [axis, guide] of Object.entries(CONTENT_AXIS_GUIDANCE)) {
      expect((guide as { problem: readonly string[] }).problem.length, `${axis} problem`).toBe(2)
      expect((guide as { fix: readonly string[] }).fix.length, `${axis} fix`).toBe(2)
    }
  })
})

/**
 * issue #231：贯穿全书的「待核栏第三格」（前 40 章一直写着周叙的名字），
 * 第 101 章突然写成「父亲给徐汐留的活人空位」——同一格位被改了归属，
 * 正文没有一句把两次说法接起来，错值还进了事实账本。
 * 新轴 `reassigned-slot` 交模型判（「这句话在说哪个格位」「归属是否互斥」都是内容判断）；
 * 起草合同同步补【有主格位不得换主人】通用约束（修法③）。
 */
describe('reassigned-slot 轴 (issue #231)', () => {
  it('asks the model about slot ownership in both languages', () => {
    const { system } = buildContentReviewPrompt({
      chapters: [{ chapterNumber: 101, content: '正文。' }], axes: ['reassigned-slot'], language: 'zh-CN',
    })
    expect(system).toContain('reassigned-slot')
    expect(system).toContain('格位/名额')
    expect(system).toContain('两种归属互斥')
    expect(system).toContain('没有「改留」「转让」「除名」这类被写出来的改变动作')
    const en = buildContentReviewPrompt({
      chapters: [{ chapterNumber: 101, content: 'text.' }], axes: ['reassigned-slot'], language: 'en-US',
    }).system
    expect(en).toContain('OWNERSHIP of a named slot')
    expect(en).toContain('no line writes the change')
  })

  it('carries the axis into guidance with its own problem and fix', () => {
    const guide = CONTENT_AXIS_GUIDANCE['reassigned-slot']
    expect(guide.problem[0]).toContain('格位/名额')
    expect(guide.fix[0]).toContain('二选一')
    expect(guide.fix[0]).toContain('事实账本')
    expect(guide.fix[1]).toContain('fact ledger')
  })

  it('is asked by the review button (axes catalogue covers it)', () => {
    expect([...CONTENT_AXES_FOR_BUTTON]).toContain('reassigned-slot')
  })
})
