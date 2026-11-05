import { describe, expect, it } from 'vitest'

import {
  MEMORY_ANCHOR_MAX_EARLIER_CHARS,
  MEMORY_ANCHOR_TARGET_CHAPTERS,
  buildMemoryAnchorPrompt,
  memoryAnchorFindings,
  memoryCallbackSentences,
  parseMemoryAnchorReview,
} from '../memory-anchor-review'

const EARLIER = [
  { chapterNumber: 76, content: '温珩蹲着收网，把纸压回夹层。「我带她走。」' },
  { chapterNumber: 77, content: '周叙把灯换回右手。棚口空着。' },
]
const CURRENT = [{ chapterNumber: 78, content: '他记得渔棚里的灯，记得温珩摆手让他别停。中间那一句，不在了。' }]
const request = { chapters: CURRENT, earlierChapters: EARLIER, language: 'zh-CN' as const }

/**
 * issue #167：记忆回指必须有前文锚点。
 *
 * 现场：第 78 章「他记得渔棚里的灯，记得温珩**摆手让他别停**」——而全书 78 章里
 * 「摆手」「别停」只出现这一次。同族 12 条带「具名角色 + 动作」的回忆里，
 * 11 条都有锚点，只有这一条没有。审稿 17 维没有这一条，账本还把它当 plot 收进去。
 */
describe('memoryCallbackSentences', () => {
  it('picks sentences that remember something', () => {
    const found = memoryCallbackSentences(78, CURRENT[0]!.content)
    expect(found).toHaveLength(1)
    expect(found[0]!.sentence).toContain('摆手')
  })

  it('does not pick a plain narration without a memory verb', () => {
    expect(memoryCallbackSentences(77, '周叙把灯换回右手。棚口空着。')).toEqual([])
  })
})

describe('buildMemoryAnchorPrompt', () => {
  it('hands the remembering sentences and the earlier chapters to the model', () => {
    const { user } = buildMemoryAnchorPrompt(request)
    expect(user).toContain('摆手让他别停')
    expect(user).toContain('第77章')
    expect(user).toContain('蹲着收网')
  })

  it('tells the model to judge by meaning, and that a paraphrase counts as found', () => {
    const { system } = buildMemoryAnchorPrompt(request)
    expect(system).toContain('按意思判断')
    expect(system).toContain('换了措辞')
  })

  it('warns against false alarms, because they send the author hunting an existing scene', () => {
    expect(buildMemoryAnchorPrompt(request).system).toContain('不确定就不要报')
  })

  it('caps how much earlier text is sent and says so', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      chapterNumber: index + 1, content: '长'.repeat(MEMORY_ANCHOR_MAX_EARLIER_CHARS / 12),
    }))
    const { user } = buildMemoryAnchorPrompt({ ...request, earlierChapters: many })
    expect(user).toContain('未提供')
  })
})

describe('parseMemoryAnchorReview', () => {
  const raw = (issues: unknown) => JSON.stringify({ issues })

  it('accepts a report whose quote is verbatim in that chapter', () => {
    const hits = parseMemoryAnchorReview(raw([{
      chapterNumber: 78, quote: '他记得渔棚里的灯，记得温珩摆手让他别停。',
      missingAnchor: '温珩摆手让他别停', explanation: '前文温珩在收网，没有摆手。',
    }]), request)
    expect(hits).toHaveLength(1)
    expect(hits![0]!.missingAnchor).toContain('摆手')
  })

  it('drops a report whose quote cannot be located', () => {
    expect(parseMemoryAnchorReview(raw([{
      chapterNumber: 78, quote: '他记得温珩摆手。', missingAnchor: 'x', explanation: 'e',
    }]), request)).toEqual([])
  })

  it('drops a report that does not say what is missing', () => {
    // 没说出缺什么 = 等于没报，作者无从核对。
    expect(parseMemoryAnchorReview(raw([{
      chapterNumber: 78, quote: '他记得渔棚里的灯，记得温珩摆手让他别停。', missingAnchor: '  ', explanation: 'e',
    }]), request)).toEqual([])
  })

  it('rejects malformed output and accepts an empty answer', () => {
    expect(parseMemoryAnchorReview('不是 JSON', request)).toBeNull()
    expect(parseMemoryAnchorReview('{"issues":{}}', request)).toBeNull()
    expect(parseMemoryAnchorReview(raw([]), request)).toEqual([])
  })
})

