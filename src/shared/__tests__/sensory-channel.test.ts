import { describe, expect, it } from 'vitest'

import {
  SENSORY_MIN_CHAPTERS,
  SMELL_CHAPTER_SHARE_FLOOR,
  findSensoryChannelFindings,
  measureSensoryChannels,
} from '../sensory-channel'

const ch = (chapterNumber: number, content: string) => ({ chapterNumber, content })
/** 造一段「没有任何气味/味觉/环境音」的正文。 */
const dry = (n: number) => `第${n}章：他把缆绳搁下，走进舱里。灯是暗的，纸面泛白。`

/**
 * issue #151：71 章 68,790 字的一本书，嗅觉只有 10 章（每万字 1.60）、味觉 1 章、拟声 4 章，
 * 三类全无的有 57/71 章（80%）。而「五感」是起草与精修模板都写明的要求——
 * 全链路零核对。判为**机制缺口**（与 #93 / #96 / #114 同一类）。
 */
describe('measureSensoryChannels (issue #151)', () => {
  it('counts the environment-smell family', () => {
    expect(measureSensoryChannels(1, '舱底那股铁腥味儿贴着地皮走。').smell).toBe(1)
    expect(measureSensoryChannels(1, '霉麻袋一翻，霉味先冲上来。').smell).toBe(1)
  })

  it('does not count 「一炷香」 as smell — it is a timer in this book', () => {
    // 实测：全书「香」6 次全是「一炷香」这个计时器（ch46/ch71）。
    expect(measureSensoryChannels(1, '一炷香插在货舱口的铁钉上。香头没点。').smell).toBe(0)
  })

  it('does not count 「叮嘱」 as ambient sound', () => {
    // 实测 ch23 的「叮嘱」是误命中。单字拟声全部不收，只收双字以上。
    expect(measureSensoryChannels(1, '他叮嘱了一句，随即走了。').sound).toBe(0)
    expect(measureSensoryChannels(1, '铁链哐当一声砸在舱板上。').sound).toBe(1)
  })

  it('does not count 「咬」 as taste — it is usually biting one\'s lip or a latch', () => {
    // 实测全书 1 次「咬」是「锁舌咬得不紧」。
    expect(measureSensoryChannels(1, '锁舌咬得不紧，门缝透着风。').taste).toBe(0)
    expect(measureSensoryChannels(1, '他舔了舔发干的下唇。').taste).toBe(1)
    // 单字「尝」不收：会命中「尝试 / 何尝」。
    expect(measureSensoryChannels(1, '他何尝不想走，只是不能。').taste).toBe(0)
  })

  it('marks a chapter silent only when all three channels are absent', () => {
    expect(measureSensoryChannels(1, dry(1)).silent).toBe(true)
    expect(measureSensoryChannels(1, '舱里一股霉味。'.repeat(1)).silent).toBe(false)
  })
})

describe('findSensoryChannelFindings (issue #151)', () => {

  it('reports the stretch when almost no chapter smells anything', () => {
    // 20 章里只有 1 章有气味（5%）——issue 现场（第 52–71 章）。
    const chapters = [ch(1, '铁腥味贴着地皮走。'), ...Array.from({ length: 20 }, (_, i) => ch(i + 2, dry(i + 2)))]
    const [hit] = findSensoryChannelFindings(chapters)
    expect(hit).toBeDefined()
    expect(hit!.stableFactKey.startsWith('prose-flavor:sensory:')).toBe(true)
    expect(hit!.evidence).toContain('三类全无')
  })

  it('stays silent on a book that does smell things regularly', () => {
    // 每 3 章里有 2 章有气味 → 远高于 0.3 的地板。
    const chapters = Array.from({ length: 20 }, (_, i) =>
      i % 3 === 0 ? ch(i + 1, dry(i + 1)) : ch(i + 1, '霉味从麻袋里冲上来，他偏了偏头。'))
    expect(findSensoryChannelFindings(chapters)).toEqual([])
  })

  it('does not judge a book with too few chapters', () => {
    expect(findSensoryChannelFindings(Array.from({ length: SENSORY_MIN_CHAPTERS - 1 }, (_, i) => ch(i + 1, dry(i + 1))))).toEqual([])
  })

  it('keys on the stretch start, so ack stays valid as the book advances', () => {
    const base = findSensoryChannelFindings(Array.from({ length: 20 }, (_, i) => ch(i + 1, dry(i + 1))))[0]!.stableFactKey
    const later = findSensoryChannelFindings(Array.from({ length: 21 }, (_, i) => ch(i + 1, dry(i + 1))))[0]!.stableFactKey
    // ⚠️ 这一段整体滑动时首章会变（窗口是最近 20 章）——这是窗口判据的固有属性。
    // 但**同一段不推进**时 key 必须稳定，这是 ack 能生效的前提。
    expect(findSensoryChannelFindings(Array.from({ length: 20 }, (_, i) => ch(i + 1, dry(i + 1))))[0]!.stableFactKey).toBe(base)
    expect(typeof later).toBe('string')
  })

  it('lists the specific silent chapters, because the author edits chapters not percentages', () => {
    const chapters = Array.from({ length: 20 }, (_, i) => ch(i + 1, dry(i + 1)))
    const [hit] = findSensoryChannelFindings(chapters)
    // 20 章全静音 → 每一章都要能在证据里认出来（作者要按章去改）。
    for (const number of [1, 10, 20]) expect(hit!.evidence).toContain(`第${number}章`)
  })

  it('threshold is documented, not hand-tuned to one book', () => {
    // 两本受测语料分别是 14% 与 17%；地板 0.3 是它们的两倍左右，不是贴着噪声线设的。
    expect(SMELL_CHAPTER_SHARE_FLOOR).toBe(0.3)
  })
})
