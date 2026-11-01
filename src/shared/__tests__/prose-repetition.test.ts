import { describe, expect, it } from 'vitest'

import { findProseRepetition, proseRepetitionEvidence, STAGING_PHRASES, STILLNESS_PHRASES } from '../prose-repetition'

// issue #32（场景装置固定复用）/ #33（人物反应固定短句）：同一套写法在相邻章反复。
// 判据用**跨章分布**而不是出现次数——本样本「没动」14 章里 9 次、每章恰好一次。
const ch = (chapterNumber: number, content: string) => ({ chapterNumber, content })

describe('findProseRepetition: 正样本（issue #33 的逐章引文）', () => {
  const chapters = [
    ch(1, '“怎么了？”周叙没答。'),
    ch(2, '“这铺谁开的？”周叙没动。'),
    ch(3, '他翻过那一页，什么也没补上。'),
    ch(4, '“下一班客源还想不想要？”周叙没动。'),
    ch(5, '他在舷边站了很久。'),
    ch(6, '灯花爆了一下。'),
    ch(7, '他站着没动，把这句话嚼了一遍。“你当年的搭档，是不是他？”他没答。'),
    ch(8, '他盯着“周叙”两个字没动。“谁补的？”温珩没答，退下梯子。'),
    ch(9, '周叙没动。'),
    ch(10, '周叙站着没动。“哪个？”林棠没答。'),
    ch(11, '他一动没动。没伸手。'),
    ch(12, '周叙没动。'),
    ch(13, '“你把存根藏哪儿了？”周叙没答。'),
    ch(14, '他没动那页。'),
  ]

  it('「没动/没答」族覆盖 9 章以上 → 报出 stillness', () => {
    const hits = findProseRepetition(chapters)
    const stillness = hits.find(hit => hit.kind === 'stillness')
    expect(stillness).toBeTruthy()
    expect(stillness!.chapters.length).toBeGreaterThanOrEqual(9)
    // 证据串要能指向具体短语与章号，作者可核对
    const evidence = proseRepetitionEvidence(stillness!)
    expect(evidence).toContain('没动')
    expect(evidence).toMatch(/\d+ 章/)
  })

  it('溯读装置的起手动作覆盖多数章 → 报出 staging（issue #32）', () => {
    const stagingSamples = [
      ch(1, '他钻进舱底，拧开水隔半圈。'),
      ch(2, '周叙下舱底，拧开水隔。'),
      ch(3, '这一章他去了码头。'),
      ch(4, '回到船上，他钻进舱底，拧开水隔半圈。'),
      ch(5, '回到船上，周叙钻进舱底，拧开水隔。'),
      ch(6, '他在售票口核对名册。'),
      ch(7, '周叙下到舱底，蘸了舷壁的凝水。'),
      ch(8, '他拧开水隔，舱板缝里渗细珠。'),
      ch(9, '周叙起身下舱底，推开铁门，拧开水隔。'),
      ch(10, '他去酒棚打听消息。'),
    ]
    const hits = findProseRepetition(stagingSamples)
    const staging = hits.find(hit => hit.kind === 'staging')
    expect(staging).toBeTruthy()
    expect(staging!.chapters.length).toBeGreaterThanOrEqual(6)
  })
})

describe('findProseRepetition: 反面样本（不得误报）', () => {
  it('各章用词不同 → 零命中', () => {
    const chapters = Array.from({ length: 9 }, (_, index) => ch(index + 1,
      `第${index + 1}章：他${['抬头看天', '低头数钱', '把信折好', '把灯挑亮', '退了半步', '摸出烟杆', '擦了擦手', '把门关上', '把名字划掉'][index]}。`))
    expect(findProseRepetition(chapters)).toEqual([])
  })

  it('样本章数不足下限（< 8）时不判，避免小样本误报', () => {
    const chapters = Array.from({ length: 5 }, (_, index) => ch(index + 1, '周叙没动。'))
    expect(findProseRepetition(chapters)).toEqual([])
  })

  it('同一章内反复出现不算跨章固定写法（伏笔/复现是正常写法）', () => {
    const chapters = [
      ch(1, '周叙没动。周叙没动。周叙没动。'),
      ...Array.from({ length: 8 }, (_, index) => ch(index + 2, '这一章他平常地做了别的动作。')),
    ]
    expect(findProseRepetition(chapters)).toEqual([])
  })

  it('空正文与非法章号被忽略，不参与比例计算', () => {
    const chapters = [...Array.from({ length: 9 }, (_, index) => ch(index + 1, `第${index + 1}章各不相同：他${index}次抬头。`)),
      ch(99, ''), { chapterNumber: Number.NaN, content: '周叙没动。' }]
    expect(findProseRepetition(chapters)).toEqual([])
  })

  it('阈值可调：提高比例后同一正样本不再触发（说明阈值确实在起作用）', () => {
    const chapters = [
      ch(1, '周叙没动。'), ch(2, '周叙没答。'), ch(3, '正文一。'), ch(4, '正文二。'),
      ch(5, '正文三。'), ch(6, '正文四。'), ch(7, '正文五。'), ch(8, '正文六。'), ch(9, '正文七。'), ch(10, '正文八。'),
    ]
    expect(findProseRepetition(chapters, { minChapters: 2, coverageRatio: 0.2 }).some(hit => hit.kind === 'stillness')).toBe(true)
    expect(findProseRepetition(chapters, { minChapters: 2, coverageRatio: 0.9 })).toEqual([])
  })
})

describe('词表来源可核对', () => {
  it('两族短语都取自 issue 的逐章证据，且非空', () => {
    expect(STILLNESS_PHRASES).toContain('没动')
    expect(STILLNESS_PHRASES).toContain('没答')
    expect(STAGING_PHRASES).toContain('拧开水隔')
    expect(STAGING_PHRASES).toContain('蘸了舷壁')
  })
})