describe('memoryAnchorFindings', () => {
  it('merges multiple missing memories in one chapter into one keyed finding', () => {
    // issue #164 的教训：同章多条同 key 会让 ack 静默掉没修的那条。
    const findings = memoryAnchorFindings([
      { chapterNumber: 78, quote: 'a', missingAnchor: '甲', explanation: '' },
      { chapterNumber: 78, quote: 'b', missingAnchor: '乙', explanation: '' },
    ])
    expect(findings).toHaveLength(1)
    expect(findings[0]!.stableFactKey).toBe('prose:memory-anchor-missing:78')
    expect(findings[0]!.evidence).toContain('甲')
    expect(findings[0]!.evidence).toContain('2 处')
  })
})

/**
 * issue #175：「核对记忆回指」在 63% 的写作时点一次模型调用都不发，
 * 而界面回一句「模型没有找到这一类问题」——与「核过了、没毛病」无法区分。
 *
 * 三处一起修：
 * 1. **取句口径**不能只认记忆动词；第 80 章那两句（「昨晚在船舱口，他试打了几遍」
 *    「停船那晚，他从货舱取了个油布包」）都是「时间状语 + 事件」的回指，
 *    而 `MEMORY_VERB` 一个都不认 —— 它们恰好是最容易与前文对不上的写法。
 * 2. **被检查的章**不只上一章（`MEMORY_ANCHOR_TARGET_CHAPTERS`）。
 * 3. **没发请求**要能说出来，不能伪装成「没找到」。
 *
 * ⚠️ 「开箱那天」这类**将来**的句子难免混进来；那由模型判（提示词里写了），
 * 不写时间词表 —— 扩词表等于把「那天是过去还是将来」编进代码。
 */
describe('issue #175 修复的三处', () => {
  // ⚠️ issue #181 之后，**台词起手**的句子不再进池（人物在对话里讲往事是新信息，
  // 不是叙述者的记忆断言）。所以这里用叙述句来验「时间状语 + 事件」这一档。
  const CH80 = [
    '周叙盯着放平的绳圈。昨晚在船舱口，他试打了几遍，最后一道收不紧。',
    '那一晚他从货舱取了个油布包，包法跟他爸票夹里那件一样。',
  ].join('\n')

  it('picks sentences anchored by a past time phrase, not only by a memory verb', () => {
    const found = memoryCallbackSentences(80, CH80)
    // 两句都是这一类，且都**没有**记忆动词。
    expect(found).toHaveLength(2)
    expect(found.map(item => item.sentence).join('')).toContain('昨晚在船舱口')
    expect(found.map(item => item.sentence).join('')).toContain('那一晚他从货舱')
    expect(found.map(item => item.sentence).join('')).not.toContain('记得')
  })

  it('still ignores plain narration with no anchor at all', () => {
    expect(memoryCallbackSentences(80, '他把绳圈放平，抹了一把脸。')).toEqual([])
  })

  it('does not build a "future time" word list — the model decides that', () => {
    // 「开箱那天」会进来；那是**故意的**：过去/将来要看上下文，规则判不了。
    // 提示词里已经写明「指向将来的不要报」。
    // ⚠️ 用**叙述句**：台词起手的句子已被 #181 排除（那是另一件事，与将来无关）。
    const found = memoryCallbackSentences(80, '他翻到那一页，开箱那天，页角印，他记下来。')
    expect(found.length).toBeGreaterThan(0)
    const { system } = buildMemoryAnchorPrompt({ chapters: [{ chapterNumber: 80, content: CH80 }], earlierChapters: [{ chapterNumber: 79, content: '回船，坐在舱口。' }], language: 'zh-CN' })
    expect(system).toContain('其实指向**将来**')
    expect(system).toContain('不要报')
  })

  it('checks more than the immediately preceding chapter', () => {
    // 现场 81 个写作时点里只有 30×（37%）的上一章含回指句；取最近 3 章挡掉大半空转。
    expect(MEMORY_ANCHOR_TARGET_CHAPTERS).toBeGreaterThan(1)
  })
})

/**
 * issue #181：候选池里 56% 不是回指（23% 台词、22% 被切半句、3% 章节开场时间戳）。
 * 9 条候选里只有 2 条值得判 —— 模型只能在这个池子里挑，也就只能在这些句子上出结论。
 *
 * 三处一起收窄（都只做**位置/形态**判断，内容仍归模型）：
 */
