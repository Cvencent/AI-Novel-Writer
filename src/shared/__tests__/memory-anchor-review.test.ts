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
  const CH80 = [
    '周叙盯着放平的绳圈。昨晚在船舱口，他试打了几遍，最后一道收不紧。',
    '“停船那晚，”他忽然开口，嗓子哑，“他从货舱取了个油布包。”',
  ].join('\n')

  it('picks sentences anchored by a past time phrase, not only by a memory verb', () => {
    const found = memoryCallbackSentences(80, CH80)
    // 两句都是这一类，且都**没有**记忆动词。
    expect(found).toHaveLength(2)
    expect(found.map(item => item.sentence).join('')).toContain('昨晚在船舱口')
    expect(found.map(item => item.sentence).join('')).toContain('停船那晚')
    expect(found.map(item => item.sentence).join('')).not.toContain('记得')
  })

  it('still ignores plain narration with no anchor at all', () => {
    expect(memoryCallbackSentences(80, '他把绳圈放平，抹了一把脸。')).toEqual([])
  })

  it('does not build a "future time" word list — the model decides that', () => {
    // 「开箱那天」会进来；那是**故意的**：过去/将来要看上下文，规则判不了。
    // 提示词里已经写明「指向将来的不要报」。
    const found = memoryCallbackSentences(80, '“开箱那天，页角印。”他记下来。')
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