describe('issue #181 候选池的三股噪声', () => {
  const CH80 = [
    '第九天上午，废水道船尾舱。',
    '周叙盯着放平的绳圈。昨晚在船舱口，他试打了几遍，最后一道收不紧。',
    '“停船那晚，”他忽然开口，嗓子哑，“他从货舱取了个油布包。包法——”绳头在指间转了个向，“跟你爸票夹里那件，一样。”',
    '“开箱那天，页角印。你作证。”',
  ].join('\n')

  it('drops this chapter’s own scene datum (not a back-reference)', () => {
    const found = memoryCallbackSentences(80, CH80)
    expect(found.map(item => item.sentence).join('')).not.toContain('第九天上午')
  })

  it('drops lines spoken in dialogue: a character narration is new information, not a memory assertion', () => {
    // 人物在台词里讲往事 ≠ 叙述者在回指（#167 那类「他记得 X 而 X 没发生」不长这样）。
    const found = memoryCallbackSentences(80, CH80)
    expect(found.some(item => /^[“「]/u.test(item.sentence))).toBe(false)
    // 「停船那晚…」整句是台词起手 → 不进池。
    expect(found.map(item => item.sentence).join('')).not.toContain('停船那晚')
  })

  it('keeps the genuine back-reference (the one #167/#175 care about)', () => {
    const found = memoryCallbackSentences(80, CH80)
    expect(found.map(item => item.sentence).join('')).toContain('昨晚在船舱口')
  })

  it('never feeds a half sentence: quotes must be balanced', () => {
    // 旧切句器按句号切，中文对白里句号在引号内部 → 台词被切断（82 章里 25/113 = 22%）。
    // 现在用 splitProseSentences，再加一道断言式过滤：残句一律不进池。
    for (const chapter of [[80, CH80], [2, '“这褂子，”他说，“我上船那年你就穿着。']] as const) {
      for (const item of memoryCallbackSentences(chapter[0], chapter[1])) {
        const opens = (item.sentence.match(/[“「『"]/gu) ?? []).length
        const closes = (item.sentence.match(/[”」』"]/gu) ?? []).length
        expect(opens, item.sentence).toBe(closes)
      }
    }
  })

  it('keeps a complete quoted sentence with a narrative tail if it starts as narration', () => {
    // 反面对照：句子**以叙述开头、内含一句完整台词**时仍应入选（不是台词起手）。
    const found = memoryCallbackSentences(82, '他记得那晚有人敲门，说的是“船开了”。')
    expect(found.map(item => item.sentence).join('')).toContain('他记得那晚')
  })
})

/**
 * issue #184：校验闸只比「引文能在整章正文里逐字找到」，于是模型可以引**池外**的任意字面。
 *
 * 现场（写第 84 章那次）：候选池 2 句、模型报 1 条、**100% 来自池外**——
 * 引的是柯明远当众说的一句台词「铜墨盒昨夜已交稽核组封存。」，
 * 而它在 ch83 正文里当然能逐字找到。于是这条判据又绕回了 #181 想消灭的输入：
 * 标题写着「本章让人物回忆起…」，可那一句根本不是任何人的回忆。
 */
describe('引文必须来自候选池 (issue #184)', () => {
  const chapters = [
    { chapterNumber: 82, content: '他只记得他说了句要紧的。' },
    { chapterNumber: 83, content: '第十三日午前，封箱桌抬进公所正厅。“铜墨盒昨夜已交稽核组封存。”柯明远说。' },
  ]
  const request = { chapters, language: 'zh-CN' as const }

  const answer = (quote: string) => JSON.stringify({
    issues: [{ chapterNumber: 83, quote, missingAnchor: '铜墨盒被交稽核组封存', explanation: 'x' }],
  })

  it('accepts a quote that really is one of the candidate sentences', () => {
    // ch83 的候选句是那句叙述（本章时间戳已被 #181 排除前的形态），引它的前半也行。
    const parsed = parseMemoryAnchorReview(answer('第十三日午前，封箱桌抬进公所正厅。'), request)
    expect(parsed).toHaveLength(1)
  })

  it('rejects a quote from the chapter body that is NOT in the candidate pool (the reported case)', () => {
    // 这句台词在 ch83 正文里逐字存在 —— 旧闸会放行；新闸必须拒。
    expect(parseMemoryAnchorReview(answer('“铜墨盒昨夜已交稽核组封存。'), request)).toEqual([])
  })

  it('rejects any out-of-pool fragment even when it locates in the prose', () => {
    // ⚠️ 注意：候选句的**子串**是允许的（模型可以只引半句），所以这里只列真正的池外字面。
    for (const quote of ['柯明远说', '铜墨盒昨夜已交稽核组封存。']) {
      expect(parseMemoryAnchorReview(answer(quote), request), quote).toEqual([])
    }
  })

  it('still rejects a quote that is not in the chapter at all', () => {
    expect(parseMemoryAnchorReview(answer('这一句根本不存在。'), request)).toEqual([])
  })

  it('keeps the pool check per chapter (a quote from another chapter does not pass)', () => {
    const wrongChapter = JSON.stringify({
      issues: [{ chapterNumber: 82, quote: '第十三日午前，封箱桌抬进公所正厅。', missingAnchor: 'x', explanation: 'y' }],
    })
    expect(parseMemoryAnchorReview(wrongChapter, request)).toEqual([])
  })
})
